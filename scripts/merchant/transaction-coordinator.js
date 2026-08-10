/**
 * Infinity D&D5e - authoritative Merchant transaction coordinator
 *
 * This is the only orchestration layer for the durable Merchant ledger. It
 * owns no UI or socket delivery: callers look up a tuple before validating a
 * live session, persist a prepared plan, then drive or replay that plan.
 */

import {
  PRIVATE_STATE_CHANGED_HOOK,
  getPrivateState,
  isPrivilegedPrivateStateReady,
  onPrivateStateChanged,
} from "../private-state.js";
import { authoritativeGMId, isAuthoritativeGM } from "../socket-authority.js";
import {
  applyDurableMerchantActorPlan,
  readMerchantActorBoundary,
} from "./transaction.js";
import {
  addMerchantTransactionRecord,
  classifyMerchantTransactionReconciliation,
  classifyMerchantTransactionReviewRecovery,
  compactMerchantTransactionLedger,
  lookupMerchantTransactionReplay,
  normalizeMerchantTransactionLedger,
  normalizeMerchantTransactionRecord,
  recoverMerchantTransactionFromReview,
  replaceMerchantTransactionRecord,
  replaceRecoveredMerchantTransactionRecord,
  transitionMerchantTransaction,
} from "./transaction-ledger.js";
import { runWithMerchantActorMutex } from "./session-state.js";
import { updateMerchantPrivateState } from "./store.js";
import {
  ensureMerchantTabLeadership,
  hasMerchantTabLeadership,
  MERCHANT_TAB_LEADERSHIP_HOOK,
} from "./tab-leadership.js";

const MODULE_ID = "infinity-dnd5e";
const MAX_DRIVE_STEPS = 16;
const AUTHORITY_HOOKS = Object.freeze([
  "ready",
  "updateUser",
  "userConnected",
  "deleteUser",
  MERCHANT_TAB_LEADERSHIP_HOOK,
]);

export class MerchantTransactionCoordinatorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MerchantTransactionCoordinatorError";
    this.code = code;
  }
}

/**
 * Construct an isolated coordinator. Every live dependency is replaceable so
 * crash/authority tests never need a Foundry Journal or socket.
 */
