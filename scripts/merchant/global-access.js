/**
 * Persistent global merchant-access state.
 *
 * Individual merchants keep their own self-service mode. This state acts as a
 * world-wide gate above those modes and stores the live merchant/viewer pairs
 * that should be restored after a temporary global closure.
 */

import { getPrivateState, setPrivateState } from "../private-state.js";
import { isAuthoritativeGM } from "../socket-authority.js";
import { assertSupportedPersistedVersion } from "../utils/persisted-data.js";
import {
  ensureMerchantTabLeadership,
  hasMerchantTabLeadership,
} from "./tab-leadership.js";

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
    ...(Array.isArray(raw.locations)
      ? {
          locations: raw.locations
            .filter(
              (row, index, rows) =>
                toId(row?.id) &&
                toId(row?.name) &&
                rows.findIndex((other) => toId(other?.id) === toId(row.id)) ===
                  index,
            )
            .map((row) => ({
              id: toId(row.id),
              name: toId(row.name).slice(0, 100),
            })),
        }
      : {}),
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
  if (!isAuthoritativeGM() || !hasMerchantTabLeadership()) return false;
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

function merchantAccessAuthorityError() {
  const error = new Error(
    "Merchant access can only be changed by the active Merchant tab.",
  );
  error.code = "MERCHANT_ACCESS_AUTHORITY_UNAVAILABLE";
  return error;
}

async function saveMerchantAccessStateAuthorized(normalized) {
  if (
    isFoundryEnvironment() &&
    (!isAuthoritativeGM() ||
      (await ensureMerchantTabLeadership()) !== true ||
      !hasMerchantTabLeadership())
  ) {
    throw merchantAccessAuthorityError();
  }
  return await setPrivateState(MERCHANT_ACCESS_STATE_KEY, normalized, {
    beforeWrite: assertLiveMerchantAccessWritable,
    afterWrite: assertLiveMerchantAccessWritable,
  });
}

/** Persist global access through the same restricted store as merchant data. */
export function saveMerchantAccessState(value) {
  // Treat callers as patches. Global close/reopen must not discard locations,
  // and adding a location must not restore a stale global access flag.
  const save = () =>
    saveMerchantAccessStateAuthorized(
      normalizeMerchantAccessState({ ...loadMerchantAccessState(), ...value }),
    );
  const result = accessWriteChain.then(save, save);
  accessWriteChain = result.catch(() => {});
  return result.then(normalizeMerchantAccessState);
}

export function addMerchantLocation(location) {
  const save = () => {
    const current = loadMerchantAccessState();
    const locations = current.locations ?? [];
    if (
      locations.some(
        (row) =>
          row.name.toLocaleLowerCase() === location.name.toLocaleLowerCase(),
      )
    ) {
      throw new Error("That location already exists. Select it to add shops.");
    }
    return saveMerchantAccessStateAuthorized(
      normalizeMerchantAccessState({
        ...current,
        locations: [...locations, location],
      }),
    );
  };
  const result = accessWriteChain.then(save, save);
  accessWriteChain = result.catch(() => {});
  return result;
}

/** Apply catalogue edits against fresh access state without overwriting gates. */
export function updateMerchantLocations(mutator) {
  const save = () => {
    const current = loadMerchantAccessState();
    return saveMerchantAccessStateAuthorized(
      normalizeMerchantAccessState({
        ...current,
        locations: mutator(current.locations ?? []),
      }),
    );
  };
  const result = accessWriteChain.then(save, save);
  accessWriteChain = result.catch(() => {});
  return result;
}
