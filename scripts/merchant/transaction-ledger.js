/**
 * Infinity D&D5e - Merchant transaction ledger domain
 *
 * Pure data shaping for durable buy/sell commits. This module intentionally
 * performs no Foundry reads, writes, or socket work. Callers persist the
 * returned v1 envelope and execute only the action selected by reconciliation.
 */

export const MERCHANT_TRANSACTION_LEDGER_VERSION = 1;
export const MERCHANT_TRANSACTION_RECORD_VERSION = 1;
export const MERCHANT_TRANSACTION_STAGES = Object.freeze([
  "prepared",
  "actor-applied",
  "merchant-applied",
  "terminal",
  "needs-review",
]);

export const DEFAULT_MERCHANT_TERMINAL_CAP = 250;
export const MAX_MERCHANT_LEDGER_RECORDS = 5000;

const FULL_STAGES = new Set([
  "prepared",
  "actor-applied",
  "merchant-applied",
  "needs-review",
]);
const UNRESOLVED_STAGES = new Set(FULL_STAGES);
const SIDES = new Set(["buy", "sell"]);
const ACTOR_STATE_LABELS = new Set([
  "before",
  "after",
  "partial",
  "both",
  "third-state",
]);
const WALLET_KEYS = Object.freeze(["pp", "gp", "ep", "sp", "cp"]);
const ENVELOPE_KEYS = Object.freeze([
  "version",
  "revision",
  "authorityId",
  "authorityEpoch",
  "writeToken",
  "replayFloors",
  "records",
]);
const COMMON_RECORD_KEYS = Object.freeze([
  "version",
  "key",
  "originUserId",
  "commitId",
  "requestFingerprint",
  "side",
  "stage",
  "createdAt",
  "updatedAt",
]);
const MAX_ID_LENGTH = 256;
const MAX_FINGERPRINT_LENGTH = 8192;
const MAX_ITEM_NAME_LENGTH = 512;
const MAX_REPLAY_FLOORS = 1000;
const MAX_JSON_DEPTH = 24;
const MAX_JSON_NODES = 250000;
const MAX_JSON_STRING_CHARS = 2_000_000;
const MAX_COLLECTION_SIZE = 5000;
const MAX_STRING_LENGTH = 65536;
const COMMIT_ID_PATTERN = /^m1\.([0-9a-z]+)\.([0-9a-f]{32})$/;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export class MerchantTransactionLedgerError extends Error {
  constructor(code, message, path = "") {
    super(message);
    this.name = "MerchantTransactionLedgerError";
    this.code = code;
    this.path = path;
  }
}

/** Create a sortable m1 id from a server-observed timestamp and 128-bit hex. */
export function formatMerchantCommitId(timestamp, randomHex) {
  const time = safeInteger(timestamp, "timestamp", { min: 1 });
  const tail = strictString(randomHex, "randomHex", {
    max: 32,
    pattern: /^[0-9a-f]{32}$/,
  });
  return `m1.${time.toString(36)}.${tail}`;
}

/** Parse a durable commit id without Number.parseInt precision loss. */
export function parseMerchantCommitId(commitId) {
  const id = strictString(commitId, "commitId", { max: MAX_ID_LENGTH });
  const match = COMMIT_ID_PATTERN.exec(id);
  if (!match)
    fail(
      "MERCHANT_COMMIT_ID_INVALID",
      "Invalid merchant commit id",
      "commitId",
    );
  let timestamp = 0n;
  for (const character of match[1]) {
    const digit = BigInt(parseInt(character, 36));
    timestamp = timestamp * 36n + digit;
    if (timestamp > MAX_SAFE_BIGINT) {
      fail(
        "MERCHANT_COMMIT_ID_INVALID",
        "Merchant commit timestamp is unsafe",
        "commitId",
      );
    }
  }
  if (timestamp < 1n) {
    fail(
      "MERCHANT_COMMIT_ID_INVALID",
      "Merchant commit timestamp must be positive",
      "commitId",
    );
  }
  if (timestamp.toString(36) !== match[1]) {
    fail(
      "MERCHANT_COMMIT_ID_INVALID",
      "Merchant commit timestamp is not canonical",
      "commitId",
    );
  }
  return Object.freeze({
    commitId: id,
    timestamp: Number(timestamp),
    randomHex: match[2],
  });
}

export function compareMerchantCommitIds(left, right) {
  const a = parseMerchantCommitId(left);
  const b = parseMerchantCommitId(right);
  if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
  return a.randomHex.localeCompare(b.randomHex);
}

/** Collision-free serialized tuple; do not concatenate user-controlled ids. */
export function buildMerchantTransactionKey(originUserId, commitId) {
  const user = strictId(originUserId, "originUserId");
  const commit = parseMerchantCommitId(commitId).commitId;
  return JSON.stringify([user, commit]);
}

/** Stable wire-request projection shared by the player retry queue and GM. */
export function merchantCommitRequestFingerprint(commitPayload = {}) {
  const rawQuantity = commitPayload.qty;
  const numericQuantity = Number(rawQuantity);
  const validQuantity =
    Number.isInteger(numericQuantity) &&
    numericQuantity >= 1 &&
    numericQuantity <= 9999;
  return JSON.stringify({
    version: 1,
    type: commitPayload.type ?? "",
    sessionId: commitPayload.sessionId ?? "",
    originUserId: commitPayload.originUserId ?? "",
    actorId: commitPayload.actorId ?? "",
    itemUuid: commitPayload.itemUuid ?? "",
    qty: validQuantity
      ? { valid: true, value: numericQuantity }
      : {
          valid: false,
          type: typeof rawQuantity,
          value: String(rawQuantity),
        },
    totalGp: Number(commitPayload.totalGp),
    sealId: commitPayload.sealId ?? "",
  });
}

export function createMerchantTransactionLedger(overrides = {}) {
  const raw = {
    version: MERCHANT_TRANSACTION_LEDGER_VERSION,
    revision: 0,
    authorityId: null,
    authorityEpoch: null,
    writeToken: null,
    replayFloors: [],
    records: [],
    ...overrides,
  };
  return normalizeMerchantTransactionLedger(raw);
}