export function createMerchantTransactionCoordinator(overrides = {}) {
  const bindings = { ...PRODUCTION_BINDINGS, ...overrides };
  assertBindings(bindings);

  const authority = {
    id: null,
    epoch: null,
    generation: 0,
    barrier: "unclaimed", // unclaimed | claimed | lost
  };
  let registered = false;
  let localWriteDepth = 0;
  let reconcilePromise = null;
  let scheduledPromise = null;
  let removePrivateSubscription = null;
  let removeAuthoritySubscription = null;

  function readSnapshot() {
    if (bindings.isPrivateReady() !== true) {
      return {
        ok: false,
        status: "unavailable",
        reason: "private-state-not-ready",
      };
    }
    const merchants = bindings.getPrivateState("merchants");
    const rawLedger = bindings.getPrivateState("merchantTransactions");
    if (!Array.isArray(merchants) || rawLedger == null) {
      return {
        ok: false,
        status: "unavailable",
        reason: "private-state-not-ready",
      };
    }
    try {
      return {
        ok: true,
        merchants: cloneValue(merchants),
        ledger: normalizeMerchantTransactionLedger(rawLedger),
      };
    } catch (error) {
      return {
        ok: false,
        status: "needs-review",
        reason: "malformed-ledger",
        errorCode: error?.code ?? "MERCHANT_LEDGER_MALFORMED",
      };
    }
  }

  function observeAuthority() {
    const id = cleanId(bindings.authoritativeGMId());
    const currentUserId = cleanId(bindings.currentUserId());
    if (
      bindings.isAuthoritativeGM() !== true ||
      bindings.hasTabLeadership() !== true ||
      !id ||
      !currentUserId ||
      id !== currentUserId ||
      bindings.isPrivateReady() !== true
    ) {
      return null;
    }
    return id;
  }

  function ensureLocalAuthority() {
    const id = observeAuthority();
    if (!id) return null;
    if (authority.id !== id || !authority.epoch) {
      authority.id = id;
      authority.epoch = bindings.createAuthorityEpoch(id);
      authority.generation += 1;
      authority.barrier = "unclaimed";
    }
    return captureLocalAuthority();
  }

  function captureLocalAuthority() {
    if (!authority.id || !authority.epoch) return null;
    return Object.freeze({
      id: authority.id,
      epoch: authority.epoch,
      generation: authority.generation,
    });
  }

  function resetAuthority() {
    authority.id = null;
    authority.epoch = null;
    authority.generation += 1;
    authority.barrier = "unclaimed";
  }

  function authorityContextCurrent(context) {
    return Boolean(
      context &&
      observeAuthority() === context.id &&
      authority.id === context.id &&
      authority.epoch === context.epoch &&
      authority.generation === context.generation,
    );
  }

  function ledgerOwnedByContext(ledger, context) {
    return Boolean(
      ledger &&
      context &&
      ledger.authorityId === context.id &&
      ledger.authorityEpoch === context.epoch &&
      typeof ledger.writeToken === "string" &&
      ledger.writeToken.length > 0,
    );
  }

  function ledgerIdentity(ledger) {
    return Object.freeze({
      revision: ledger.revision,
      authorityId: ledger.authorityId,
      authorityEpoch: ledger.authorityEpoch,
      writeToken: ledger.writeToken,
    });
  }

  function identitiesEqual(left, right) {
    return Boolean(
      left &&
      right &&
      left.revision === right.revision &&
      left.authorityId === right.authorityId &&
      left.authorityEpoch === right.authorityEpoch &&
      left.writeToken === right.writeToken,
    );
  }

  function captureWriteFence(baseLedger, baseMerchants, context) {
    return {
      context,
      base: ledgerIdentity(baseLedger),
      baseMerchants: cloneValue(baseMerchants),
      next: null,
      nextMerchants: null,
      extraGuard: null,
    };
  }

  function writeFenceCurrent(fence) {
    if (!fence || !authorityContextCurrent(fence.context)) return false;
    const snapshot = readSnapshot();
    if (!snapshot.ok) return false;
    const observed = ledgerIdentity(snapshot.ledger);
    const stateMatches =
      (identitiesEqual(observed, fence.base) &&
        jsonValuesEqual(snapshot.merchants, fence.baseMerchants)) ||
      (fence.next &&
        identitiesEqual(observed, fence.next) &&
        jsonValuesEqual(snapshot.merchants, fence.nextMerchants));
    if (!stateMatches) return false;
    if (typeof fence.extraGuard !== "function") return true;
    try {
      return fence.extraGuard() === true;
    } catch {
      return false;
    }
  }

  function stampLedger(ledger, baseLedger, context) {
    if (baseLedger.revision >= Number.MAX_SAFE_INTEGER) {
      throw new MerchantTransactionCoordinatorError(
        "MERCHANT_LEDGER_REVISION_OVERFLOW",
        "Merchant transaction revision exhausted",
      );
    }
    return normalizeMerchantTransactionLedger({
      ...ledger,
      revision: baseLedger.revision + 1,
      authorityId: context.id,
      authorityEpoch: context.epoch,
      writeToken: bindings.createWriteToken(),
    });
  }

  async function performPrivateMutation(
    mutation,
    { allowUnclaimed = false } = {},
  ) {
    const context = ensureLocalAuthority();
    if (!context) return authorityLost("not-authoritative");
    if (!allowUnclaimed && authority.barrier !== "claimed") {
      return authorityLost("authority-barrier-not-held");
    }
    let fence = null;
    let outcome = null;
    let expectedLedger = null;
    let expectedMerchants = null;
    localWriteDepth += 1;
    try {
      const persisted = await bindings.updateMerchantPrivateState(
        async (raw) => {
          const current = normalizeMutationState(raw);
          if (!authorityContextCurrent(context)) {
            throw authorityFenceError();
          }
          if (
            !allowUnclaimed &&
            !ledgerOwnedByContext(current.ledger, context)
          ) {
            throw authorityFenceError();
          }
          fence = captureWriteFence(current.ledger, current.merchants, context);
          if (!writeFenceCurrent(fence)) throw authorityFenceError();
          const proposal = await mutation(current);
          if (proposal == null) return null;
          if (
            !proposal ||
            !Array.isArray(proposal.merchants) ||
            !proposal.ledger
          ) {
            throw new MerchantTransactionCoordinatorError(
              "MERCHANT_COORDINATOR_PROPOSAL_INVALID",
              "Coordinator mutation returned an invalid proposal",
            );
          }
          expectedLedger = stampLedger(
            normalizeMerchantTransactionLedger(proposal.ledger),
            current.ledger,
            context,
          );
          fence.next = ledgerIdentity(expectedLedger);
          expectedMerchants = cloneValue(proposal.merchants);
          fence.nextMerchants = expectedMerchants;
          fence.extraGuard =
            typeof proposal.authorizeWrite === "function"
              ? proposal.authorizeWrite
              : null;
          outcome = proposal.outcome ?? null;
          return {
            merchants: cloneValue(proposal.merchants),
            merchantTransactions: expectedLedger,
            result: outcome,
          };
        },
        { authorizeWrite: () => writeFenceCurrent(fence) },
      );
      if (persisted == null) {
        return { status: "unchanged", written: false, outcome };
      }
      const after = readSnapshot();
      if (
        !after.ok ||
        !expectedLedger ||
        !expectedMerchants ||
        !identitiesEqual(
          ledgerIdentity(after.ledger),
          ledgerIdentity(expectedLedger),
        ) ||
        !jsonValuesEqual(after.merchants, expectedMerchants) ||
        !authorityContextCurrent(context)
      ) {
        authority.barrier = "lost";
        return authorityLost("write-readback-fence-lost");
      }
      return {
        status: "written",
        written: true,
        outcome,
        merchants: after.merchants,
        ledger: after.ledger,
      };
    } catch (error) {
      if (error?.code === "MERCHANT_COORDINATOR_OUTCOME_ONLY") {
        return {
          status: "unchanged",
          written: false,
          outcome: error.outcome ?? null,
        };
      }
      if (!authorityContextCurrent(context) || isAuthorityFenceError(error)) {
        authority.barrier = "lost";
        return authorityLost("authority-lost", error);
      }
      return {
        status: "error",
        reason: "private-write-failed",
        error,
      };
    } finally {
      localWriteDepth -= 1;
    }
  }

  async function ensureBarrier() {
    if ((await bindings.ensureTabLeadership()) !== true) {
      return authorityLost("tab-leadership-unavailable");
    }
    const context = ensureLocalAuthority();
    if (!context) return authorityLost("not-authoritative");
    const snapshot = readSnapshot();
    if (!snapshot.ok) return snapshot;
    if (authority.barrier === "claimed") {
      if (ledgerOwnedByContext(snapshot.ledger, context)) {
        return { status: "ready", authorityId: context.id };
      }
      authority.barrier = "lost";
      return authorityLost("authority-barrier-lost");
    }
    if (authority.barrier === "lost") {
      return authorityLost("authority-barrier-lost");
    }

    const claimed = await performPrivateMutation(
      (current) => ({
        merchants: current.merchants,
        ledger: current.ledger,
        outcome: { status: "ready" },
      }),
      { allowUnclaimed: true },
    );
    if (claimed.status !== "written") return claimed;
    const after = readSnapshot();
    if (!after.ok || !ledgerOwnedByContext(after.ledger, context)) {
      authority.barrier = "lost";
      return authorityLost("authority-barrier-readback-failed");
    }
    authority.barrier = "claimed";
    return { status: "ready", authorityId: context.id };
  }

  function lookup(identity) {
    const parsed = normalizeIdentity(identity);
    if (!parsed.ok) return parsed;
    const snapshot = readSnapshot();
    if (!snapshot.ok) return snapshot;
    try {
      return lookupMerchantTransactionReplay(snapshot.ledger, parsed);
    } catch (error) {
      return {
        status: "needs-review",
        reason: "invalid-transaction-identity",
        errorCode: error?.code ?? null,
      };
    }
  }

  function parsePreparedRecord(input) {
    let record;
    try {
      record = normalizeMerchantTransactionRecord(input?.record ?? input);
    } catch (error) {
      return {
        ok: false,
        result: {
          status: "needs-review",
          reason: "invalid-transaction-plan",
          errorCode: error?.code ?? null,
        },
      };
    }
    if (record.stage !== "prepared") {
      return {
        ok: false,
        result: { status: "needs-review", reason: "record-not-prepared" },
      };
    }
    return { ok: true, record };
  }

  async function persistPrepared(input) {
    const parsed = parsePreparedRecord(input);
    if (!parsed.ok) return parsed.result;
    const { record } = parsed;

    const durable = lookup(record);
    if (durable.status !== "missing") {
      return enrichReplay(durable, readSnapshot());
    }
    const barrier = await ensureBarrier();
    if (barrier.status !== "ready") return barrier;

    return bindings.runWithMerchantActorMutex(
      record.merchant.merchantId,
      record.actor.actorId,
      () => persistPreparedRecordLocked(record, { barrierReady: true }),
    );
  }

  /** Persist a fresh plan while the caller already owns merchant->actor lock. */
  async function persistPreparedLocked(input) {
    const parsed = parsePreparedRecord(input);
    if (!parsed.ok) return parsed.result;
    const durable = lookup(parsed.record);
    if (durable.status !== "missing") {
      return enrichReplay(durable, readSnapshot());
    }
    const barrier = await ensureBarrier();
    if (barrier.status !== "ready") return barrier;
    return persistPreparedRecordLocked(parsed.record, { barrierReady: true });
  }

  /**
   * Persist a fresh plan and perform its first drive while the caller keeps the
   * merchant->actor lock. Canonical replays win without rewriting the plan.
   */
  async function persistPreparedAndDriveLocked(input) {
    const parsed = parsePreparedRecord(input);
    if (!parsed.ok) return parsed.result;
    const { record } = parsed;
    let durable = lookup(record);
    let barrierReady = false;

    if (durable.status === "missing") {
      const barrier = await ensureBarrier();
      if (barrier.status !== "ready") return barrier;
      barrierReady = true;
      const prepared = await persistPreparedRecordLocked(record, {
        barrierReady: true,
      });
      if (prepared.status !== "prepared" && prepared.status !== "pending") {
        return prepared;
      }
      durable = lookup(record);
      if (durable.status === "missing") return prepared;
    }

    if (durable.status !== "pending") {
      return enrichReplay(durable, readSnapshot());
    }
    if (!barrierReady) {
      const barrier = await ensureBarrier();
      if (barrier.status !== "ready") return barrier;
    }
    return driveLocked(record);
  }

  /** Build and persist one plan inside the coordinator-owned lock. */
  async function persistPreparedWithLock({ merchantId, actorId, buildRecord }) {
    if (typeof buildRecord !== "function") {
      return { status: "needs-review", reason: "plan-builder-required" };
    }
    const barrier = await ensureBarrier();
    if (barrier.status !== "ready") return barrier;
    return bindings.runWithMerchantActorMutex(merchantId, actorId, async () => {
      const built = await buildRecord();
      if (built?.ok === false && !built?.record) {
        return {
          status: "rejected",
          reason: built.reason ?? "transaction-plan-rejected",
          planningResult: built,
        };
      }
      const parsed = parsePreparedRecord(built?.record ?? built);
      if (!parsed.ok) return parsed.result;
      if (
        parsed.record.merchant.merchantId !== merchantId ||
        parsed.record.actor.actorId !== actorId
      ) {
        return {
          status: "needs-review",
          reason: "plan-lock-identity-mismatch",
        };
      }
      return persistPreparedRecordLocked(parsed.record, { barrierReady: true });
    });
  }

  async function persistPreparedRecordLocked(
    record,
    { barrierReady = false } = {},
  ) {
    if (!barrierReady) {
      const barrier = await ensureBarrier();
      if (barrier.status !== "ready") return barrier;
    }
    const write = await performPrivateMutation(async (current) => {
      let availableLedger;
      try {
        availableLedger = compactMerchantTransactionLedger(current.ledger, {
          terminalCap: bindings.terminalCap,
          maxRecords: bindings.maxRecords - 1,
        });
      } catch (error) {
        if (error?.code === "MERCHANT_LEDGER_CAPACITY") {
          outcomeOnly({
            status: "blocked",
            reason: "ledger-capacity",
            limit: bindings.maxRecords,
          });
        }
        throw error;
      }
      const replay = lookupMerchantTransactionReplay(availableLedger, record);
      if (replay.status !== "missing") {
        outcomeOnly({ ...replay, writeSkipped: true });
      }
      const originUnresolved = availableLedger.records.filter(
        (candidate) =>
          candidate.stage !== "terminal" &&
          candidate.originUserId === record.originUserId,
      ).length;
      if (originUnresolved >= bindings.maxUnresolvedPerOrigin) {
        outcomeOnly({
          status: "blocked",
          reason: "unresolved-origin-cap",
          limit: bindings.maxUnresolvedPerOrigin,
        });
      }
      const collision = findUnresolvedCollision(availableLedger, record);
      if (collision) {
        outcomeOnly({
          status: "blocked",
          reason: "unresolved-transaction-collision",
          blockingKey: collision.key,
        });
      }
      const merchant = findMerchantSnapshot(
        current.merchants,
        record.merchant.merchantId,
      );
      if (!merchant || !jsonValuesEqual(merchant, record.merchant.before)) {
        outcomeOnly({
          status: "needs-review",
          reason: "merchant-before-mismatch",
        });
      }
      const freshActor = bindings.resolveActor(record.actor.actorId);
      const freshActorRead = bindings.readActorBoundary(
        freshActor,
        record.actor.itemId,
      );
      if (
        !freshActorRead?.ok ||
        !jsonValuesEqual(freshActorRead.boundary, record.actor.before)
      ) {
        outcomeOnly({
          status: "needs-review",
          reason: freshActorRead?.reason ?? "actor-before-mismatch",
        });
      }
      const ledger = addMerchantTransactionRecord(availableLedger, record);
      return {
        merchants: current.merchants,
        ledger,
        outcome: { status: "prepared", record },
        authorizeWrite: () =>
          actorBoundaryMatches(bindings, record.actor, record.actor.before),
      };
    });
    if (write.status === "error" || write.status === "authority-lost") {
      return write;
    }
    return write.outcome ?? { status: "prepared", record };
  }

  async function submit(input) {
    const prepared = await persistPrepared(input);
    if (prepared.status !== "prepared" && prepared.status !== "pending") {
      return prepared;
    }
    const record = prepared.record ?? input?.record ?? input;
    return drive(record);
  }

  async function drive(identity) {
    const parsed = normalizeIdentity(identity?.record ?? identity);
    if (!parsed.ok) return parsed;
    let durable = lookup(parsed);
    if (durable.status !== "pending") {
      return enrichReplay(durable, readSnapshot());
    }
    const record = durable.record;
    const barrier = await ensureBarrier();
    if (barrier.status !== "ready") return barrier;
    return bindings.runWithMerchantActorMutex(
      record.merchant.merchantId,
      record.actor.actorId,
      () => driveLocked(parsed),
    );
  }

  /** Drive canonical pending work while the caller already owns its mutex. */
  async function drivePendingLocked(identity) {
    const parsed = normalizeIdentity(identity?.record ?? identity);
    if (!parsed.ok) return parsed;
    const durable = lookup(parsed);
    if (durable.status !== "pending") {
      return enrichReplay(durable, readSnapshot());
    }
    const barrier = await ensureBarrier();
    if (barrier.status !== "ready") return barrier;
    return driveLocked(parsed);
  }

  /**
   * Recheck one pinned transaction without relaxing the ordinary state machine.
   * The review checkpoint is reopened only after a fresh, lock-held canonical
   * read proves one of the dedicated safe recovery mappings.
   */
  async function recheck(identity) {
    const parsed = normalizeIdentity(identity?.record ?? identity);
    if (!parsed.ok) return parsed;
    const durable = lookup(parsed);
    if (durable.status !== "pending") {
      return enrichReplay(durable, readSnapshot());
    }
    if (durable.record.stage !== "needs-review") return drive(parsed);
    const barrier = await ensureBarrier();
    if (barrier.status !== "ready") return barrier;
    return bindings.runWithMerchantActorMutex(
      durable.record.merchant.merchantId,
      durable.record.actor.actorId,
      () => recheckLocked(parsed),
    );
  }

  async function recheckLocked(identity) {
    const snapshot = readSnapshot();
    if (!snapshot.ok) return snapshot;
    const context = captureLocalAuthority();
    if (
      authority.barrier !== "claimed" ||
      !authorityContextCurrent(context) ||
      !ledgerOwnedByContext(snapshot.ledger, context)
    ) {
      authority.barrier = "lost";
      return authorityLost("authority-barrier-lost");
    }
    const replay = lookupMerchantTransactionReplay(snapshot.ledger, identity);
    if (replay.status !== "pending") return enrichReplay(replay, snapshot);
    if (replay.record.stage !== "needs-review") return driveLocked(identity);

    const assessment = assessPinnedReview(bindings, snapshot, replay.record);
    if (assessment.action !== "recover") {
      return pinnedReviewOutcome(replay.record, assessment);
    }

    const persisted = await performPrivateMutation((current) => {
      const freshReplay = lookupMerchantTransactionReplay(
        current.ledger,
        identity,
      );
      if (freshReplay.status !== "pending") {
        outcomeOnly(enrichReplay(freshReplay, current));
      }
      const record = freshReplay.record;
      if (record.stage !== "needs-review") {
        outcomeOnly({ status: "retry", reason: "review-already-reopened" });
      }
      const fresh = assessPinnedReview(bindings, current, record);
      if (fresh.action !== "recover") {
        outcomeOnly(pinnedReviewOutcome(record, fresh));
      }
      if (!reviewAssessmentsEqual(fresh, assessment)) {
        outcomeOnly({
          ...pinnedReviewOutcome(record, fresh),
          reason: "review-state-changed-before-write",
        });
      }
      const recovered = recoverMerchantTransactionFromReview(record, fresh, {
        updatedAt: transitionTime(record),
      });
      return {
        merchants: current.merchants,
        ledger: replaceRecoveredMerchantTransactionRecord(
          current.ledger,
          recovered,
        ),
        outcome: {
          status: "review-recovered",
          record: recovered,
          assessment: fresh,
        },
        authorizeWrite: () =>
          reviewRecoveryStillProven(bindings, readSnapshot(), record, fresh),
      };
    });
    if (persisted.status === "written") return driveLocked(identity);
    if (
      persisted.status === "unchanged" &&
      persisted.outcome?.status === "retry"
    ) {
      return driveLocked(identity);
    }
    return persisted.status === "unchanged" && persisted.outcome
      ? persisted.outcome
      : persisted;
  }

  async function driveLocked(identity) {
    for (let step = 0; step < MAX_DRIVE_STEPS; step += 1) {
      const snapshot = readSnapshot();
      if (!snapshot.ok) return snapshot;
      const context = captureLocalAuthority();
      if (
        authority.barrier !== "claimed" ||
        !authorityContextCurrent(context) ||
        !ledgerOwnedByContext(snapshot.ledger, context)
      ) {
        authority.barrier = "lost";
        return authorityLost("authority-barrier-lost");
      }
      const replay = lookupMerchantTransactionReplay(snapshot.ledger, identity);
      if (replay.status !== "pending") {
        return enrichReplay(replay, snapshot);
      }
      const record = replay.record;
      const collision = findUnresolvedCollision(snapshot.ledger, record);
      if (collision) {
        return {
          status: "blocked",
          reason: "unresolved-transaction-collision",
          blockingKey: collision.key,
          record,
        };
      }
      const actor = bindings.resolveActor(record.actor.actorId);
      const actorRead = bindings.readActorBoundary(actor, record.actor.itemId);
      const merchant = findMerchantSnapshot(
        snapshot.merchants,
        record.merchant.merchantId,
      );
      const assessment = classifyMerchantTransactionReconciliation(record, {
        actor: actorRead?.ok ? actorRead.boundary : null,
        merchant,
      });
      if (assessment.action === "needs-review") {
        return persistNeedsReview(record, {
          reason: assessment.reason,
          actorState: assessment.actorState,
          merchantState: assessment.merchantState,
          assessment,
          merchant,
        });
      }
      if (assessment.action === "replay") {
        return {
          status: "terminal",
          record,
          result: assessment.result,
          merchant,
        };
      }
      if (assessment.action === "apply" && assessment.target === "actor") {
        const operationFence = captureOperationFence(
          snapshot.ledger,
          snapshot.merchants,
          context,
        );
        let applied;
        try {
          applied = await bindings.applyActorPlan(actor, record.actor, {
            authorizeWrite: () => operationFenceCurrent(operationFence),
          });
        } catch (error) {
          if (!operationFenceCurrent(operationFence)) {
            return authorityLost("authority-lost-during-actor-write", error);
          }
          const canonical = bindings.readActorBoundary(
            actor,
            record.actor.itemId,
          );
          if (
            canonical?.ok &&
            jsonValuesEqual(canonical.boundary, record.actor.after)
          ) {
            // The write applied and only its acknowledgement path failed. The
            // next loop records the Actor marker from canonical readback.
            continue;
          }
          return {
            status: "pending",
            reason: "actor-apply-interrupted",
            error,
            record,
          };
        }
        if (
          applied?.reason === "authority-lost" ||
          applied?.action === "reconcile" ||
          !operationFenceCurrent(operationFence)
        ) {
          return authorityLost("authority-lost-during-actor-write");
        }
        if (applied?.action === "needs-review") {
          return persistNeedsReview(record, {
            reason: applied.reason ?? "actor-apply-needs-review",
            actorState: actorStateFromComponentStates(
              applied.walletState,
              applied.itemState,
            ),
            merchantState: assessment.merchantState,
            actorResult: applied,
          });
        }
        if (applied?.action === "retry" && !(applied.writes?.length > 0)) {
          return {
            status: "pending",
            reason: applied.reason ?? "actor-apply-unconfirmed",
            record,
          };
        }
        continue;
      }

      const persisted = await persistAssessment(identity, assessment);
      if (persisted.status === "written") {
        if (persisted.outcome?.status === "terminal") {
          return persisted.outcome;
        }
        continue;
      }
      if (persisted.status === "unchanged" && persisted.outcome) {
        if (persisted.outcome.status === "retry") continue;
        return persisted.outcome;
      }
      return persisted;
    }
    return { status: "pending", reason: "drive-step-limit" };
  }

  async function persistAssessment(identity, expected) {
    return performPrivateMutation(async (current) => {
      const replay = lookupMerchantTransactionReplay(current.ledger, identity);
      if (replay.status !== "pending") {
        outcomeOnly(enrichReplay(replay, current));
      }
      const record = replay.record;
      const actor = bindings.resolveActor(record.actor.actorId);
      const actorRead = bindings.readActorBoundary(actor, record.actor.itemId);
      const merchant = findMerchantSnapshot(
        current.merchants,
        record.merchant.merchantId,
      );
      const fresh = classifyMerchantTransactionReconciliation(record, {
        actor: actorRead?.ok ? actorRead.boundary : null,
        merchant,
      });
      if (fresh.action === "needs-review") {
        if (record.stage === "needs-review") {
          outcomeOnly({
            status: "needs-review",
            reason: record.review.reason,
            record,
            assessment: fresh,
          });
        }
        const quarantined = transitionMerchantTransaction(
          record,
          "needs-review",
          {
            updatedAt: transitionTime(record),
            reason: fresh.reason,
            actorState: fresh.actorState ?? "third-state",
            merchantState: fresh.merchantState ?? "third-state",
          },
        );
        const ledger = replaceMerchantTransactionRecord(
          current.ledger,
          quarantined,
        );
        return {
          merchants: current.merchants,
          ledger,
          outcome: {
            status: "needs-review",
            reason: fresh.reason,
            record: quarantined,
            assessment: fresh,
          },
        };
      }
      if (
        fresh.action !== expected.action ||
        fresh.target !== expected.target ||
        fresh.nextStage !== expected.nextStage
      ) {
        outcomeOnly({
          status: "needs-review",
          reason:
            fresh.action === "needs-review"
              ? fresh.reason
              : "reconciliation-changed-before-write",
          assessment: fresh,
          record,
        });
      }

      let merchants = current.merchants;
      let nextRecord;
      if (fresh.action === "apply" && fresh.target === "merchant") {
        if (!merchant || !jsonValuesEqual(merchant, record.merchant.before)) {
          outcomeOnly({
            status: "needs-review",
            reason: "merchant-before-mismatch",
            record,
          });
        }
        merchants = replaceMerchantSnapshot(
          current.merchants,
          record.merchant.merchantId,
          record.merchant.after,
        );
        nextRecord = transitionMerchantTransaction(record, "merchant-applied", {
          updatedAt: transitionTime(record),
        });
      } else if (fresh.action === "advance") {
        nextRecord = transitionMerchantTransaction(record, fresh.nextStage, {
          updatedAt: transitionTime(record),
        });
      } else if (fresh.action === "finalize") {
        nextRecord = transitionMerchantTransaction(record, "terminal", {
          updatedAt: transitionTime(record),
        });
      } else {
        outcomeOnly({ status: "retry", reason: "assessment-not-persistable" });
      }

      let ledger = replaceMerchantTransactionRecord(current.ledger, nextRecord);
      let outcome = { status: "advanced", record: nextRecord };
      if (nextRecord.stage === "terminal") {
        const result = cloneValue(nextRecord.result);
        ledger = compactMerchantTransactionLedger(ledger, {
          terminalCap: bindings.terminalCap,
          maxRecords: bindings.maxRecords,
        });
        outcome = {
          status: "terminal",
          record: nextRecord,
          result,
          merchant: findMerchantSnapshot(merchants, record.merchant.merchantId),
        };
      }
      return {
        merchants,
        ledger,
        outcome,
        authorizeWrite: () =>
          actorBoundaryMatches(bindings, record.actor, record.actor.after),
      };
    });
  }

  async function persistNeedsReview(identity, details = {}) {
    const parsed = normalizeIdentity(identity);
    if (!parsed.ok) return parsed;
    const written = await performPrivateMutation((current) => {
      const replay = lookupMerchantTransactionReplay(current.ledger, parsed);
      if (replay.status !== "pending") {
        outcomeOnly(enrichReplay(replay, current));
      }
      const record = replay.record;
      if (record.stage === "needs-review") {
        outcomeOnly({
          status: "needs-review",
          reason: record.review.reason,
          record,
          pinned: true,
        });
      }
      const quarantined = transitionMerchantTransaction(
        record,
        "needs-review",
        {
          updatedAt: transitionTime(record),
          reason: details.reason ?? "canonical-state-mismatch",
          actorState: details.actorState ?? "third-state",
          merchantState: details.merchantState ?? "third-state",
        },
      );
      const ledger = replaceMerchantTransactionRecord(
        current.ledger,
        quarantined,
      );
      return {
        merchants: current.merchants,
        ledger,
        outcome: {
          status: "needs-review",
          reason: quarantined.review.reason,
          record: quarantined,
          pinned: true,
          ...(details.assessment ? { assessment: details.assessment } : {}),
          ...(details.actorResult ? { actorResult: details.actorResult } : {}),
          ...(details.merchant !== undefined
            ? { merchant: details.merchant }
            : {}),
        },
      };
    });
    if (written.status === "written" || written.status === "unchanged") {
      return written.outcome;
    }
    return written;
  }

  function captureOperationFence(ledger, merchants, context) {
    return Object.freeze({
      context,
      ledger: ledgerIdentity(ledger),
      merchants: cloneValue(merchants),
    });
  }

  function operationFenceCurrent(fence) {
    if (!fence || !authorityContextCurrent(fence.context)) return false;
    const snapshot = readSnapshot();
    return Boolean(
      snapshot.ok &&
      ledgerOwnedByContext(snapshot.ledger, fence.context) &&
      identitiesEqual(ledgerIdentity(snapshot.ledger), fence.ledger) &&
      jsonValuesEqual(snapshot.merchants, fence.merchants),
    );
  }

  async function compactTerminalRecords() {
    return performPrivateMutation((current) => {
      const compacted = compactMerchantTransactionLedger(current.ledger, {
        terminalCap: bindings.terminalCap,
        maxRecords: bindings.maxRecords,
      });
      if (jsonValuesEqual(compacted, current.ledger)) return null;
      return {
        merchants: current.merchants,
        ledger: compacted,
        outcome: { status: "compacted" },
      };
    });
  }

  async function reconcilePending() {
    if (reconcilePromise) return reconcilePromise;
    reconcilePromise = (async () => {
      const barrier = await ensureBarrier();
      if (barrier.status !== "ready") return barrier;
      const initial = readSnapshot();
      if (!initial.ok) return initial;
      const results = [];
      for (const record of initial.ledger.records) {
        if (record.stage === "terminal") continue;
        results.push(
          await (record.stage === "needs-review"
            ? recheck(record)
            : drive(record)),
        );
        if (observeAuthority() == null || authority.barrier !== "claimed") {
          return authorityLost("authority-lost-during-reconciliation");
        }
      }
      const compacted = await compactTerminalRecords();
      if (
        compacted.status === "error" ||
        compacted.status === "authority-lost"
      ) {
        return compacted;
      }
      return { status: "reconciled", results };
    })().finally(() => {
      reconcilePromise = null;
    });
    return reconcilePromise;
  }

  function schedule(reason = "state-change") {
    if (reason === "local-write" || localWriteDepth > 0) {
      return scheduledPromise ?? Promise.resolve({ status: "ignored" });
    }
    if (scheduledPromise) return scheduledPromise;
    scheduledPromise = Promise.resolve()
      .then(() => reconcilePending())
      .catch((error) => {
        bindings.logError(
          `${MODULE_ID} | Merchant reconciliation failed`,
          error,
        );
        return { status: "error", reason: "reconciliation-failed", error };
      })
      .finally(() => {
        scheduledPromise = null;
      });
    return scheduledPromise;
  }

  async function register() {
    await bindings.ensureTabLeadership();
    if (!registered) {
      registered = true;
      removePrivateSubscription = bindings.subscribePrivateState((payload) => {
        if (localWriteDepth > 0 || payload?.reason === "local-write") return;
        if (
          Array.isArray(payload?.keys) &&
          !payload.keys.includes("merchantTransactions") &&
          !payload.keys.includes("merchants")
        ) {
          return;
        }
        if (
          payload?.reason === "authority-change" ||
          payload?.reason === "role-demotion" ||
          payload?.reason === "role-promotion"
        ) {
          resetAuthority();
        }
        schedule(payload?.reason ?? "private-state");
      });
      removeAuthoritySubscription = bindings.subscribeAuthority(() => {
        Promise.resolve(bindings.ensureTabLeadership()).then(() => {
          const observed = observeAuthority();
          if (!observed || observed !== authority.id) resetAuthority();
          schedule("authority-change");
        });
      });
    }
    return reconcilePending();
  }

  function unregister() {
    removePrivateSubscription?.();
    removeAuthoritySubscription?.();
    removePrivateSubscription = null;
    removeAuthoritySubscription = null;
    registered = false;
    resetAuthority();
    return true;
  }

  return Object.freeze({
    register,
    unregister,
    lookup,
    persistPrepared,
    persistPreparedLocked,
    persistPreparedAndDriveLocked,
    persistPreparedWithLock,
    submit,
    drive,
    drivePendingLocked,
    recheck,
    reconcile: reconcilePending,
    reconcilePending,
    schedule,
  });

  function transitionTime(record) {
    return Math.max(record.updatedAt, bindings.now());
  }
}

