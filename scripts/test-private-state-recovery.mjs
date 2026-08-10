import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  canonicalizePrivateStateRecoveryValue,
  createPrivateStateRecoveryService,
  fingerprintPrivateStateRecoveryValue,
} from "./private-state-recovery-service.js";

const SUPPORTED_SCHEMA = 7;

function clone(value) {
  return structuredClone(value);
}

function status(
  state = "blocked",
  code = "candidate-review-required",
  observedSchema = null,
) {
  return {
    state,
    code,
    retryable: false,
    supportedSchema: SUPPORTED_SCHEMA,
    observedSchema,
  };
}

function payload(secret = "candidate-private-value") {
  return {
    merchants: [{ id: secret }],
    merchantAccess: {},
    merchantTransactions: {
      version: 1,
      revision: 0,
      authorityId: null,
      authorityEpoch: null,
      writeToken: null,
      replayFloors: [],
      records: [],
    },
    factions: [],
    resourceConfig: {},
    resourceRunState: {},
    criticalInjuryWorkflow: {},
    criticalInjuryWorkflowCheckpoint: {},
    downtimeConfig: {},
    downtimeWorkflow: {},
    downtimeWorkflowCheckpoint: {},
  };
}

function candidate({
  id = "candidate-a",
  marker = true,
  schemaState = "current",
  observedSchema = SUPPORTED_SCHEMA,
  payloadState = "complete",
  ownershipState = "private",
  privatePayload = payload(),
  recoverySource = undefined,
} = {}) {
  const schemaPresent = schemaState !== "missing";
  const schemaValue =
    schemaState === "future"
      ? SUPPORTED_SCHEMA + 1
      : schemaState === "invalid"
        ? true
        : observedSchema;
  return {
    id,
    createdTime: 100,
    modifiedTime: 200,
    marker,
    schemaState,
    observedSchema: schemaPresent ? observedSchema : null,
    payloadState,
    ownershipState,
    payload: clone(privatePayload),
    fingerprintInput: {
      id,
      marker: { present: true, value: marker },
      schemaVersion: {
        present: schemaPresent,
        value: schemaPresent ? schemaValue : undefined,
      },
      ownership: { default: 0 },
      fields: {
        privatePayload: { present: true, value: clone(privatePayload) },
      },
      recoverySource: {
        present: recoverySource !== undefined,
        value: clone(recoverySource),
      },
    },
  };
}

function recoveryState(overrides = {}) {
  return {
    authority: {
      fullGm: true,
      authoritative: true,
      userId: "gm-a",
    },
    status: status(),
    canonicalId: "",
    candidates: [candidate()],
    snapshot: null,
    ...clone(overrides),
  };
}

function makeHarness(initialState, hooks = {}) {
  const state = clone(initialState);
  const defaults = payload("empty-defaults-must-not-leak");
  defaults.merchants = [];
  const calls = {
    creates: 0,
    digests: 0,
    hydrates: 0,
    settingWrites: 0,
    manualTargets: [],
    clearedTargets: [],
    created: [],
  };
  let tokenSeed = 0;
  let clock = 10_000;

  const service = createPrivateStateRecoveryService(
    {
      captureState: () => clone(state),
      typedDefaults: () => clone(defaults),
      setManualRecoveryTarget(id) {
        calls.manualTargets.push(id);
      },
      clearManualRecoveryTarget(id) {
        calls.clearedTargets.push(id);
      },
      async setCanonicalId(id) {
        await hooks.beforeCanonicalWrite?.({ state, calls, id });
        calls.settingWrites += 1;
        state.canonicalId = id;
        await hooks.afterCanonicalWrite?.({ state, calls, id });
      },
      async createRecoveryDocument({
        payload: privatePayload,
        recoverySource,
      }) {
        calls.creates += 1;
        const id = `recovery-${calls.creates}`;
        const created = candidate({
          id,
          privatePayload,
          recoverySource,
        });
        state.candidates.push(created);
        calls.created.push({
          id,
          payload: clone(privatePayload),
          recoverySource: clone(recoverySource),
        });
        await hooks.afterCreate?.({ state, calls, id, created });
        return id;
      },
      async hydrateCanonical(id) {
        calls.hydrates += 1;
        await hooks.beforeHydrate?.({ state, calls, id });
        const selected = state.candidates.find((entry) => entry.id === id);
        if (selected) {
          selected.schemaState = "current";
          selected.observedSchema = SUPPORTED_SCHEMA;
        }
        state.status = status("ready", "ready", SUPPORTED_SCHEMA);
        await hooks.afterHydrate?.({ state, calls, id });
      },
    },
    {
      now: () => clock,
      randomToken: () =>
        `recovery-token-${String(++tokenSeed).padStart(48, "0")}`,
      async digest(text) {
        calls.digests += 1;
        await hooks.onDigest?.({ state, calls, text });
        return createHash("sha256").update(text).digest("hex");
      },
    },
  );

  return {
    service,
    state,
    calls,
    defaults,
    advance(milliseconds) {
      clock += milliseconds;
    },
  };
}