/** Strict persisted-envelope parser. Future and malformed versions fail closed. */
export function normalizeMerchantTransactionLedger(raw) {
  assertPlainObject(raw, "ledger");
  assertExactKeys(raw, ENVELOPE_KEYS, "ledger");
  assertSupportedVersion(
    raw.version,
    MERCHANT_TRANSACTION_LEDGER_VERSION,
    "ledger",
  );
  const revision = safeInteger(raw.revision, "ledger.revision", { min: 0 });
  const authorityId = nullableId(raw.authorityId, "ledger.authorityId");
  const authorityEpoch = nullableId(
    raw.authorityEpoch,
    "ledger.authorityEpoch",
  );
  const writeToken = nullableId(raw.writeToken, "ledger.writeToken");
  if (
    !Array.isArray(raw.replayFloors) ||
    raw.replayFloors.length > MAX_REPLAY_FLOORS
  ) {
    fail(
      "MERCHANT_LEDGER_MALFORMED",
      "Invalid replay floor collection",
      "ledger.replayFloors",
    );
  }
  if (
    !Array.isArray(raw.records) ||
    raw.records.length > MAX_MERCHANT_LEDGER_RECORDS
  ) {
    fail(
      "MERCHANT_LEDGER_MALFORMED",
      "Invalid transaction record collection",
      "ledger.records",
    );
  }

  const floors = [];
  const floorByUser = new Map();
  for (let index = 0; index < raw.replayFloors.length; index += 1) {
    const floor = normalizeReplayFloor(
      raw.replayFloors[index],
      `ledger.replayFloors[${index}]`,
    );
    if (floorByUser.has(floor.originUserId)) {
      fail(
        "MERCHANT_LEDGER_MALFORMED",
        "Duplicate replay floor",
        `ledger.replayFloors[${index}]`,
      );
    }
    floorByUser.set(floor.originUserId, floor);
    floors.push(floor);
  }
  floors.sort((left, right) =>
    left.originUserId.localeCompare(right.originUserId),
  );

  const budget = createJsonBudget();
  const records = [];
  const keys = new Set();
  for (let index = 0; index < raw.records.length; index += 1) {
    const record = normalizeMerchantTransactionRecord(raw.records[index], {
      path: `ledger.records[${index}]`,
      budget,
    });
    if (keys.has(record.key)) {
      fail(
        "MERCHANT_LEDGER_MALFORMED",
        "Duplicate transaction key",
        `ledger.records[${index}].key`,
      );
    }
    keys.add(record.key);
    const floor = floorByUser.get(record.originUserId);
    if (
      floor &&
      compareMerchantCommitIds(record.commitId, floor.throughCommitId) <= 0
    ) {
      fail(
        "MERCHANT_LEDGER_MALFORMED",
        "Retained record is at or below its replay floor",
        `ledger.records[${index}]`,
      );
    }
    records.push(record);
  }
  return {
    version: MERCHANT_TRANSACTION_LEDGER_VERSION,
    revision,
    authorityId,
    authorityEpoch,
    writeToken,
    replayFloors: floors,
    records,
  };
}

/** Strict v1 record parser. Full records retain exact recovery snapshots. */
export function normalizeMerchantTransactionRecord(raw, options = {}) {
  const path = options.path ?? "record";
  const budget = options.budget ?? createJsonBudget();
  assertPlainObject(raw, path);
  assertSupportedVersion(
    raw.version,
    MERCHANT_TRANSACTION_RECORD_VERSION,
    path,
  );
  const stage = strictEnum(
    raw.stage,
    MERCHANT_TRANSACTION_STAGES,
    `${path}.stage`,
  );
  const expectedKeys =
    stage === "terminal"
      ? [...COMMON_RECORD_KEYS, "result"]
      : stage === "needs-review"
        ? [
            ...COMMON_RECORD_KEYS,
            "request",
            "actor",
            "merchant",
            "receipt",
            "review",
          ]
        : [...COMMON_RECORD_KEYS, "request", "actor", "merchant", "receipt"];
  assertExactKeys(raw, expectedKeys, path);

  const originUserId = strictId(raw.originUserId, `${path}.originUserId`);
  const commitId = parseMerchantCommitId(raw.commitId).commitId;
  const common = {
    version: MERCHANT_TRANSACTION_RECORD_VERSION,
    key: strictString(raw.key, `${path}.key`, { max: MAX_ID_LENGTH * 3 }),
    originUserId,
    commitId,
    requestFingerprint: strictString(
      raw.requestFingerprint,
      `${path}.requestFingerprint`,
      {
        max: MAX_FINGERPRINT_LENGTH,
      },
    ),
    side: strictEnum(raw.side, SIDES, `${path}.side`),
    stage,
    createdAt: safeInteger(raw.createdAt, `${path}.createdAt`, { min: 0 }),
    updatedAt: safeInteger(raw.updatedAt, `${path}.updatedAt`, { min: 0 }),
  };
  if (common.key !== buildMerchantTransactionKey(originUserId, commitId)) {
    fail(
      "MERCHANT_TRANSACTION_MALFORMED",
      "Transaction key does not match its tuple",
      `${path}.key`,
    );
  }
  if (common.updatedAt < common.createdAt) {
    fail(
      "MERCHANT_TRANSACTION_MALFORMED",
      "updatedAt precedes createdAt",
      `${path}.updatedAt`,
    );
  }

  if (stage === "terminal") {
    const result = normalizeTerminalResult(
      raw.result,
      common,
      `${path}.result`,
    );
    return { ...common, result };
  }

  const request = normalizeRequest(raw.request, `${path}.request`);
  const actor = normalizeActorPlan(raw.actor, `${path}.actor`, budget);
  const merchant = normalizeMerchantPlan(
    raw.merchant,
    `${path}.merchant`,
    budget,
  );
  const receipt = normalizeReceipt(raw.receipt, `${path}.receipt`);
  if (
    request.actorId !== actor.actorId ||
    request.merchantId !== merchant.merchantId
  ) {
    fail(
      "MERCHANT_TRANSACTION_MALFORMED",
      "Request and snapshot identities differ",
      path,
    );
  }
  if (
    request.qty !== receipt.qty ||
    request.unitGp !== receipt.unitGp ||
    request.totalGp !== receipt.totalGp
  ) {
    fail(
      "MERCHANT_TRANSACTION_MALFORMED",
      "Receipt does not match the request",
      `${path}.receipt`,
    );
  }
  assertPlanSideInvariants(common.side, actor, path);
  const full = { ...common, request, actor, merchant, receipt };
  if (stage === "needs-review") {
    full.review = normalizeReview(raw.review, `${path}.review`);
    if (full.review.at !== common.updatedAt) {
      fail(
        "MERCHANT_TRANSACTION_MALFORMED",
        "Review timestamp must match updatedAt",
        `${path}.review.at`,
      );
    }
  }
  return full;
}

export function planMerchantBuyTransaction(input) {
  return planMerchantTransaction("buy", input);
}