function normalizeMutationState(raw) {
  if (!raw || !Array.isArray(raw.merchants)) {
    throw new MerchantTransactionCoordinatorError(
      "MERCHANT_PRIVATE_STATE_INVALID",
      "Merchant private state is unavailable",
    );
  }
  return {
    merchants: cloneValue(raw.merchants),
    ledger: normalizeMerchantTransactionLedger(raw.merchantTransactions),
  };
}

function normalizeIdentity(input) {
  const source = input?.record ?? input;
  if (!source || typeof source !== "object") {
    return {
      ok: false,
      status: "needs-review",
      reason: "invalid-transaction-identity",
    };
  }
  const originUserId = cleanId(source.originUserId);
  const commitId = cleanId(source.commitId);
  if (!originUserId || !commitId) {
    return {
      ok: false,
      status: "needs-review",
      reason: "invalid-transaction-identity",
    };
  }
  return {
    ok: true,
    originUserId,
    commitId,
    requestFingerprint:
      typeof source.requestFingerprint === "string"
        ? source.requestFingerprint
        : null,
  };
}

function findMerchantSnapshot(merchants, merchantId) {
  return (
    (Array.isArray(merchants) ? merchants : []).find(
      (merchant) => String(merchant?.id ?? "") === merchantId,
    ) ?? null
  );
}