async function rejectsCode(promise, expectedCode) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.name, "PrivateStateRecoveryError");
    assert.equal(error?.code, expectedCode);
    assert.equal(error?.retryable, false);
    return true;
  });
}

// Fingerprints are deterministic and injective across supported JSON-ish
// values. Unsupported prototypes and values fail closed before hashing.
{
  const left = { b: [2, { y: true, x: "private" }], a: 1 };
  const right = { a: 1, b: [2, { x: "private", y: true }] };
  assert.equal(
    canonicalizePrivateStateRecoveryValue(left),
    canonicalizePrivateStateRecoveryValue(right),
  );
  assert.equal(
    await fingerprintPrivateStateRecoveryValue(left),
    await fingerprintPrivateStateRecoveryValue(right),
  );
  assert.notEqual(
    await fingerprintPrivateStateRecoveryValue(left),
    await fingerprintPrivateStateRecoveryValue({ ...right, a: 2 }),
  );
  assert.notEqual(
    canonicalizePrivateStateRecoveryValue(undefined),
    canonicalizePrivateStateRecoveryValue({ $type: "undefined" }),
  );
  assert.notEqual(
    canonicalizePrivateStateRecoveryValue(-0),
    canonicalizePrivateStateRecoveryValue({
      $type: "number",
      value: "-0",
    }),
  );
  assert.notEqual(
    canonicalizePrivateStateRecoveryValue([undefined]),
    canonicalizePrivateStateRecoveryValue([["undefined"]]),
  );

  const nullPrototype = Object.create(null);
  nullPrototype.b = 2;
  nullPrototype.a = 1;
  assert.equal(
    canonicalizePrivateStateRecoveryValue(nullPrototype),
    canonicalizePrivateStateRecoveryValue({ a: 1, b: 2 }),
  );

  const invalidValues = [
    new Date(0),
    new Map(),
    new Set(),
    /private/u,
    Object.create({ inherited: true }),
    () => true,
    Symbol("private"),
    1n,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Array(1),
  ];
  for (const invalid of invalidValues) {
    assert.throws(
      () => canonicalizePrivateStateRecoveryValue(invalid),
      (error) => error?.code === "PRIVATE_STATE_RECOVERY_FINGERPRINT_INVALID",
    );
  }

  let accessorRead = false;
  const accessor = {};
  Object.defineProperty(accessor, "private", {
    enumerable: true,
    get() {
      accessorRead = true;
      return "must-not-run";
    },
  });
  assert.throws(
    () => canonicalizePrivateStateRecoveryValue(accessor),
    (error) => error?.code === "PRIVATE_STATE_RECOVERY_FINGERPRINT_INVALID",
  );
  assert.equal(accessorRead, false);

  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(
    () => canonicalizePrivateStateRecoveryValue(cyclic),
    (error) => error?.code === "PRIVATE_STATE_RECOVERY_FINGERPRINT_INVALID",
  );
}

