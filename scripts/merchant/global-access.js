/**
 * Persistent global merchant-access state.
 *
 * Individual merchants keep their own self-service mode. This state acts as a
 * world-wide gate above those modes and stores the live merchant/viewer pairs
 * that should be restored after a temporary global closure.
 */

import { getPrivateState, setPrivateState } from "../private-state.js";
import { assertSupportedPersistedVersion } from "../utils/persisted-data.js";

const MODULE_ID = "infinity-dnd5e";
export const MERCHANT_ACCESS_STATE_KEY = "merchantAccess";
export const MERCHANT_ACCESS_STATE_VERSION = 1;

function toId(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeSuspendedMerchantSessions(value) {
  const rows = Array.isArray(value) ? value : [];
  const seen = new Set();
  const normalized = [];
  for (const row of rows) {
    const merchantId = toId(row?.merchantId);
    const viewerUserId = toId(row?.viewerUserId);
    if (!merchantId || !viewerUserId) continue;
    const key = `${merchantId}::${viewerUserId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ merchantId, viewerUserId });
  }
  return normalized;
}

export function normalizeMerchantAccessState(value) {
  const raw =
    value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    version: MERCHANT_ACCESS_STATE_VERSION,
    closed: raw.closed === true,
    suspendedSessions: normalizeSuspendedMerchantSessions(
      raw.suspendedSessions,
    ),
  };
}

function isFoundryEnvironment() {
  return Boolean(globalThis.game && globalThis.JournalEntry?.create);
}

function lockedMerchantAccessState() {
  return {
    version: MERCHANT_ACCESS_STATE_VERSION,
    closed: true,
    suspendedSessions: [],
  };
}

function assertSupportedMerchantAccessState(value) {
  if (!isFoundryEnvironment()) return;
  assertSupportedPersistedVersion(value?.version, {
    domain: "merchant-access",
    supportedVersion: MERCHANT_ACCESS_STATE_VERSION,
    codePrefix: "MERCHANT_ACCESS",
  });
}

function assertLiveMerchantAccessWritable() {
  if (!isFoundryEnvironment()) return true;
  const persisted = getPrivateState(MERCHANT_ACCESS_STATE_KEY);
  if (persisted === undefined) return false;
  assertSupportedMerchantAccessState(persisted);
  return true;
}

/**
 * Load the private canonical state.
 *
 * A live Foundry client without a hydrated private store must behave as locked;
 * only Node harnesses without JournalEntry use the settings fallback.
 */
export function loadMerchantAccessState() {
  const privateValue = getPrivateState(MERCHANT_ACCESS_STATE_KEY);
  if (privateValue !== undefined) {
    try {
      assertSupportedMerchantAccessState(privateValue);
    } catch (error) {
      if (error?.persistedVersionStatus?.state === "blocked") {
        return lockedMerchantAccessState();
      }
      throw error;
    }
    return normalizeMerchantAccessState(privateValue);
  }
  if (isFoundryEnvironment()) return lockedMerchantAccessState();
  try {
    return normalizeMerchantAccessState(
      globalThis.game?.settings?.get?.(MODULE_ID, MERCHANT_ACCESS_STATE_KEY),
    );
  } catch {
    return normalizeMerchantAccessState(null);
  }
}

export function isMerchantAccessClosed() {
  return loadMerchantAccessState().closed;
}

let accessWriteChain = Promise.resolve();

/** Persist global access through the same restricted store as merchant data. */
export function saveMerchantAccessState(value) {
  const normalized = normalizeMerchantAccessState(value);
  const result = accessWriteChain.then(
    () =>
      setPrivateState(MERCHANT_ACCESS_STATE_KEY, normalized, {
        beforeWrite: assertLiveMerchantAccessWritable,
      }),
    () =>
      setPrivateState(MERCHANT_ACCESS_STATE_KEY, normalized, {
        beforeWrite: assertLiveMerchantAccessWritable,
      }),
  );
  accessWriteChain = result.catch(() => {});
  return result.then(normalizeMerchantAccessState);
}