export function planMerchantSellTransaction(input) {
  return planMerchantTransaction("sell", input);
}

function planMerchantTransaction(side, input = {}) {
  const commit = parseMerchantCommitId(input.commitId);
  const createdAt = input.createdAt ?? commit.timestamp;
  const request = input.request ?? {};
  const receipt = {
    itemName: input.itemName,
    qty: request.qty,
    unitGp: request.unitGp,
    totalGp: request.totalGp,
  };
  return normalizeMerchantTransactionRecord({
    version: MERCHANT_TRANSACTION_RECORD_VERSION,
    key: buildMerchantTransactionKey(input.originUserId, commit.commitId),
    originUserId: input.originUserId,
    commitId: commit.commitId,
    requestFingerprint: input.requestFingerprint,
    side,
    stage: "prepared",
    createdAt,
    updatedAt: createdAt,
    request,
    actor: input.actor,
    merchant: input.merchant,
    receipt,
  });
}

export function projectTerminalMerchantCommitResult(record) {
  const normalized = normalizeMerchantTransactionRecord(record);
  if (normalized.stage === "terminal")
    return cloneJson(normalized.result, "result");
  return {
    targetUserId: normalized.originUserId,
    sessionId: normalized.request.sessionId,
    commitId: normalized.commitId,
    side: normalized.side,
    ok: true,
    reason: "",
    requestFingerprint: normalized.requestFingerprint,
    totalGp: normalized.receipt.totalGp,
    unitGp: normalized.receipt.unitGp,
    qty: normalized.receipt.qty,
    itemName: normalized.receipt.itemName,
    sealId: normalized.request.sealId,
  };
}

export function canTransitionMerchantTransaction(fromStage, toStage) {
  if (fromStage === toStage)
    return MERCHANT_TRANSACTION_STAGES.includes(fromStage);
  if (toStage === "needs-review")
    return UNRESOLVED_STAGES.has(fromStage) && fromStage !== "needs-review";
  return (
    (fromStage === "prepared" && toStage === "actor-applied") ||
    (fromStage === "actor-applied" && toStage === "merchant-applied") ||
    (fromStage === "merchant-applied" && toStage === "terminal")
  );
}

/** Guarded, immutable stage transition. Terminal transitions compact snapshots. */
export function transitionMerchantTransaction(record, nextStage, options = {}) {
  const current = normalizeMerchantTransactionRecord(record);
  const target = strictEnum(
    nextStage,
    MERCHANT_TRANSACTION_STAGES,
    "nextStage",
  );
  if (!canTransitionMerchantTransaction(current.stage, target)) {
    fail(
      "MERCHANT_TRANSACTION_INVALID_TRANSITION",
      `Cannot transition ${current.stage} to ${target}`,
      "nextStage",
    );
  }
  if (current.stage === target) return current;
  const updatedAt = safeInteger(
    options.updatedAt ?? current.updatedAt,
    "updatedAt",
    {
      min: current.updatedAt,
    },
  );
  if (target === "terminal") {
    const result = projectTerminalMerchantCommitResult(current);
    return normalizeMerchantTransactionRecord({
      ...pickCommon(current),
      stage: "terminal",
      updatedAt,
      result,
    });
  }
  if (target === "needs-review") {
    const review = {
      reason: options.reason ?? "canonical-state-mismatch",
      actorState: options.actorState ?? "third-state",
      merchantState: options.merchantState ?? "third-state",
      at: updatedAt,
    };
    return normalizeMerchantTransactionRecord({
      ...current,
      stage: target,
      updatedAt,
      review,
    });
  }
  return normalizeMerchantTransactionRecord({
    ...current,
    stage: target,
    updatedAt,
  });
}

/**
 * Classify exact canonical readback after a crash or authority handoff.
 * `apply` means the named side is still exactly at before; `advance` means a
 * prior write landed and only the durable stage marker is behind. Actor item
 * and wallet readback are classified independently; `actorApply` lists only
 * the still-missing component(s), in safe write order.
 */
export function classifyMerchantTransactionReconciliation(
  record,
  { actor: observedActor, merchant: observedMerchant } = {},
) {
  const current = normalizeMerchantTransactionRecord(record);
  if (current.stage === "terminal") {
    return reconciliation(
      "replay",
      null,
      null,
      "terminal-result",
      null,
      null,
      current.result,
    );
  }
  if (current.stage === "needs-review") {
    return reconciliation(
      "needs-review",
      null,
      null,
      current.review.reason,
      current.review.actorState,
      current.review.merchantState,
    );
  }
  let actor;
  let merchant;
  try {
    actor = normalizeActorBoundary(
      observedActor,
      "observed.actor",
      createJsonBudget(),
    );
    merchant = cloneJson(observedMerchant, "observed.merchant");
  } catch {
    return reconciliation(
      "needs-review",
      null,
      null,
      "malformed-observation",
      "third-state",
      "third-state",
    );
  }
  const actorComponents = classifyActorComponents(
    actor,
    current.actor.before,
    current.actor.after,
  );
  const actorState = actorComponents.state;
  const merchantState = classifyExpectedState(
    merchant,
    current.merchant.before,
    current.merchant.after,
  );
  if (actorState === "third-state" || merchantState === "third-state") {
    return reconciliation(
      "needs-review",
      null,
      null,
      "canonical-state-mismatch",
      actorState,
      merchantState,
      null,
      actorComponents,
    );
  }

  const actorAfter = actorState === "after";
  const merchantBefore = merchantState === "before" || merchantState === "both";
  const merchantAfter = merchantState === "after" || merchantState === "both";

  if (current.stage === "prepared") {
    if (!actorAfter) {
      if (!merchantBefore) {
        return reconciliation(
          "needs-review",
          null,
          null,
          "impossible-write-order",
          actorState,
          merchantState,
          null,
          actorComponents,
        );
      }
      return reconciliation(
        "apply",
        "actor",
        "actor-applied",
        actorState === "partial"
          ? "actor-partially-applied"
          : "actor-not-applied",
        actorState,
        merchantState,
        null,
        { ...actorComponents, apply: actorComponents.remaining },
      );
    }
    return reconciliation(
      "advance",
      "ledger",
      "actor-applied",
      "actor-already-applied",
      actorState,
      merchantState,
      null,
      actorComponents,
    );
  }
  if (current.stage === "actor-applied") {
    if (!actorAfter) {
      return reconciliation(
        "needs-review",
        null,
        null,
        "actor-state-regressed",
        actorState,
        merchantState,
        null,
        actorComponents,
      );
    }
    if (merchantState === "before") {
      return reconciliation(
        "apply",
        "merchant",
        "merchant-applied",
        "merchant-not-applied",
        actorState,
        merchantState,
        null,
        actorComponents,
      );
    }
    if (merchantAfter) {
      return reconciliation(
        "advance",
        "ledger",
        "merchant-applied",
        "merchant-already-applied",
        actorState,
        merchantState,
        null,
        actorComponents,
      );
    }
  }
  if (current.stage === "merchant-applied" && actorAfter && merchantAfter) {
    return reconciliation(
      "finalize",
      "ledger",
      "terminal",
      "writes-confirmed",
      actorState,
      merchantState,
      null,
      actorComponents,
    );
  }
  return reconciliation(
    "needs-review",
    null,
    null,
    "canonical-state-mismatch",
    actorState,
    merchantState,
    null,
    actorComponents,
  );
}