// The overview exposes only the locked safe projection. A healthy store cannot
// be mutated, and a secondary GM still sees the underlying blocked status code.
{
  const privateCandidate = candidate({
    id: "safe-metadata-only",
    privatePayload: payload("never-project-this-private-id"),
  });
  const harness = makeHarness(
    recoveryState({
      canonicalId: "missing-canonical",
      candidates: [privateCandidate],
      snapshot: {
        complete: true,
        sourceId: "deleted-store",
        payload: payload("never-project-this-snapshot-id"),
      },
    }),
  );
  const overview = await harness.service.getOverview();
  assert.deepEqual(Object.keys(overview), [
    "status",
    "fullGm",
    "authoritative",
    "canonicalId",
    "canonicalState",
    "candidates",
    "snapshotAvailable",
    "canMutate",
    "canRecoverSnapshot",
    "canCreateEmpty",
    "blockedReason",
  ]);
  assert.deepEqual(Object.keys(overview.candidates[0]), [
    "id",
    "canonical",
    "createdTime",
    "modifiedTime",
    "schemaState",
    "observedSchema",
    "payloadState",
    "ownershipState",
    "eligible",
    "reason",
  ]);
  assert.equal(overview.canonicalState, "unresolved");
  assert.equal(overview.snapshotAvailable, true);
  assert.equal(overview.canMutate, true);
  assert.equal(overview.canRecoverSnapshot, true);
  assert.equal(overview.blockedReason, "candidate-review-required");
  const serialized = JSON.stringify(overview);
  assert.doesNotMatch(serialized, /never-project-this/u);

  harness.state.status = status("ready", "ready", SUPPORTED_SCHEMA);
  harness.state.canonicalId = privateCandidate.id;
  const healthyOverview = await harness.service.getOverview();
  assert.equal(healthyOverview.canMutate, false);
  assert.equal(healthyOverview.canRecoverSnapshot, false);
  assert.equal(healthyOverview.canCreateEmpty, false);

  harness.state.status = status(
    "blocked",
    "future-schema",
    SUPPORTED_SCHEMA + 1,
  );
  harness.state.authority.authoritative = false;
  const secondaryOverview = await harness.service.getOverview();
  assert.equal(secondaryOverview.authoritative, false);
  assert.equal(secondaryOverview.canMutate, false);
  assert.equal(secondaryOverview.blockedReason, "future-schema");
}

// Pending/loading/error states are transient lifecycle states, not recovery
// authorization. Preview and apply stay unavailable and zero-write until the
// store reports an explicit blocked recovery status.
{
  const snapshot = {
    complete: true,
    sourceId: "pending-source",
    payload: payload("pending-private-id"),
  };
  const pending = makeHarness(
    recoveryState({
      status: status("pending", "initializing"),
      snapshot,
    }),
  );
  const pendingOverview = await pending.service.getOverview();
  assert.equal(pendingOverview.canMutate, false);
  assert.equal(pendingOverview.canRecoverSnapshot, false);
  assert.equal(pendingOverview.canCreateEmpty, false);
  await rejectsCode(
    pending.service.previewAdoption("candidate-a"),
    "PRIVATE_STATE_RECOVERY_NOT_AVAILABLE",
  );
  await rejectsCode(
    pending.service.previewSnapshot(),
    "PRIVATE_STATE_RECOVERY_NOT_AVAILABLE",
  );
  await rejectsCode(
    pending.service.previewEmpty(),
    "PRIVATE_STATE_RECOVERY_NOT_AVAILABLE",
  );
  assert.equal(pending.calls.settingWrites, 0);
  assert.equal(pending.calls.creates, 0);

  const adoptionApply = makeHarness(recoveryState());
  const adoptionPreview =
    await adoptionApply.service.previewAdoption("candidate-a");
  adoptionApply.state.status = status("pending", "loading");
  await rejectsCode(
    adoptionApply.service.applyAdoption({ token: adoptionPreview.token }),
    "PRIVATE_STATE_RECOVERY_NOT_AVAILABLE",
  );
  assert.equal(adoptionApply.calls.settingWrites, 0);

  const snapshotApply = makeHarness(
    recoveryState({
      status: status("blocked", "missing-store"),
      snapshot,
    }),
  );
  const snapshotPreview = await snapshotApply.service.previewSnapshot();
  snapshotApply.state.status = status("pending", "initialization-error");
  await rejectsCode(
    snapshotApply.service.applySnapshot({
      token: snapshotPreview.token,
      confirmationToken: snapshotPreview.confirmationToken,
    }),
    "PRIVATE_STATE_RECOVERY_NOT_AVAILABLE",
  );
  assert.equal(snapshotApply.calls.creates, 0);
  assert.equal(snapshotApply.calls.settingWrites, 0);

  const emptyApply = makeHarness(
    recoveryState({ status: status("blocked", "missing-store") }),
  );
  const emptyPreview = await emptyApply.service.previewEmpty();
  emptyApply.state.status = status("pending", "store-unavailable");
  await rejectsCode(
    emptyApply.service.applyEmpty({
      token: emptyPreview.token,
      confirmationToken: emptyPreview.confirmationToken,
    }),
    "PRIVATE_STATE_RECOVERY_NOT_AVAILABLE",
  );
  assert.equal(emptyApply.calls.creates, 0);
  assert.equal(emptyApply.calls.settingWrites, 0);
}