function assessPinnedReview(bindings, snapshot, record) {
  const actor = bindings.resolveActor(record.actor.actorId);
  const actorRead = bindings.readActorBoundary(actor, record.actor.itemId);
  const merchant = findMerchantSnapshot(
    snapshot.merchants,
    record.merchant.merchantId,
  );
  return classifyMerchantTransactionReviewRecovery(record, {
    actor: actorRead?.ok ? actorRead.boundary : null,
    merchant,
  });
}

function reviewAssessmentsEqual(left, right) {
  return Boolean(
    left &&
    right &&
    left.action === right.action &&
    left.nextStage === right.nextStage &&
    left.actorState === right.actorState &&
    left.merchantState === right.merchantState &&
    left.actorWalletState === right.actorWalletState &&
    left.actorItemState === right.actorItemState,
  );
}

function reviewRecoveryStillProven(bindings, snapshot, record, expected) {
  if (!snapshot?.ok) return false;
  const fresh = assessPinnedReview(bindings, snapshot, record);
  return fresh.action === "recover" && reviewAssessmentsEqual(fresh, expected);
}

function pinnedReviewOutcome(record, assessment) {
  return {
    status: "needs-review",
    reason: assessment.reason,
    record,
    assessment,
    pinned: true,
    manualCorrectionRequired: true,
    guidance:
      "Correct the Actor or Merchant to an exact planned before/after checkpoint, then recheck. Do not reset, delete, or force-complete the transaction.",
  };
}