/**
 * Recheck a pinned review record against exact canonical boundaries.
 *
 * This classifier is intentionally separate from ordinary reconciliation:
 * `needs-review` remains a terminal branch of the generic forward-only state
 * machine. A review may be reopened only when canonical readback proves one of
 * the three safe checkpoints below. Every other combination stays pinned and
 * requires a human to correct the Actor or Merchant data first.
 */
export function classifyMerchantTransactionReviewRecovery(
  record,
  { actor: observedActor, merchant: observedMerchant } = {},
) {
  const current = normalizeMerchantTransactionRecord(record);
  if (current.stage !== "needs-review") {
    return reviewRecovery(
      "not-applicable",
      null,
      "record-not-needs-review",
      null,
      null,
      null,
    );
  }

  let actor;
  let merchant;
  try {
    actor = normalizeActorBoundary(
      observedActor,
      "observed.actor",
      createJsonBudget(),
    );
    merchant = cloneJson(observedMerchant, "observed.merchant");
  } catch {
    return reviewRecovery(
      "stay-review",
      null,
      "malformed-observation",
      "third-state",
      "third-state",
      null,
    );
  }

  const actorComponents = classifyActorComponents(
    actor,
    current.actor.before,
    current.actor.after,
  );
  const actorState = actorComponents.state;
  const merchantState = classifyExpectedState(
    merchant,
    current.merchant.before,
    current.merchant.after,
  );
  const nextStage = safeReviewRecoveryStage(actorState, merchantState);
  if (nextStage) {
    return reviewRecovery(
      "recover",
      nextStage,
      `canonical-${nextStage}`,
      actorState,
      merchantState,
      actorComponents,
    );
  }
  return reviewRecovery(
    "stay-review",
    null,
    actorState === "third-state" || merchantState === "third-state"
      ? "canonical-state-mismatch"
      : "unsafe-checkpoint-combination",
    actorState,
    merchantState,
    actorComponents,
  );
}

/**
 * Construct the exact forward checkpoint proven by a review recheck.
 * Generic transitions deliberately continue to reject `needs-review` -> live.
 */
export function recoverMerchantTransactionFromReview(
  record,
  assessment,
  options = {},
) {
  const current = normalizeMerchantTransactionRecord(record);
  if (current.stage !== "needs-review") {
    fail(
      "MERCHANT_TRANSACTION_INVALID_RECOVERY",
      "Only a needs-review transaction can be recovered",
      "record.stage",
    );
  }
  const actorState = strictEnum(
    assessment?.actorState,
    ACTOR_STATE_LABELS,
    "assessment.actorState",
  );
  const merchantState = strictEnum(
    assessment?.merchantState,
    ACTOR_STATE_LABELS,
    "assessment.merchantState",
  );
  const provenStage = safeReviewRecoveryStage(actorState, merchantState);
  if (
    assessment?.action !== "recover" ||
    !provenStage ||
    assessment?.nextStage !== provenStage
  ) {
    fail(
      "MERCHANT_TRANSACTION_INVALID_RECOVERY",
      "Canonical review state does not prove a safe recovery checkpoint",
      "assessment",
    );
  }
  const updatedAt = safeInteger(
    options.updatedAt ?? current.updatedAt,
    "updatedAt",
    { min: current.updatedAt },
  );
  const { review: _review, ...withoutReview } = current;
  return normalizeMerchantTransactionRecord({
    ...withoutReview,
    stage: provenStage,
    updatedAt,
  });
}

/** Persist only a record produced by the dedicated needs-review recovery path. */
export function replaceRecoveredMerchantTransactionRecord(ledger, record) {
  const current = normalizeMerchantTransactionLedger(ledger);
  const replacement = normalizeMerchantTransactionRecord(record);
  const index = current.records.findIndex(
    (entry) => entry.key === replacement.key,
  );
  if (index < 0) {
    fail(
      "MERCHANT_TRANSACTION_NOT_FOUND",
      "Transaction record was not found",
      "record.key",
    );
  }
  const existing = current.records[index];
  if (
    existing.stage !== "needs-review" ||
    !new Set(["prepared", "actor-applied", "merchant-applied"]).has(
      replacement.stage,
    )
  ) {
    fail(
      "MERCHANT_TRANSACTION_INVALID_RECOVERY",
      "Recovered transaction does not name a safe review checkpoint",
      "record.stage",
    );
  }
  if (
    existing.requestFingerprint !== replacement.requestFingerprint ||
    existing.originUserId !== replacement.originUserId ||
    existing.commitId !== replacement.commitId ||
    existing.side !== replacement.side ||
    existing.createdAt !== replacement.createdAt ||
    replacement.updatedAt < existing.updatedAt ||
    !replacementPreservesPlan(existing, replacement)
  ) {
    fail(
      "MERCHANT_TRANSACTION_KEY_CONFLICT",
      "Recovered transaction changes its immutable identity or plan",
      "record",
    );
  }
  const records = [...current.records];
  records[index] = replacement;
  return normalizeMerchantTransactionLedger({
    ...current,
    revision: nextRevision(current.revision),
    records,
  });
}

export function findMerchantTransactionRecord(ledger, originUserId, commitId) {
  const normalized = normalizeMerchantTransactionLedger(ledger);
  const key = buildMerchantTransactionKey(originUserId, commitId);
  return normalized.records.find((record) => record.key === key) ?? null;
}