// Healthy stores and already-canonical candidates cannot be adopted, and both
// paths remain zero-write.
{
  const canonical = candidate({ id: "healthy-canonical" });
  const alternate = candidate({ id: "healthy-alternate" });
  const healthy = makeHarness(
    recoveryState({
      status: status("ready", "ready", SUPPORTED_SCHEMA),
      canonicalId: canonical.id,
      candidates: [canonical, alternate],
    }),
  );
  await rejectsCode(
    healthy.service.previewAdoption(alternate.id),
    "PRIVATE_STATE_RECOVERY_NOT_AVAILABLE",
  );
  assert.equal(healthy.calls.settingWrites, 0);

  const blocked = makeHarness(
    recoveryState({ canonicalId: canonical.id, candidates: [canonical] }),
  );
  await rejectsCode(
    blocked.service.previewAdoption(canonical.id),
    "PRIVATE_STATE_RECOVERY_CANDIDATE_INELIGIBLE",
  );
  assert.equal(blocked.calls.settingWrites, 0);
}

// Future, malformed, incomplete, and unsafe candidates are projected as
// ineligible and rejected before any canonical-setting write.
{
  const cases = [
    candidate({
      id: "future",
      schemaState: "future",
      observedSchema: SUPPORTED_SCHEMA + 1,
    }),
    candidate({ id: "invalid", schemaState: "invalid", observedSchema: null }),
    candidate({ id: "incomplete", payloadState: "incomplete" }),
    candidate({ id: "unsafe", ownershipState: "unsafe" }),
  ];
  for (const entry of cases) {
    const harness = makeHarness(recoveryState({ candidates: [entry] }));
    const overview = await harness.service.getOverview();
    assert.equal(overview.candidates[0].eligible, false);
    await rejectsCode(
      harness.service.previewAdoption(entry.id),
      "PRIVATE_STATE_RECOVERY_CANDIDATE_INELIGIBLE",
    );
    assert.equal(harness.calls.settingWrites, 0);
  }
}

// Candidate adoption is previewed, fingerprinted, applied once, hydrated, and
// read back without exposing the private payload in either result.
{
  const legacy = candidate({
    id: "legacy-candidate",
    schemaState: "legacy",
    observedSchema: 5,
    ownershipState: "restricted",
    privatePayload: payload("adopted-private-id"),
  });
  const harness = makeHarness(
    recoveryState({
      canonicalId: "unresolved-old-id",
      candidates: [legacy],
    }),
  );
  const preview = await harness.service.previewAdoption(legacy.id);
  assert.deepEqual(Object.keys(preview), [
    "token",
    "expiresAt",
    "candidate",
    "canonicalId",
    "warningCode",
  ]);
  assert.ok(preview.token.length >= 43);
  assert.equal(preview.candidate.schemaState, "legacy");
  assert.equal(preview.candidate.eligible, true);
  assert.doesNotMatch(JSON.stringify(preview), /adopted-private-id/u);

  const result = await harness.service.applyAdoption({ token: preview.token });
  assert.equal(result.ok, true);
  assert.equal(result.kind, "candidate-adoption");
  assert.equal(result.canonicalId, legacy.id);
  assert.equal(result.status.state, "ready");
  assert.equal(harness.calls.settingWrites, 1);
  assert.equal(harness.calls.hydrates, 1);
  assert.deepEqual(harness.calls.manualTargets, [legacy.id]);
  assert.deepEqual(harness.calls.clearedTargets, [legacy.id]);
  assert.doesNotMatch(JSON.stringify(result), /adopted-private-id/u);
  await rejectsCode(
    harness.service.applyAdoption({ token: preview.token }),
    "PRIVATE_STATE_RECOVERY_PREVIEW_INVALID",
  );
}