function replaceMerchantSnapshot(merchants, merchantId, replacement) {
  const index = merchants.findIndex(
    (merchant) => String(merchant?.id ?? "") === merchantId,
  );
  if (index < 0) {
    throw new MerchantTransactionCoordinatorError(
      "MERCHANT_NOT_FOUND",
      "Merchant disappeared before its durable commit",
    );
  }
  const next = cloneValue(merchants);
  next[index] = cloneValue(replacement);
  return next;
}

function findUnresolvedCollision(ledger, record) {
  for (const candidate of ledger.records) {
    if (candidate.key === record.key || candidate.stage === "terminal")
      continue;
    if (
      candidate.actor?.actorId === record.actor.actorId ||
      candidate.merchant?.merchantId === record.merchant.merchantId
    ) {
      return candidate;
    }
  }
  return null;
}

function actorBoundaryMatches(bindings, actorPlan, expected) {
  const actor = bindings.resolveActor(actorPlan.actorId);
  const observed = bindings.readActorBoundary(actor, actorPlan.itemId);
  return Boolean(observed?.ok && jsonValuesEqual(observed.boundary, expected));
}

function actorStateFromComponentStates(walletState, itemState) {
  if (walletState === "third-state" || itemState === "third-state") {
    return "third-state";
  }
  const walletAfter = walletState === "after" || walletState === "both";
  const itemAfter = itemState === "after" || itemState === "both";
  const walletBefore = walletState === "before" || walletState === "both";
  const itemBefore = itemState === "before" || itemState === "both";
  if (walletAfter && itemAfter) return "after";
  if (walletBefore && itemBefore) return "before";
  if (
    (walletState === "before" || walletState === "after") &&
    (itemState === "before" || itemState === "after")
  ) {
    return "partial";
  }
  return "third-state";
}