/** Lookup by the durable tuple before any session validation. */
export function lookupMerchantTransactionReplay(
  ledger,
  { originUserId, commitId, requestFingerprint = null } = {},
) {
  const normalized = normalizeMerchantTransactionLedger(ledger);
  const user = strictId(originUserId, "originUserId");
  const commit = parseMerchantCommitId(commitId).commitId;
  const key = buildMerchantTransactionKey(user, commit);
  const record = normalized.records.find((entry) => entry.key === key) ?? null;
  if (record) {
    if (
      requestFingerprint != null &&
      strictString(requestFingerprint, "requestFingerprint", {
        max: MAX_FINGERPRINT_LENGTH,
      }) !== record.requestFingerprint
    ) {
      return { status: "conflict", record: null, result: null };
    }
    if (record.stage === "terminal") {
      return {
        status: "terminal",
        record,
        result: cloneJson(record.result, "result"),
      };
    }
    return { status: "pending", record, result: null };
  }
  const floor = normalized.replayFloors.find(
    (entry) => entry.originUserId === user,
  );
  if (floor && compareMerchantCommitIds(commit, floor.throughCommitId) <= 0) {
    return { status: "compacted", record: null, result: null };
  }
  return { status: "missing", record: null, result: null };
}

export function addMerchantTransactionRecord(ledger, record) {
  const current = normalizeMerchantTransactionLedger(ledger);
  const nextRecord = normalizeMerchantTransactionRecord(record);
  const lookup = lookupMerchantTransactionReplay(current, nextRecord);
  if (lookup.status === "compacted") {
    fail(
      "MERCHANT_TRANSACTION_REPLAY_FLOOR",
      "Commit is at or below its replay floor",
      "record.commitId",
    );
  }
  if (lookup.status !== "missing") {
    if (lookup.record?.requestFingerprint === nextRecord.requestFingerprint)
      return current;
    fail(
      "MERCHANT_TRANSACTION_KEY_CONFLICT",
      "Transaction key already belongs to another request",
      "record.key",
    );
  }
  return normalizeMerchantTransactionLedger({
    ...current,
    revision: nextRevision(current.revision),
    records: [...current.records, nextRecord],
  });
}

export function replaceMerchantTransactionRecord(ledger, record) {
  const current = normalizeMerchantTransactionLedger(ledger);
  const replacement = normalizeMerchantTransactionRecord(record);
  const index = current.records.findIndex(
    (entry) => entry.key === replacement.key,
  );
  if (index < 0) {
    fail(
      "MERCHANT_TRANSACTION_NOT_FOUND",
      "Transaction record was not found",
      "record.key",
    );
  }
  const existing = current.records[index];
  if (
    existing.requestFingerprint !== replacement.requestFingerprint ||
    existing.originUserId !== replacement.originUserId ||
    existing.commitId !== replacement.commitId ||
    existing.side !== replacement.side ||
    existing.createdAt !== replacement.createdAt
  ) {
    fail(
      "MERCHANT_TRANSACTION_KEY_CONFLICT",
      "Replacement changes transaction identity",
      "record.key",
    );
  }
  if (
    existing.stage !== replacement.stage &&
    !canTransitionMerchantTransaction(existing.stage, replacement.stage)
  ) {
    fail(
      "MERCHANT_TRANSACTION_INVALID_TRANSITION",
      "Replacement is not a valid forward transition",
      "record.stage",
    );
  }
  if (replacement.updatedAt < existing.updatedAt) {
    fail(
      "MERCHANT_TRANSACTION_INVALID_TRANSITION",
      "Replacement timestamp moves backward",
      "record.updatedAt",
    );
  }
  if (!replacementPreservesPlan(existing, replacement)) {
    fail(
      "MERCHANT_TRANSACTION_KEY_CONFLICT",
      "Replacement changes the immutable transaction plan",
      "record",
    );
  }
  const records = [...current.records];
  records[index] = replacement;
  return normalizeMerchantTransactionLedger({
    ...current,
    revision: nextRevision(current.revision),
    records,
  });
}

/** Compact terminal plans, cap replay receipts, and never evict unresolved work. */
export function compactMerchantTransactionLedger(
  ledger,
  {
    terminalCap = DEFAULT_MERCHANT_TERMINAL_CAP,
    maxRecords = MAX_MERCHANT_LEDGER_RECORDS,
  } = {},
) {
  const current = normalizeMerchantTransactionLedger(ledger);
  const cap = safeInteger(terminalCap, "terminalCap", {
    min: 0,
    max: MAX_MERCHANT_LEDGER_RECORDS,
  });
  const recordLimit = safeInteger(maxRecords, "maxRecords", {
    min: 0,
    max: MAX_MERCHANT_LEDGER_RECORDS,
  });
  const evicted = new Set();
  const oldestUnresolvedByUser = new Map();
  for (const record of current.records) {
    if (record.stage === "terminal") continue;
    const prior = oldestUnresolvedByUser.get(record.originUserId);
    if (!prior || compareMerchantCommitIds(record.commitId, prior) < 0) {
      oldestUnresolvedByUser.set(record.originUserId, record.commitId);
    }
  }
  const canAdvanceReplayFloorThrough = (record) => {
    const oldestUnresolved = oldestUnresolvedByUser.get(record.originUserId);
    return (
      !oldestUnresolved ||
      compareMerchantCommitIds(record.commitId, oldestUnresolved) < 0
    );
  };
  const terminalsByUser = new Map();
  for (const record of current.records) {
    if (record.stage !== "terminal") continue;
    const list = terminalsByUser.get(record.originUserId) ?? [];
    list.push(record);
    terminalsByUser.set(record.originUserId, list);
  }
  for (const records of terminalsByUser.values()) {
    records.sort((left, right) =>
      compareMerchantCommitIds(left.commitId, right.commitId),
    );
    const removalCount = Math.max(0, records.length - cap);
    const removable = records
      .filter(canAdvanceReplayFloorThrough)
      .slice(0, removalCount);
    for (const record of removable) {
      evicted.add(record.key);
    }
  }
  let kept = current.records.filter((record) => !evicted.has(record.key));
  if (kept.length > recordLimit) {
    const removable = kept
      .filter(
        (record) =>
          record.stage === "terminal" && canAdvanceReplayFloorThrough(record),
      )
      .sort((left, right) => {
        const byCommit = compareMerchantCommitIds(
          left.commitId,
          right.commitId,
        );
        return byCommit || left.originUserId.localeCompare(right.originUserId);
      });
    const needed = kept.length - recordLimit;
    for (const record of removable.slice(0, needed)) evicted.add(record.key);
    kept = current.records.filter((record) => !evicted.has(record.key));
  }
  if (kept.length > recordLimit) {
    fail(
      "MERCHANT_LEDGER_CAPACITY",
      "Unresolved transaction records exceed ledger capacity",
      "ledger.records",
    );
  }
  if (evicted.size === 0) return current;

  const floors = new Map(
    current.replayFloors.map((floor) => [
      floor.originUserId,
      floor.throughCommitId,
    ]),
  );
  for (const record of current.records) {
    if (!evicted.has(record.key)) continue;
    const prior = floors.get(record.originUserId);
    if (!prior || compareMerchantCommitIds(record.commitId, prior) > 0) {
      floors.set(record.originUserId, record.commitId);
    }
  }
  return normalizeMerchantTransactionLedger({
    ...current,
    revision: nextRevision(current.revision),
    replayFloors: [...floors.entries()].map(
      ([originUserId, throughCommitId]) => ({
        originUserId,
        throughCommitId,
      }),
    ),
    records: kept,
  });
}