// A candidate/context change or token expiry after preview invalidates the
// single-use intent without writing the canonical setting.
{
  const changed = makeHarness(recoveryState());
  const changedPreview = await changed.service.previewAdoption("candidate-a");
  changed.state.candidates[0].fingerprintInput.fields.privatePayload.value =
    payload("changed-after-preview");
  await rejectsCode(
    changed.service.applyAdoption({ token: changedPreview.token }),
    "PRIVATE_STATE_RECOVERY_CONTEXT_CHANGED",
  );
  assert.equal(changed.calls.settingWrites, 0);

  const expired = makeHarness(recoveryState());
  const expiredPreview = await expired.service.previewAdoption("candidate-a");
  expired.advance(60_001);
  await rejectsCode(
    expired.service.applyAdoption({ token: expiredPreview.token }),
    "PRIVATE_STATE_RECOVERY_PREVIEW_EXPIRED",
  );
  assert.equal(expired.calls.settingWrites, 0);
}

// Authority is bound to the previewing GM. A user/authority handoff consumes
// the token and blocks the apply before any canonical-setting write.
{
  const harness = makeHarness(recoveryState());
  const preview = await harness.service.previewAdoption("candidate-a");
  harness.state.authority.userId = "gm-b";
  await rejectsCode(
    harness.service.applyAdoption({ token: preview.token }),
    "PRIVATE_STATE_RECOVERY_AUTHORITY_CHANGED",
  );
  assert.equal(harness.calls.settingWrites, 0);
  await rejectsCode(
    harness.service.applyAdoption({ token: preview.token }),
    "PRIVATE_STATE_RECOVERY_PREVIEW_INVALID",
  );
}

// Tokens are operation-bound and single-use even when first presented to the
// wrong apply method.
{
  const harness = makeHarness(recoveryState());
  const preview = await harness.service.previewAdoption("candidate-a");
  await rejectsCode(
    harness.service.applyEmpty({ token: preview.token }),
    "PRIVATE_STATE_RECOVERY_PREVIEW_INVALID",
  );
  await rejectsCode(
    harness.service.applyAdoption({ token: preview.token }),
    "PRIVATE_STATE_RECOVERY_PREVIEW_INVALID",
  );
  assert.equal(harness.calls.settingWrites, 0);
  assert.equal(harness.calls.creates, 0);
}

// If the store becomes healthy during the async fingerprint step, adoption is
// refused again immediately before the canonical-setting write.
{
  let flipOnDigest = false;
  const harness = makeHarness(recoveryState(), {
    onDigest({ state }) {
      if (!flipOnDigest) return;
      flipOnDigest = false;
      state.status = status("ready", "ready", SUPPORTED_SCHEMA);
    },
  });
  const preview = await harness.service.previewAdoption("candidate-a");
  flipOnDigest = true;
  await rejectsCode(
    harness.service.applyAdoption({ token: preview.token }),
    "PRIVATE_STATE_RECOVERY_NOT_AVAILABLE",
  );
  assert.equal(harness.calls.settingWrites, 0);
  assert.deepEqual(harness.calls.manualTargets, ["candidate-a"]);
  assert.deepEqual(harness.calls.clearedTargets, ["candidate-a"]);
}

// Snapshot recovery requires the destructive confirmation token, then creates
// the exact verified payload with safe source metadata and retains all old
// candidates.
{
  const snapshotPayload = payload("verified-snapshot-private-id");
  const oldCandidate = candidate({ id: "old-candidate" });
  const harness = makeHarness(
    recoveryState({
      status: status("blocked", "missing-store"),
      canonicalId: "deleted-canonical",
      candidates: [oldCandidate],
      snapshot: {
        complete: true,
        sourceId: "deleted-canonical",
        payload: snapshotPayload,
      },
    }),
  );
  const rejectedPreview = await harness.service.previewSnapshot();
  assert.notEqual(rejectedPreview.token, rejectedPreview.confirmationToken);
  await rejectsCode(
    harness.service.applySnapshot({
      token: rejectedPreview.token,
      confirmationToken: "wrong-confirmation",
    }),
    "PRIVATE_STATE_RECOVERY_CONFIRMATION_INVALID",
  );
  assert.equal(harness.calls.creates, 0);
  assert.equal(harness.calls.settingWrites, 0);

  const preview = await harness.service.previewSnapshot();
  assert.deepEqual(Object.keys(preview), [
    "token",
    "confirmationToken",
    "expiresAt",
    "sourceId",
    "canonicalId",
    "warningCode",
  ]);
  assert.equal(preview.sourceId, "deleted-canonical");
  const result = await harness.service.applySnapshot({
    token: preview.token,
    confirmationToken: preview.confirmationToken,
  });
  assert.equal(result.kind, "snapshot-recovery");
  assert.equal(harness.calls.creates, 1);
  assert.equal(harness.calls.settingWrites, 1);
  assert.equal(harness.calls.hydrates, 1);
  assert.deepEqual(harness.calls.created[0].payload, snapshotPayload);
  assert.deepEqual(harness.calls.created[0].recoverySource, {
    version: 1,
    kind: "verified-snapshot",
    sourceId: "deleted-canonical",
    sourceFingerprint:
      harness.calls.created[0].recoverySource.sourceFingerprint,
    createdAt: 10_000,
  });
  assert.match(
    harness.calls.created[0].recoverySource.sourceFingerprint,
    /^sha256:[a-f0-9]{64}$/u,
  );
  assert.equal(
    harness.state.candidates.some((entry) => entry.id === oldCandidate.id),
    true,
  );
  assert.equal(harness.state.candidates.length, 2);
  assert.doesNotMatch(
    JSON.stringify(harness.calls.created[0].recoverySource),
    /verified-snapshot-private-id/u,
  );
}