function enrichReplay(replay, snapshot) {
  if (!replay || typeof replay !== "object") return replay;
  if (!replay.record || !snapshot?.ok) return replay;
  const merchantId = replay.record.merchant?.merchantId;
  return {
    ...replay,
    merchant: merchantId
      ? findMerchantSnapshot(snapshot.merchants, merchantId)
      : null,
  };
}

function authorityLost(reason, error = null) {
  return {
    status: "authority-lost",
    reason,
    ...(error ? { error } : {}),
  };
}

function authorityFenceError() {
  return new MerchantTransactionCoordinatorError(
    "MERCHANT_AUTHORITY_FENCE_LOST",
    "Merchant transaction authority fence was lost",
  );
}

function isAuthorityFenceError(error) {
  return (
    error?.code === "MERCHANT_AUTHORITY_FENCE_LOST" ||
    error?.message === "MerchantWriteAuthorityLost" ||
    String(error?.message ?? "").includes("AuthorityFence") ||
    String(error?.message ?? "").includes("PreconditionFailed") ||
    String(error?.message ?? "").includes("PostconditionFailed")
  );
}

function outcomeOnly(outcome) {
  const error = new MerchantTransactionCoordinatorError(
    "MERCHANT_COORDINATOR_OUTCOME_ONLY",
    "Merchant coordinator mutation intentionally skipped",
  );
  error.outcome = outcome;
  throw error;
}