export function isPinnedMerchantTransaction(record) {
  return UNRESOLVED_STAGES.has(
    normalizeMerchantTransactionRecord(record).stage,
  );
}

function normalizeReplayFloor(raw, path) {
  assertPlainObject(raw, path);
  assertExactKeys(raw, ["originUserId", "throughCommitId"], path);
  return {
    originUserId: strictId(raw.originUserId, `${path}.originUserId`),
    throughCommitId: parseMerchantCommitId(raw.throughCommitId).commitId,
  };
}

function normalizeRequest(raw, path) {
  assertPlainObject(raw, path);
  assertExactKeys(
    raw,
    [
      "sessionId",
      "actorId",
      "merchantId",
      "itemUuid",
      "qty",
      "unitGp",
      "totalGp",
      "sealId",
    ],
    path,
  );
  const qty = safeInteger(raw.qty, `${path}.qty`, { min: 1, max: 9999 });
  const unitGp = safeGp(raw.unitGp, `${path}.unitGp`);
  const totalGp = safeGp(raw.totalGp, `${path}.totalGp`);
  if (Math.round(unitGp * qty * 100) !== Math.round(totalGp * 100)) {
    fail(
      "MERCHANT_TRANSACTION_MALFORMED",
      "Total price does not match unit price and quantity",
      path,
    );
  }
  return {
    sessionId: strictId(raw.sessionId, `${path}.sessionId`),
    actorId: strictId(raw.actorId, `${path}.actorId`),
    merchantId: strictId(raw.merchantId, `${path}.merchantId`),
    itemUuid: strictString(raw.itemUuid, `${path}.itemUuid`, { max: 1024 }),
    qty,
    unitGp,
    totalGp,
    sealId: nullableId(raw.sealId, `${path}.sealId`),
  };
}

function normalizeReceipt(raw, path) {
  assertPlainObject(raw, path);
  assertExactKeys(raw, ["itemName", "qty", "unitGp", "totalGp"], path);
  return {
    itemName: strictString(raw.itemName, `${path}.itemName`, {
      max: MAX_ITEM_NAME_LENGTH,
    }),
    qty: safeInteger(raw.qty, `${path}.qty`, { min: 1, max: 9999 }),
    unitGp: safeGp(raw.unitGp, `${path}.unitGp`),
    totalGp: safeGp(raw.totalGp, `${path}.totalGp`),
  };
}

function normalizeActorPlan(raw, path, budget) {
  assertPlainObject(raw, path);
  assertExactKeys(raw, ["actorId", "itemId", "before", "after"], path);
  const actor = {
    actorId: strictId(raw.actorId, `${path}.actorId`),
    itemId: strictId(raw.itemId, `${path}.itemId`),
    before: normalizeActorBoundary(raw.before, `${path}.before`, budget),
    after: normalizeActorBoundary(raw.after, `${path}.after`, budget),
  };
  validateItemIdentity(actor.before.item, actor.itemId, `${path}.before.item`);
  validateItemIdentity(actor.after.item, actor.itemId, `${path}.after.item`);
  if (jsonValuesEqual(actor.before.wallet, actor.after.wallet)) {
    fail(
      "MERCHANT_TRANSACTION_MALFORMED",
      "Actor wallet before and after snapshots must differ",
      `${path}.wallet`,
    );
  }
  if (jsonValuesEqual(actor.before.item, actor.after.item)) {
    fail(
      "MERCHANT_TRANSACTION_MALFORMED",
      "Actor item before and after snapshots must differ",
      `${path}.item`,
    );
  }
  if (jsonValuesEqual(actor.before, actor.after)) {
    fail(
      "MERCHANT_TRANSACTION_MALFORMED",
      "Actor before and after snapshots must differ",
      path,
    );
  }
  return actor;
}

function normalizeActorBoundary(raw, path, budget) {
  assertPlainObject(raw, path);
  assertExactKeys(raw, ["wallet", "item"], path);
  return {
    wallet: normalizeWallet(raw.wallet, `${path}.wallet`),
    item:
      raw.item === null ? null : cloneJson(raw.item, `${path}.item`, budget),
  };
}

function normalizeWallet(raw, path) {
  assertPlainObject(raw, path);
  assertExactKeys(raw, WALLET_KEYS, path);
  const wallet = {};
  let totalCopper = 0;
  const values = { pp: 1000, gp: 100, ep: 50, sp: 10, cp: 1 };
  for (const denomination of WALLET_KEYS) {
    const value = safeInteger(raw[denomination], `${path}.${denomination}`, {
      min: 0,
    });
    const copper = value * values[denomination];
    if (!Number.isSafeInteger(copper + totalCopper)) {
      fail(
        "MERCHANT_TRANSACTION_MALFORMED",
        "Wallet value exceeds the safe integer range",
        path,
      );
    }
    totalCopper += copper;
    wallet[denomination] = value;
  }
  return wallet;
}

function normalizeMerchantPlan(raw, path, budget) {
  assertPlainObject(raw, path);
  assertExactKeys(raw, ["merchantId", "before", "after"], path);
  const merchantId = strictId(raw.merchantId, `${path}.merchantId`);
  const before = cloneJson(raw.before, `${path}.before`, budget);
  const after = cloneJson(raw.after, `${path}.after`, budget);
  validateDocumentIdentity(before, merchantId, `${path}.before`);
  validateDocumentIdentity(after, merchantId, `${path}.after`);
  return { merchantId, before, after };
}

function normalizeReview(raw, path) {
  assertPlainObject(raw, path);
  assertExactKeys(raw, ["reason", "actorState", "merchantState", "at"], path);
  return {
    reason: strictString(raw.reason, `${path}.reason`, { max: 256 }),
    actorState: strictEnum(
      raw.actorState,
      ACTOR_STATE_LABELS,
      `${path}.actorState`,
    ),
    merchantState: strictEnum(
      raw.merchantState,
      ACTOR_STATE_LABELS,
      `${path}.merchantState`,
    ),
    at: safeInteger(raw.at, `${path}.at`, { min: 0 }),
  };
}

