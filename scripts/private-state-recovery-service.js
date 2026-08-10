const DEFAULT_TOKEN_TTL_MS = 60_000;
const TOKEN_BYTES = 32;

let liveService = null;

function recoveryError(code, message = code) {
  const error = new Error(message);
  error.name = "PrivateStateRecoveryError";
  error.code = code;
  error.retryable = false;
  return error;
}

function assertPlainObject(value, context) {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw recoveryError(
      "PRIVATE_STATE_RECOVERY_FINGERPRINT_INVALID",
      `PrivateStateRecoveryFingerprintInvalid:${context}`,
    );
  }
}

function fingerprintInvalid(context) {
  throw recoveryError(
    "PRIVATE_STATE_RECOVERY_FINGERPRINT_INVALID",
    `PrivateStateRecoveryFingerprintInvalid:${context}`,
  );
}

function canonicalArray(value, seen, context) {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    fingerprintInvalid(context);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== value.length + 1 || !ownKeys.includes("length")) {
    fingerprintInvalid(context);
  }
  const entries = [];
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      fingerprintInvalid(`${context}[${index}]`);
    }
    entries.push(canonicalNode(descriptor.value, seen, `${context}[${index}]`));
  }
  return ["array", entries];
}

function canonicalObject(value, seen, context) {
  assertPlainObject(value, context);
  const entries = Reflect.ownKeys(value)
    .map((key) => {
      if (typeof key !== "string") fingerprintInvalid(context);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        fingerprintInvalid(`${context}.${key}`);
      }
      return [key, canonicalNode(descriptor.value, seen, `${context}.${key}`)];
    })
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return ["object", entries];
}

function canonicalNode(value, seen, context) {
  if (value === undefined) return ["undefined"];
  if (value === null) return ["null"];
  if (typeof value === "string") return ["string", value];
  if (typeof value === "boolean") return ["boolean", value];
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fingerprintInvalid(context);
    return ["number", Object.is(value, -0) ? "-0" : value];
  }
  if (typeof value !== "object") fingerprintInvalid(context);
  if (seen.has(value)) fingerprintInvalid(context);
  seen.add(value);
  try {
    return Array.isArray(value)
      ? canonicalArray(value, seen, context)
      : canonicalObject(value, seen, context);
  } finally {
    seen.delete(value);
  }
}

/** Deterministic, strict serialization used only as SHA-256 input. */
export function canonicalizePrivateStateRecoveryValue(value) {
  return JSON.stringify(canonicalNode(value, new Set(), "root"));
}