function cleanId(value) {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return id || null;
}

function cloneValue(value) {
  return value == null ? value : structuredClone(value);
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

function jsonValuesEqual(left, right) {
  return stableJson(left) === stableJson(right);
}

function randomHex128() {
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues !== "function") {
    throw new Error("SecureRandomUnavailable");
  }
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function defaultCreateAuthorityEpoch() {
  return `mte.${Date.now().toString(36)}.${randomHex128()}`;
}

function defaultCreateWriteToken() {
  return `mtw.${randomHex128()}`;
}

function defaultSubscribePrivateState(callback) {
  const id = onPrivateStateChanged(callback);
  return () => {
    if (id != null) globalThis.Hooks?.off?.(PRIVATE_STATE_CHANGED_HOOK, id);
  };
}

function defaultSubscribeAuthority(callback) {
  const registrations = [];
  for (const hook of AUTHORITY_HOOKS) {
    const id = globalThis.Hooks?.on?.(hook, callback);
    if (id != null) registrations.push([hook, id]);
  }
  return () => {
    for (const [hook, id] of registrations) globalThis.Hooks?.off?.(hook, id);
  };
}

const PRODUCTION_BINDINGS = Object.freeze({
  getPrivateState,
  isPrivateReady: isPrivilegedPrivateStateReady,
  updateMerchantPrivateState,
  authoritativeGMId,
  isAuthoritativeGM,
  ensureTabLeadership: ensureMerchantTabLeadership,
  hasTabLeadership: hasMerchantTabLeadership,
  currentUserId: () => globalThis.game?.user?.id ?? null,
  createAuthorityEpoch: defaultCreateAuthorityEpoch,
  createWriteToken: defaultCreateWriteToken,
  resolveActor: (actorId) => globalThis.game?.actors?.get?.(actorId) ?? null,
  readActorBoundary: readMerchantActorBoundary,
  applyActorPlan: applyDurableMerchantActorPlan,
  runWithMerchantActorMutex,
  subscribePrivateState: defaultSubscribePrivateState,
  subscribeAuthority: defaultSubscribeAuthority,
  now: () => Date.now(),
  terminalCap: 250,
  maxRecords: 5000,
  maxUnresolvedPerOrigin: 25,
  logError: (...args) => console.error(...args),
});

function assertBindings(bindings) {
  for (const name of [
    "getPrivateState",
    "isPrivateReady",
    "updateMerchantPrivateState",
    "authoritativeGMId",
    "isAuthoritativeGM",
    "ensureTabLeadership",
    "hasTabLeadership",
    "currentUserId",
    "createAuthorityEpoch",
    "createWriteToken",
    "resolveActor",
    "readActorBoundary",
    "applyActorPlan",
    "runWithMerchantActorMutex",
    "subscribePrivateState",
    "subscribeAuthority",
    "now",
    "logError",
  ]) {
    if (typeof bindings[name] !== "function") {
      throw new TypeError(
        `Merchant coordinator binding ${name} must be a function`,
      );
    }
  }
  if (
    !Number.isSafeInteger(bindings.maxUnresolvedPerOrigin) ||
    bindings.maxUnresolvedPerOrigin < 1
  ) {
    throw new TypeError(
      "Merchant coordinator maxUnresolvedPerOrigin must be a positive integer",
    );
  }
  if (
    !Number.isSafeInteger(bindings.maxRecords) ||
    bindings.maxRecords < 1 ||
    bindings.maxRecords > 5000
  ) {
    throw new TypeError(
      "Merchant coordinator maxRecords must be an integer from 1 to 5000",
    );
  }
}

export const merchantTransactionCoordinator =
  createMerchantTransactionCoordinator();

export function registerMerchantTransactionCoordinator() {
  return merchantTransactionCoordinator.register();
}

export function reconcileMerchantTransactions() {
  return merchantTransactionCoordinator.reconcilePending();
}

export function lookupDurableMerchantTransaction(identity) {
  return merchantTransactionCoordinator.lookup(identity);
}

export function submitDurableMerchantTransaction(record) {
  return merchantTransactionCoordinator.submit(record);
}

export function recheckDurableMerchantTransaction(identity) {
  return merchantTransactionCoordinator.recheck(identity);
}

export function listDurableMerchantTransactionsNeedingReview() {
  try {
    const raw = getPrivateState("merchantTransactions");
    return normalizeMerchantTransactionLedger(raw)
      .records.filter((record) => record.stage === "needs-review")
      .map(cloneValue);
  } catch {
    return [];
  }
}