function normalizeTerminalResult(raw, common, path) {
  assertPlainObject(raw, path);
  assertExactKeys(
    raw,
    [
      "targetUserId",
      "sessionId",
      "commitId",
      "side",
      "ok",
      "reason",
      "requestFingerprint",
      "totalGp",
      "unitGp",
      "qty",
      "itemName",
      "sealId",
    ],
    path,
  );
  const result = {
    targetUserId: strictId(raw.targetUserId, `${path}.targetUserId`),
    sessionId: strictId(raw.sessionId, `${path}.sessionId`),
    commitId: parseMerchantCommitId(raw.commitId).commitId,
    side: strictEnum(raw.side, SIDES, `${path}.side`),
    ok: raw.ok,
    reason: raw.reason,
    requestFingerprint: strictString(
      raw.requestFingerprint,
      `${path}.requestFingerprint`,
      {
        max: MAX_FINGERPRINT_LENGTH,
      },
    ),
    totalGp: safeGp(raw.totalGp, `${path}.totalGp`),
    unitGp: safeGp(raw.unitGp, `${path}.unitGp`),
    qty: safeInteger(raw.qty, `${path}.qty`, { min: 1, max: 9999 }),
    itemName: strictString(raw.itemName, `${path}.itemName`, {
      max: MAX_ITEM_NAME_LENGTH,
    }),
    sealId: nullableId(raw.sealId, `${path}.sealId`),
  };
  if (result.ok !== true || result.reason !== "") {
    fail(
      "MERCHANT_TRANSACTION_MALFORMED",
      "Durable terminal results must be successful",
      path,
    );
  }
  if (
    result.targetUserId !== common.originUserId ||
    result.commitId !== common.commitId ||
    result.side !== common.side ||
    result.requestFingerprint !== common.requestFingerprint
  ) {
    fail(
      "MERCHANT_TRANSACTION_MALFORMED",
      "Terminal result identity differs from its record",
      path,
    );
  }
  if (
    Math.round(result.unitGp * result.qty * 100) !==
    Math.round(result.totalGp * 100)
  ) {
    fail(
      "MERCHANT_TRANSACTION_MALFORMED",
      "Terminal result total does not match its unit price and quantity",
      path,
    );
  }
  return result;
}

function assertPlanSideInvariants(side, actor, path) {
  if (
    side === "buy" &&
    (actor.before.item !== null || actor.after.item === null)
  ) {
    fail(
      "MERCHANT_TRANSACTION_MALFORMED",
      "A buy must create the planned Actor item",
      `${path}.actor`,
    );
  }
  if (side === "sell" && actor.before.item === null) {
    fail(
      "MERCHANT_TRANSACTION_MALFORMED",
      "A sale must start with the planned Actor item",
      `${path}.actor`,
    );
  }
}

function validateItemIdentity(snapshot, expectedId, path) {
  if (snapshot === null) return;
  assertPlainObject(snapshot, path);
  const id = documentIdentity(snapshot, path);
  if (!id || id !== expectedId) {
    fail(
      "MERCHANT_TRANSACTION_MALFORMED",
      "Item snapshot identity differs from itemId",
      path,
    );
  }
}

function validateDocumentIdentity(snapshot, expectedId, path) {
  assertPlainObject(snapshot, path);
  const id = documentIdentity(snapshot, path);
  if (!id || id !== expectedId) {
    fail(
      "MERCHANT_TRANSACTION_MALFORMED",
      "Merchant snapshot identity differs from merchantId",
      path,
    );
  }
}

function documentIdentity(snapshot, path) {
  const underscored =
    snapshot._id == null ? "" : strictId(snapshot._id, `${path}._id`);
  const plain = snapshot.id == null ? "" : strictId(snapshot.id, `${path}.id`);
  if (underscored && plain && underscored !== plain) {
    fail("MERCHANT_TRANSACTION_MALFORMED", "Snapshot id fields disagree", path);
  }
  return underscored || plain;
}

function classifyExpectedState(observed, before, after) {
  const matchesBefore = jsonValuesEqual(observed, before);
  const matchesAfter = jsonValuesEqual(observed, after);
  if (matchesBefore && matchesAfter) return "both";
  if (matchesBefore) return "before";
  if (matchesAfter) return "after";
  return "third-state";
}

function classifyActorComponents(observed, before, after) {
  const walletState = classifyExpectedState(
    observed.wallet,
    before.wallet,
    after.wallet,
  );
  const itemState = classifyExpectedState(
    observed.item,
    before.item,
    after.item,
  );
  if (walletState === "third-state" || itemState === "third-state") {
    return {
      state: "third-state",
      walletState,
      itemState,
      remaining: [],
      apply: [],
    };
  }
  const walletAfter = walletState === "after" || walletState === "both";
  const itemAfter = itemState === "after" || itemState === "both";
  const walletBefore = walletState === "before" || walletState === "both";
  const itemBefore = itemState === "before" || itemState === "both";
  const state =
    walletAfter && itemAfter
      ? "after"
      : walletBefore && itemBefore
        ? "before"
        : "partial";
  const remaining = [];
  // Actor item writes precede wallet writes in the current Merchant flow. The
  // list stays explicit so recovery can apply only what canonical readback says
  // is still at `before`, including the inverse hybrid after a hook/retry.
  if (itemState === "before") remaining.push("item");
  if (walletState === "before") remaining.push("wallet");
  return { state, walletState, itemState, remaining, apply: [] };
}

function reconciliation(
  action,
  target,
  nextStage,
  reason,
  actorState,
  merchantState,
  result = null,
  actorComponents = null,
) {
  return {
    action,
    target,
    nextStage,
    reason,
    actorState,
    merchantState,
    actorWalletState: actorComponents?.walletState ?? null,
    actorItemState: actorComponents?.itemState ?? null,
    actorApply: [...(actorComponents?.apply ?? [])],
    result,
  };
}

function safeReviewRecoveryStage(actorState, merchantState) {
  if (
    (actorState === "before" || actorState === "partial") &&
    (merchantState === "before" || merchantState === "both")
  ) {
    return "prepared";
  }
  if (actorState === "after" && merchantState === "before") {
    return "actor-applied";
  }
  if (
    actorState === "after" &&
    (merchantState === "after" || merchantState === "both")
  ) {
    return "merchant-applied";
  }
  return null;
}