function defaultRandomToken() {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.getRandomValues !== "function") {
    throw recoveryError(
      "PRIVATE_STATE_RECOVERY_CRYPTO_UNAVAILABLE",
      "PrivateStateRecoveryCryptoUnavailable",
    );
  }
  const bytes = new Uint8Array(TOKEN_BYTES);
  cryptoApi.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis
    .btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function defaultDigest(text) {
  const subtle = globalThis.crypto?.subtle;
  if (typeof subtle?.digest !== "function") {
    throw recoveryError(
      "PRIVATE_STATE_RECOVERY_CRYPTO_UNAVAILABLE",
      "PrivateStateRecoveryCryptoUnavailable",
    );
  }
  const bytes = new TextEncoder().encode(
    `infinity-dnd5e/private-state-fingerprint/v1\0${text}`,
  );
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 fingerprint of a strict canonical snapshot. */
export async function fingerprintPrivateStateRecoveryValue(
  value,
  { digest = defaultDigest } = {},
) {
  return `sha256:${await digest(canonicalizePrivateStateRecoveryValue(value))}`;
}

function safeStatus(status) {
  return Object.freeze({
    state: String(status?.state ?? "pending"),
    code: String(status?.code ?? "store-unavailable"),
    retryable: status?.retryable === true,
    supportedSchema: Number.isSafeInteger(status?.supportedSchema)
      ? status.supportedSchema
      : null,
    observedSchema: Number.isSafeInteger(status?.observedSchema)
      ? status.observedSchema
      : null,
  });
}

function candidateReason(candidate) {
  if (candidate.marker !== true) return "not-private-state-store";
  if (candidate.schemaState === "future") return "future-schema";
  if (candidate.schemaState === "invalid") return "invalid-schema";
  if (!["current", "legacy", "missing"].includes(candidate.schemaState)) {
    return "unsupported-schema";
  }
  if (candidate.payloadState === "incomplete") return "incomplete-payload";
  if (candidate.payloadState !== "complete") return "invalid-payload";
  if (!["private", "restricted"].includes(candidate.ownershipState)) {
    return "unsafe-ownership";
  }
  return null;
}

function safeCandidate(candidate, canonicalId) {
  const reason = candidateReason(candidate);
  return Object.freeze({
    id: String(candidate.id),
    canonical: String(candidate.id) === String(canonicalId ?? ""),
    createdTime: Number.isFinite(candidate.createdTime)
      ? candidate.createdTime
      : null,
    modifiedTime: Number.isFinite(candidate.modifiedTime)
      ? candidate.modifiedTime
      : null,
    schemaState: String(candidate.schemaState ?? "invalid"),
    observedSchema: Number.isSafeInteger(candidate.observedSchema)
      ? candidate.observedSchema
      : null,
    payloadState: String(candidate.payloadState ?? "unknown"),
    ownershipState: String(candidate.ownershipState ?? "unknown"),
    eligible: reason === null,
    reason,
  });
}

function canonicalState(canonicalId, candidates) {
  if (!canonicalId) return "unset";
  return candidates.some((candidate) => candidate.id === canonicalId)
    ? "resolved"
    : "unresolved";
}

function blockedReason(state, authority) {
  if (state.status?.state === "blocked") return state.status.code;
  if (!authority.fullGm) return "full-gm-required";
  if (!authority.authoritative) return "authoritative-gm-required";
  return null;
}

function recoveryOverview(state) {
  const authority = state.authority ?? {};
  const canonicalId = String(state.canonicalId ?? "");
  const candidates = Object.freeze(
    (state.candidates ?? []).map((candidate) =>
      safeCandidate(candidate, canonicalId),
    ),
  );
  const snapshotAvailable = Boolean(state.snapshot?.complete);
  const recoveryNeeded = state.status?.state === "blocked";
  const canMutate =
    authority.fullGm === true &&
    authority.authoritative === true &&
    recoveryNeeded;
  return Object.freeze({
    status: safeStatus(state.status),
    fullGm: authority.fullGm === true,
    authoritative: authority.authoritative === true,
    canonicalId,
    canonicalState: canonicalState(canonicalId, state.candidates ?? []),
    candidates,
    snapshotAvailable,
    canMutate,
    canRecoverSnapshot: canMutate && snapshotAvailable && recoveryNeeded,
    canCreateEmpty: canMutate && recoveryNeeded,
    blockedReason: blockedReason(state, authority),
  });
}

function authorityFence(state) {
  const authority = state.authority ?? {};
  if (!authority.fullGm) {
    throw recoveryError(
      "PRIVATE_STATE_RECOVERY_FULL_GM_REQUIRED",
      "PrivateStateRecoveryFullGmRequired",
    );
  }
  if (!authority.authoritative || !authority.userId) {
    throw recoveryError(
      "PRIVATE_STATE_RECOVERY_AUTHORITY_REQUIRED",
      "PrivateStateRecoveryAuthorityRequired",
    );
  }
  return Object.freeze({
    userId: String(authority.userId),
    leadershipGeneration: Number.isSafeInteger(authority.leadershipGeneration)
      ? authority.leadershipGeneration
      : null,
  });
}

function assertSameAuthority(state, fence) {
  const current = authorityFence(state);
  if (
    current.userId !== fence.userId ||
    (fence.leadershipGeneration !== null &&
      current.leadershipGeneration !== fence.leadershipGeneration)
  ) {
    throw recoveryError(
      "PRIVATE_STATE_RECOVERY_AUTHORITY_CHANGED",
      "PrivateStateRecoveryAuthorityChanged",
    );
  }
}

function candidateById(state, candidateId) {
  const id = String(candidateId ?? "").trim();
  return (
    (state.candidates ?? []).find((candidate) => candidate.id === id) ?? null
  );
}

function candidateMaterials(state) {
  return Object.fromEntries(
    [...(state.candidates ?? [])]
      .sort((left, right) => String(left.id).localeCompare(String(right.id)))
      .map((candidate) => [
        String(candidate.id),
        canonicalizePrivateStateRecoveryValue(candidate.fingerprintInput),
      ]),
  );
}

function contextInput(state) {
  return {
    canonicalId: String(state.canonicalId ?? ""),
    candidates: Object.fromEntries(
      Object.entries(candidateMaterials(state)).map(([id, material]) => [
        id,
        JSON.parse(material),
      ]),
    ),
  };
}

function unchangedCandidateMaterials(expected, state, { allowIds = [] } = {}) {
  const current = candidateMaterials(state);
  const allowed = new Set(allowIds.map(String));
  for (const [id, material] of Object.entries(expected)) {
    if (current[id] !== material) return false;
  }
  return Object.keys(current).every(
    (id) => Object.hasOwn(expected, id) || allowed.has(id),
  );
}

function assertRecoveryNeeded(state, kind) {
  const overview = recoveryOverview(state);
  const allowed =
    kind === "snapshot" ? overview.canRecoverSnapshot : overview.canCreateEmpty;
  if (!allowed) {
    throw recoveryError(
      "PRIVATE_STATE_RECOVERY_NOT_AVAILABLE",
      `PrivateStateRecoveryNotAvailable:${kind}`,
    );
  }
}

/** Dependency-injected live service; exported for focused node tests. */
export function createPrivateStateRecoveryService(
  bindings,
  {
    now = () => Date.now(),
    randomToken = defaultRandomToken,
    digest = defaultDigest,
    ttlMs = DEFAULT_TOKEN_TTL_MS,
  } = {},
) {
  if (!bindings || typeof bindings.captureState !== "function") {
    throw new TypeError("Private-state recovery requires captureState");
  }
  const intents = new Map();
  let applyInFlight = false;

  function pruneIntents() {
    const timestamp = now();
    for (const [token, intent] of intents) {
      if (intent.expiresAt <= timestamp) intents.delete(token);
    }
  }

  function issueToken() {
    const token = randomToken();
    if (typeof token !== "string" || token.length < 43) {
      throw recoveryError(
        "PRIVATE_STATE_RECOVERY_TOKEN_INVALID",
        "PrivateStateRecoveryTokenInvalid",
      );
    }
    return token;
  }

  function createIntent(
    kind,
    fence,
    fields = {},
    { confirmation = false } = {},
  ) {
    pruneIntents();
    const token = issueToken();
    const confirmationToken = confirmation ? issueToken() : null;
    if (intents.has(token) || confirmationToken === token) {
      throw recoveryError(
        "PRIVATE_STATE_RECOVERY_TOKEN_INVALID",
        "PrivateStateRecoveryTokenInvalid",
      );
    }
    const expiresAt = now() + ttlMs;
    intents.set(token, {
      kind,
      fence,
      expiresAt,
      confirmationToken,
      ...fields,
    });
    return { token, confirmationToken, expiresAt };
  }

  function consumeIntent(kind, input) {
    const token = String(input?.token ?? "");
    const intent = intents.get(token);
    if (!intent) {
      throw recoveryError(
        "PRIVATE_STATE_RECOVERY_PREVIEW_INVALID",
        "PrivateStateRecoveryPreviewInvalid",
      );
    }
    intents.delete(token);
    if (intent.kind !== kind) {
      throw recoveryError(
        "PRIVATE_STATE_RECOVERY_PREVIEW_INVALID",
        "PrivateStateRecoveryPreviewInvalid",
      );
    }
    if (intent.expiresAt <= now()) {
      throw recoveryError(
        "PRIVATE_STATE_RECOVERY_PREVIEW_EXPIRED",
        "PrivateStateRecoveryPreviewExpired",
      );
    }
    if (
      intent.confirmationToken !== null &&
      String(input?.confirmationToken ?? "") !== intent.confirmationToken
    ) {
      throw recoveryError(
        "PRIVATE_STATE_RECOVERY_CONFIRMATION_INVALID",
        "PrivateStateRecoveryConfirmationInvalid",
      );
    }
    return intent;
  }

  async function fingerprintsForState(state, candidateId = null) {
    const candidate = candidateId ? candidateById(state, candidateId) : null;
    const contextMaterial = contextInput(state);
    const candidateMaterial = candidate?.fingerprintInput ?? null;
    const [contextFingerprint, documentFingerprint] = await Promise.all([
      fingerprintPrivateStateRecoveryValue(contextMaterial, { digest }),
      candidateMaterial
        ? fingerprintPrivateStateRecoveryValue(candidateMaterial, { digest })
        : Promise.resolve(null),
    ]);
    return {
      contextFingerprint,
      documentFingerprint,
      candidateMaterials: candidateMaterials(state),
    };
  }

  async function getOverview() {
    return recoveryOverview(bindings.captureState());
  }

  async function previewAdoption(candidateId) {
    const state = bindings.captureState();
    const fence = authorityFence(state);
    if (state.status?.state !== "blocked") {
      throw recoveryError(
        "PRIVATE_STATE_RECOVERY_NOT_AVAILABLE",
        "PrivateStateRecoveryNotAvailable:adoption",
      );
    }
    const candidate = candidateById(state, candidateId);
    const safe = candidate ? safeCandidate(candidate, state.canonicalId) : null;
    if (!candidate || !safe.eligible || safe.canonical) {
      throw recoveryError(
        "PRIVATE_STATE_RECOVERY_CANDIDATE_INELIGIBLE",
        `PrivateStateRecoveryCandidateIneligible:${safe?.reason ?? "missing"}`,
      );
    }
    const fingerprints = await fingerprintsForState(state, candidate.id);
    const afterHash = bindings.captureState();
    assertSameAuthority(afterHash, fence);
    const candidateAfterHash = candidateById(afterHash, candidate.id);
    if (
      afterHash.status?.state !== "blocked" ||
      String(afterHash.canonicalId ?? "") === candidate.id ||
      !candidateAfterHash ||
      candidateReason(candidateAfterHash) !== null ||
      canonicalizePrivateStateRecoveryValue(contextInput(afterHash)) !==
        canonicalizePrivateStateRecoveryValue(contextInput(state)) ||
      canonicalizePrivateStateRecoveryValue(
        candidateAfterHash.fingerprintInput,
      ) !== canonicalizePrivateStateRecoveryValue(candidate.fingerprintInput)
    ) {
      throw recoveryError(
        "PRIVATE_STATE_RECOVERY_CONTEXT_CHANGED",
        "PrivateStateRecoveryContextChanged",
      );
    }
    const intent = createIntent("adoption", fence, {
      candidateId: candidate.id,
      canonicalId: String(state.canonicalId ?? ""),
      ...fingerprints,
      payloadMaterial: canonicalizePrivateStateRecoveryValue(candidate.payload),
    });
    return Object.freeze({
      token: intent.token,
      expiresAt: intent.expiresAt,
      candidate: safe,
      canonicalId: String(state.canonicalId ?? ""),
      warningCode: "adopt-existing-private-state-store",
    });
  }

  async function withApply(operation) {
    if (applyInFlight) {
      throw recoveryError(
        "PRIVATE_STATE_RECOVERY_BUSY",
        "PrivateStateRecoveryBusy",
      );
    }
    applyInFlight = true;
    try {
      return await operation();
    } finally {
      applyInFlight = false;
    }
  }

  function assertIntentContext(intent, state) {
    assertSameAuthority(state, intent.fence);
    if (String(state.canonicalId ?? "") !== intent.canonicalId) {
      throw recoveryError(
        "PRIVATE_STATE_RECOVERY_CONTEXT_CHANGED",
        "PrivateStateRecoveryContextChanged",
      );
    }
    if (!unchangedCandidateMaterials(intent.candidateMaterials, state)) {
      throw recoveryError(
        "PRIVATE_STATE_RECOVERY_CONTEXT_CHANGED",
        "PrivateStateRecoveryContextChanged",
      );
    }
  }

  async function applyAdoption(input) {
    const intent = consumeIntent("adoption", input);
    return withApply(async () => {
      let state = bindings.captureState();
      assertIntentContext(intent, state);
      if (
        state.status?.state !== "blocked" ||
        String(state.canonicalId ?? "") === intent.candidateId
      ) {
        throw recoveryError(
          "PRIVATE_STATE_RECOVERY_NOT_AVAILABLE",
          "PrivateStateRecoveryNotAvailable:adoption",
        );
      }
      let candidate = candidateById(state, intent.candidateId);
      if (!candidate || candidateReason(candidate) !== null) {
        throw recoveryError(
          "PRIVATE_STATE_RECOVERY_CANDIDATE_INELIGIBLE",
          "PrivateStateRecoveryCandidateIneligible",
        );
      }
      const documentFingerprint = await fingerprintPrivateStateRecoveryValue(
        candidate.fingerprintInput,
        { digest },
      );
      state = bindings.captureState();
      assertIntentContext(intent, state);
      assertSameAuthority(state, intent.fence);
      if (documentFingerprint !== intent.documentFingerprint) {
        throw recoveryError(
          "PRIVATE_STATE_RECOVERY_CONTEXT_CHANGED",
          "PrivateStateRecoveryContextChanged",
        );
      }

      bindings.setManualRecoveryTarget(intent.candidateId);
      try {
        state = bindings.captureState();
        assertIntentContext(intent, state);
        if (
          state.status?.state !== "blocked" ||
          String(state.canonicalId ?? "") === intent.candidateId
        ) {
          throw recoveryError(
            "PRIVATE_STATE_RECOVERY_NOT_AVAILABLE",
            "PrivateStateRecoveryNotAvailable:adoption",
          );
        }
        await bindings.setCanonicalId(intent.candidateId);
        state = bindings.captureState();
        assertSameAuthority(state, intent.fence);
        if (String(state.canonicalId ?? "") !== intent.candidateId) {
          throw recoveryError(
            "PRIVATE_STATE_RECOVERY_CANONICAL_READBACK_FAILED",
            "PrivateStateRecoveryCanonicalReadbackFailed",
          );
        }
        candidate = candidateById(state, intent.candidateId);
        if (
          !candidate ||
          candidateReason(candidate) !== null ||
          canonicalizePrivateStateRecoveryValue(candidate.payload) !==
            intent.payloadMaterial
        ) {
          throw recoveryError(
            "PRIVATE_STATE_RECOVERY_CANDIDATE_CHANGED",
            "PrivateStateRecoveryCandidateChanged",
          );
        }
        await bindings.hydrateCanonical(intent.candidateId);
        state = bindings.captureState();
        assertSameAuthority(state, intent.fence);
        candidate = candidateById(state, intent.candidateId);
        if (
          String(state.canonicalId ?? "") !== intent.candidateId ||
          state.status?.state !== "ready" ||
          candidate?.schemaState !== "current" ||
          candidateReason(candidate) !== null ||
          canonicalizePrivateStateRecoveryValue(candidate.payload) !==
            intent.payloadMaterial
        ) {
          throw recoveryError(
            "PRIVATE_STATE_RECOVERY_READBACK_FAILED",
            "PrivateStateRecoveryReadbackFailed",
          );
        }
      } finally {
        bindings.clearManualRecoveryTarget(intent.candidateId);
      }
      return Object.freeze({
        ok: true,
        kind: "candidate-adoption",
        canonicalId: intent.candidateId,
        status: safeStatus(bindings.captureState().status),
      });
    });
  }

  async function previewCreation(kind) {
    const state = bindings.captureState();
    const fence = authorityFence(state);
    assertRecoveryNeeded(state, kind);
    const fingerprints = await fingerprintsForState(state);
    const payload =
      kind === "snapshot" ? state.snapshot?.payload : bindings.typedDefaults();
    if (!payload || (kind === "snapshot" && !state.snapshot?.complete)) {
      throw recoveryError(
        "PRIVATE_STATE_RECOVERY_NOT_AVAILABLE",
        `PrivateStateRecoveryNotAvailable:${kind}`,
      );
    }
    const payloadFingerprint = await fingerprintPrivateStateRecoveryValue(
      payload,
      { digest },
    );
    const afterHash = bindings.captureState();
    assertSameAuthority(afterHash, fence);
    assertRecoveryNeeded(afterHash, kind);
    if (
      canonicalizePrivateStateRecoveryValue(contextInput(afterHash)) !==
        canonicalizePrivateStateRecoveryValue(contextInput(state)) ||
      (kind === "snapshot" &&
        canonicalizePrivateStateRecoveryValue(afterHash.snapshot) !==
          canonicalizePrivateStateRecoveryValue(state.snapshot))
    ) {
      throw recoveryError(
        "PRIVATE_STATE_RECOVERY_CONTEXT_CHANGED",
        "PrivateStateRecoveryContextChanged",
      );
    }
    const sourceId =
      kind === "snapshot" ? String(state.snapshot?.sourceId ?? "") : null;
    const intent = createIntent(
      kind,
      fence,
      {
        canonicalId: String(state.canonicalId ?? ""),
        ...fingerprints,
        payloadFingerprint,
        payloadMaterial: canonicalizePrivateStateRecoveryValue(payload),
        sourceId,
      },
      { confirmation: true },
    );
    return Object.freeze({
      token: intent.token,
      confirmationToken: intent.confirmationToken,
      expiresAt: intent.expiresAt,
      ...(sourceId ? { sourceId } : {}),
      canonicalId: String(state.canonicalId ?? ""),
      warningCode:
        kind === "snapshot"
          ? "restore-last-verified-private-state-snapshot"
          : "create-empty-private-state-store",
    });
  }

  async function applyCreation(kind, input) {
    const intent = consumeIntent(kind, input);
    return withApply(async () => {
      let state = bindings.captureState();
      assertIntentContext(intent, state);
      assertRecoveryNeeded(state, kind);
      const payload =
        kind === "snapshot"
          ? state.snapshot?.payload
          : bindings.typedDefaults();
      if (
        !payload ||
        (kind === "snapshot" &&
          String(state.snapshot?.sourceId ?? "") !== intent.sourceId) ||
        canonicalizePrivateStateRecoveryValue(payload) !==
          intent.payloadMaterial
      ) {
        throw recoveryError(
          "PRIVATE_STATE_RECOVERY_CONTEXT_CHANGED",
          "PrivateStateRecoveryContextChanged",
        );
      }
      const payloadFingerprint = await fingerprintPrivateStateRecoveryValue(
        payload,
        { digest },
      );
      state = bindings.captureState();
      assertIntentContext(intent, state);
      assertRecoveryNeeded(state, kind);
      if (payloadFingerprint !== intent.payloadFingerprint) {
        throw recoveryError(
          "PRIVATE_STATE_RECOVERY_CONTEXT_CHANGED",
          "PrivateStateRecoveryContextChanged",
        );
      }

      const recoverySource = Object.freeze({
        version: 1,
        kind: kind === "snapshot" ? "verified-snapshot" : "empty-replacement",
        sourceId: intent.sourceId,
        sourceFingerprint: intent.payloadFingerprint,
        createdAt: now(),
      });
      state = bindings.captureState();
      assertIntentContext(intent, state);
      const createdId = await bindings.createRecoveryDocument({
        payload,
        recoverySource,
      });
      state = bindings.captureState();
      assertSameAuthority(state, intent.fence);
      if (
        !createdId ||
        String(state.canonicalId ?? "") !== intent.canonicalId ||
        !unchangedCandidateMaterials(intent.candidateMaterials, state, {
          allowIds: [createdId],
        })
      ) {
        throw recoveryError(
          "PRIVATE_STATE_RECOVERY_CREATE_FAILED",
          "PrivateStateRecoveryCreateFailed",
        );
      }
      const created = candidateById(state, createdId);
      if (
        !created ||
        created.schemaState !== "current" ||
        candidateReason(created) !== null ||
        canonicalizePrivateStateRecoveryValue(created.payload) !==
          intent.payloadMaterial
      ) {
        throw recoveryError(
          "PRIVATE_STATE_RECOVERY_CREATE_VERIFICATION_FAILED",
          "PrivateStateRecoveryCreateVerificationFailed",
        );
      }

      bindings.setManualRecoveryTarget(createdId);
      try {
        state = bindings.captureState();
        assertSameAuthority(state, intent.fence);
        assertRecoveryNeeded(state, kind);
        if (String(state.canonicalId ?? "") !== intent.canonicalId) {
          throw recoveryError(
            "PRIVATE_STATE_RECOVERY_CONTEXT_CHANGED",
            "PrivateStateRecoveryContextChanged",
          );
        }
        const beforeSet = candidateById(state, createdId);
        if (
          !beforeSet ||
          candidateReason(beforeSet) !== null ||
          canonicalizePrivateStateRecoveryValue(beforeSet.payload) !==
            intent.payloadMaterial
        ) {
          throw recoveryError(
            "PRIVATE_STATE_RECOVERY_CANDIDATE_CHANGED",
            "PrivateStateRecoveryCandidateChanged",
          );
        }
        await bindings.setCanonicalId(createdId);
        state = bindings.captureState();
        assertSameAuthority(state, intent.fence);
        if (String(state.canonicalId ?? "") !== createdId) {
          throw recoveryError(
            "PRIVATE_STATE_RECOVERY_CANONICAL_READBACK_FAILED",
            "PrivateStateRecoveryCanonicalReadbackFailed",
          );
        }
        const afterSet = candidateById(state, createdId);
        if (
          !afterSet ||
          candidateReason(afterSet) !== null ||
          canonicalizePrivateStateRecoveryValue(afterSet.payload) !==
            intent.payloadMaterial
        ) {
          throw recoveryError(
            "PRIVATE_STATE_RECOVERY_CANDIDATE_CHANGED",
            "PrivateStateRecoveryCandidateChanged",
          );
        }
        await bindings.hydrateCanonical(createdId);
        state = bindings.captureState();
        assertSameAuthority(state, intent.fence);
        const hydrated = candidateById(state, createdId);
        if (
          String(state.canonicalId ?? "") !== createdId ||
          state.status?.state !== "ready" ||
          hydrated?.schemaState !== "current" ||
          candidateReason(hydrated) !== null ||
          canonicalizePrivateStateRecoveryValue(hydrated.payload) !==
            intent.payloadMaterial
        ) {
          throw recoveryError(
            "PRIVATE_STATE_RECOVERY_READBACK_FAILED",
            "PrivateStateRecoveryReadbackFailed",
          );
        }
      } finally {
        bindings.clearManualRecoveryTarget(createdId);
      }
      return Object.freeze({
        ok: true,
        kind: kind === "snapshot" ? "snapshot-recovery" : "empty-replacement",
        canonicalId: createdId,
        status: safeStatus(bindings.captureState().status),
      });
    });
  }

  return Object.freeze({
    getOverview,
    previewAdoption,
    applyAdoption,
    previewSnapshot: () => previewCreation("snapshot"),
    applySnapshot: (input) => applyCreation("snapshot", input),
    previewEmpty: () => previewCreation("empty"),
    applyEmpty: (input) => applyCreation("empty", input),
    reset() {
      intents.clear();
      applyInFlight = false;
    },
  });
}

/** Install the live Foundry adapter once private-state internals are defined. */
export function configurePrivateStateRecoveryService(bindings, options = {}) {
  liveService = createPrivateStateRecoveryService(bindings, options);
  return liveService;
}

function configuredService() {
  if (!liveService) {
    throw recoveryError(
      "PRIVATE_STATE_RECOVERY_NOT_CONFIGURED",
      "PrivateStateRecoveryNotConfigured",
    );
  }
  return liveService;
}

export async function getPrivateStateRecoveryOverview() {
  return configuredService().getOverview();
}

export async function previewPrivateStateCandidateAdoption(candidateId) {
  return configuredService().previewAdoption(candidateId);
}

export async function applyPrivateStateCandidateAdoption(input) {
  return configuredService().applyAdoption(input);
}

export async function previewPrivateStateSnapshotRecovery() {
  return configuredService().previewSnapshot();
}

export async function applyPrivateStateSnapshotRecovery(input) {
  return configuredService().applySnapshot(input);
}

export async function previewEmptyPrivateStateReplacement() {
  return configuredService().previewEmpty();
}

export async function applyEmptyPrivateStateReplacement(input) {
  return configuredService().applyEmpty(input);
}

export function resetPrivateStateRecoveryServiceForTests() {
  liveService?.reset();
}