// Empty replacement creates the typed defaults only after confirmation.
{
  const harness = makeHarness(
    recoveryState({
      status: status("blocked", "missing-store"),
      candidates: [],
    }),
  );
  const preview = await harness.service.previewEmpty();
  assert.deepEqual(Object.keys(preview), [
    "token",
    "confirmationToken",
    "expiresAt",
    "canonicalId",
    "warningCode",
  ]);
  const result = await harness.service.applyEmpty({
    token: preview.token,
    confirmationToken: preview.confirmationToken,
  });
  assert.equal(result.kind, "empty-replacement");
  assert.deepEqual(harness.calls.created[0].payload, harness.defaults);
  assert.equal(
    harness.calls.created[0].recoverySource.kind,
    "empty-replacement",
  );
  assert.equal(harness.calls.created[0].recoverySource.sourceId, null);
}

// A competing canonical change during document creation is never overwritten.
// The new, unselected document is retained for later review.
{
  const harness = makeHarness(
    recoveryState({
      status: status("blocked", "missing-store"),
      candidates: [],
    }),
    {
      afterCreate({ state }) {
        state.canonicalId = "other-client-canonical";
      },
    },
  );
  const preview = await harness.service.previewEmpty();
  await rejectsCode(
    harness.service.applyEmpty({
      token: preview.token,
      confirmationToken: preview.confirmationToken,
    }),
    "PRIVATE_STATE_RECOVERY_CREATE_FAILED",
  );
  assert.equal(harness.calls.creates, 1);
  assert.equal(harness.calls.settingWrites, 0);
  assert.equal(harness.state.canonicalId, "other-client-canonical");
  assert.equal(
    harness.state.candidates.some((entry) => entry.id === "recovery-1"),
    true,
  );
}

// A created document that reports a future schema is quarantined before the
// canonical setting can point at it, and the orphan remains intact.
{
  const harness = makeHarness(
    recoveryState({
      status: status("blocked", "missing-store"),
      candidates: [],
    }),
    {
      afterCreate({ created }) {
        created.schemaState = "future";
        created.observedSchema = SUPPORTED_SCHEMA + 1;
        created.fingerprintInput.schemaVersion = {
          present: true,
          value: SUPPORTED_SCHEMA + 1,
        };
      },
    },
  );
  const preview = await harness.service.previewEmpty();
  await rejectsCode(
    harness.service.applyEmpty({
      token: preview.token,
      confirmationToken: preview.confirmationToken,
    }),
    "PRIVATE_STATE_RECOVERY_CREATE_VERIFICATION_FAILED",
  );
  assert.equal(harness.calls.creates, 1);
  assert.equal(harness.calls.settingWrites, 0);
  assert.equal(harness.state.candidates[0].schemaState, "future");
}

// Both the primary and confirmation token must retain at least 256 bits of
// base64url-shaped capacity in injected test implementations.
{
  const service = createPrivateStateRecoveryService(
    {
      captureState: () => recoveryState({ candidates: [] }),
      typedDefaults: () => payload(),
      setManualRecoveryTarget() {},
      clearManualRecoveryTarget() {},
      async setCanonicalId() {},
      async createRecoveryDocument() {},
      async hydrateCanonical() {},
    },
    { randomToken: () => "too-short" },
  );
  await rejectsCode(
    service.previewEmpty(),
    "PRIVATE_STATE_RECOVERY_TOKEN_INVALID",
  );
}

console.log("private-state recovery validation passed");