function reviewRecovery(
  action,
  nextStage,
  reason,
  actorState,
  merchantState,
  actorComponents,
) {
  return {
    action,
    nextStage,
    reason,
    actorState,
    merchantState,
    actorWalletState: actorComponents?.walletState ?? null,
    actorItemState: actorComponents?.itemState ?? null,
    manualCorrectionRequired: action === "stay-review",
  };
}

function pickCommon(record) {
  return Object.fromEntries(
    COMMON_RECORD_KEYS.map((key) => [key, record[key]]),
  );
}

function replacementPreservesPlan(existing, replacement) {
  if (existing.stage === "terminal") {
    return (
      replacement.stage === "terminal" && jsonValuesEqual(existing, replacement)
    );
  }
  if (replacement.stage === "terminal") {
    return jsonValuesEqual(
      projectTerminalMerchantCommitResult(existing),
      replacement.result,
    );
  }
  return ["request", "actor", "merchant", "receipt"].every((field) =>
    jsonValuesEqual(existing[field], replacement[field]),
  );
}

function nextRevision(revision) {
  return safeInteger(revision + 1, "ledger.revision", { min: 0 });
}

function assertSupportedVersion(value, supported, path) {
  if (Number.isSafeInteger(value) && value > supported) {
    fail(
      "MERCHANT_LEDGER_FUTURE_VERSION",
      `Unsupported future version ${value}`,
      `${path}.version`,
    );
  }
  if (value !== supported) {
    fail(
      "MERCHANT_LEDGER_MALFORMED",
      `Expected version ${supported}`,
      `${path}.version`,
    );
  }
}

function assertPlainObject(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("MERCHANT_LEDGER_MALFORMED", "Expected a plain object", path);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("MERCHANT_LEDGER_MALFORMED", "Non-JSON object prototype", path);
  }
}

function assertExactKeys(value, expected, path) {
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== "string")) {
    fail("MERCHANT_LEDGER_MALFORMED", "Symbol keys are not supported", path);
  }
  const wanted = new Set(expected);
  if (actual.length !== wanted.size || actual.some((key) => !wanted.has(key))) {
    fail(
      "MERCHANT_LEDGER_MALFORMED",
      "Object fields do not match the v1 schema",
      path,
    );
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      fail(
        "MERCHANT_LEDGER_MALFORMED",
        "Accessor or hidden fields are not JSON data",
        `${path}.${key}`,
      );
    }
  }
}

function strictId(value, path) {
  return strictString(value, path, { max: MAX_ID_LENGTH });
}

function nullableId(value, path) {
  return value === null ? null : strictId(value, path);
}

function strictString(
  value,
  path,
  { max = MAX_STRING_LENGTH, pattern = null } = {},
) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > max ||
    value !== value.trim() ||
    (pattern && !pattern.test(value))
  ) {
    fail("MERCHANT_LEDGER_MALFORMED", "Invalid string value", path);
  }
  return value;
}

function strictEnum(value, allowed, path) {
  const values = allowed instanceof Set ? allowed : new Set(allowed);
  if (!values.has(value))
    fail("MERCHANT_LEDGER_MALFORMED", "Unsupported enum value", path);
  return value;
}

function safeInteger(
  value,
  path,
  { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {},
) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail("MERCHANT_LEDGER_MALFORMED", "Expected a bounded safe integer", path);
  }
  return value;
}

function safeGp(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    fail(
      "MERCHANT_TRANSACTION_MALFORMED",
      "Expected a positive finite gp amount",
      path,
    );
  }
  const copper = Math.round(value * 100);
  if (
    !Number.isSafeInteger(copper) ||
    Math.abs(value - copper / 100) > Number.EPSILON
  ) {
    fail(
      "MERCHANT_TRANSACTION_MALFORMED",
      "Gp amount must be exact to copper",
      path,
    );
  }
  return copper / 100;
}

function createJsonBudget() {
  return { nodes: 0, stringChars: 0 };
}

/** Strict JSON clone with aggregate depth/node/string limits and no accessors. */
function cloneJson(value, path, budget = createJsonBudget(), depth = 0) {
  budget.nodes += 1;
  if (depth > MAX_JSON_DEPTH || budget.nodes > MAX_JSON_NODES) {
    fail(
      "MERCHANT_LEDGER_BOUNDS",
      "JSON value exceeds structural bounds",
      path,
    );
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > MAX_STRING_LENGTH)
      fail("MERCHANT_LEDGER_BOUNDS", "JSON string is too long", path);
    budget.stringChars += value.length;
    if (budget.stringChars > MAX_JSON_STRING_CHARS) {
      fail(
        "MERCHANT_LEDGER_BOUNDS",
        "JSON strings exceed aggregate bounds",
        path,
      );
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      fail("MERCHANT_LEDGER_MALFORMED", "JSON numbers must be finite", path);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_COLLECTION_SIZE)
      fail("MERCHANT_LEDGER_BOUNDS", "JSON array is too large", path);
    const copy = [];
    const ownKeys = Reflect.ownKeys(value);
    const expectedKeys = new Set([
      ...Array.from({ length: value.length }, (_, index) => String(index)),
      "length",
    ]);
    if (
      ownKeys.length !== expectedKeys.size ||
      ownKeys.some((key) => typeof key !== "string" || !expectedKeys.has(key))
    ) {
      fail(
        "MERCHANT_LEDGER_MALFORMED",
        "Arrays may contain only indexed JSON values",
        path,
      );
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (
        !descriptor ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      )
        fail(
          "MERCHANT_LEDGER_MALFORMED",
          "Sparse or accessor arrays are not JSON data",
          `${path}[${index}]`,
        );
      copy.push(
        cloneJson(descriptor.value, `${path}[${index}]`, budget, depth + 1),
      );
    }
    return copy;
  }
  assertPlainObject(value, path);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length > MAX_COLLECTION_SIZE ||
    keys.some((key) => typeof key !== "string")
  ) {
    fail(
      "MERCHANT_LEDGER_BOUNDS",
      "JSON object is too large or has symbol keys",
      path,
    );
  }
  const copy = {};
  for (const key of keys) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      fail(
        "MERCHANT_LEDGER_MALFORMED",
        "Unsafe JSON object key",
        `${path}.${key}`,
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      fail(
        "MERCHANT_LEDGER_MALFORMED",
        "Accessor or hidden fields are not JSON data",
        `${path}.${key}`,
      );
    }
    copy[key] = cloneJson(
      descriptor.value,
      `${path}.${key}`,
      budget,
      depth + 1,
    );
  }
  return copy;
}

function jsonValuesEqual(left, right) {
  return stableJson(left) === stableJson(right);
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function fail(code, message, path) {
  throw new MerchantTransactionLedgerError(code, message, path);
}
