/**
 * Same-browser leadership for authoritative Merchant writes.
 *
 * Foundry elects a user, not a browser tab. Two tabs signed in as that same GM
 * therefore look equally authoritative to sockets and document permissions.
 * A long-held Web Lock gives exactly one tab in this browser permission to run
 * Merchant writes. Cross-device concurrency remains a documented Foundry/CAS
 * limitation and is still fenced by the persisted transaction epoch/readback.
 */

import { browserLeaseManager } from "../browser-lock.js";

const MODULE_ID = "infinity-dnd5e";
export const MERCHANT_TAB_LEADERSHIP_HOOK =
  "infinity-dnd5e.merchantTabLeadership";
const DEFAULT_DECISION_WAIT_MS = 25;
const DEFAULT_FALLBACK_LEASE_TTL_MS = 30_000;

export function createMerchantTabLeadership({
  locks = globalThis.navigator?.locks,
  leaseManager = browserLeaseManager,
  getScope = defaultScope,
  requiresLeadership = defaultRequiresLeadership,
  waitMs = DEFAULT_DECISION_WAIT_MS,
  setTimer = globalThis.setTimeout?.bind(globalThis),
  clearTimer = globalThis.clearTimeout?.bind(globalThis),
  notify = defaultNotify,
} = {}) {
  let request = null;

  function status() {
    return Object.freeze({
      required: request?.required === true,
      state: request?.state ?? "idle",
      scope: request?.scope ?? null,
      leader: request?.state === "leader",
    });
  }

  function hasLeadership() {
    if (!requiresLeadership()) return true;
    if (request?.state !== "leader") return false;
    if (request.lease && request.lease.isHeld?.() !== true) {
      markLost(request);
      return false;
    }
    return true;
  }

  async function ensureLeadership() {
    if (!requiresLeadership()) return true;
    const scope = normalizeScope(getScope());
    if (!scope) {
      replaceRequest(null);
      request = { required: true, state: "unavailable", scope: null };
      notify(status());
      return false;
    }
    if (
      request?.scope !== scope ||
      request?.state === "lost" ||
      request?.state === "released"
    ) {
      startRequest(scope);
    }
    if (request?.state === "leader") {
      if (!request.lease) return true;
      const current = request;
      const renewed = await current.lease.renew?.();
      if (
        renewed !== true ||
        request !== current ||
        current.state !== "leader" ||
        current.lease.isHeld?.() !== true
      ) {
        markLost(current);
        return false;
      }
      return true;
    }
    if (!request?.acquired) return false;
    return await waitForDecision(request);
  }

  function releaseLeadership() {
    replaceRequest(null);
    notify(status());
    return true;
  }

  function startRequest(scope) {
    replaceRequest(null);
    const hasWebLocks = typeof locks?.request === "function";
    const hasLeaseFallback = typeof leaseManager?.acquire === "function";
    if (!hasWebLocks && !hasLeaseFallback) {
      request = { required: true, state: "unavailable", scope };
      notify(status());
      return;
    }

    let resolveAcquired;
    let releaseHold;
    const acquired = new Promise((resolve) => {
      resolveAcquired = resolve;
    });
    const hold = new Promise((resolve) => {
      releaseHold = resolve;
    });
    const abortController =
      typeof globalThis.AbortController === "function"
        ? new globalThis.AbortController()
        : null;
    const current = {
      required: true,
      state: "waiting",
      scope,
      acquired,
      resolveAcquired,
      releaseHold,
      abortController,
      requestPromise: null,
      lease: null,
    };
    request = current;
    notify(status());

    if (hasWebLocks) startWebLockRequest(current, hold);
    else startLeaseRequest(current);

    function startWebLockRequest(target, held) {
      const options = { mode: "exclusive" };
      if (abortController) options.signal = abortController.signal;
      try {
        target.requestPromise = Promise.resolve(
          locks.request(lockName(scope), options, async (lock) => {
            if (request !== target || !lock) {
              target.resolveAcquired(false);
              return false;
            }
            target.state = "leader";
            target.resolveAcquired(true);
            notify(status());
            await held;
            if (request === target) {
              target.state = "released";
              notify(status());
            }
            return true;
          }),
        ).catch(() => markUnavailable(target));
      } catch {
        markUnavailable(target);
      }
    }

    function startLeaseRequest(target) {
      target.requestPromise = Promise.resolve(
        leaseManager.acquire(lockName(scope), {
          ttlMs: DEFAULT_FALLBACK_LEASE_TTL_MS,
          signal: abortController?.signal ?? null,
          onLost: () => {
            markLost(target);
          },
        }),
      ).then(
        async (lease) => {
          if (request !== target || !lease) {
            await lease?.release?.();
            target.resolveAcquired(false);
            return false;
          }
          target.lease = lease;
          target.state = "leader";
          target.resolveAcquired(true);
          notify(status());
          return true;
        },
        () => markUnavailable(target),
      );
    }

    function markUnavailable(target) {
      target.resolveAcquired(false);
      if (request === target) {
        target.state = "unavailable";
        notify(status());
      }
      return false;
    }
  }

  async function waitForDecision(current) {
    if (
      !Number.isFinite(waitMs) ||
      waitMs <= 0 ||
      typeof setTimer !== "function"
    ) {
      return current.state === "leader";
    }
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimer(() => resolve(false), waitMs);
    });
    const result = await Promise.race([current.acquired, timeout]);
    if (timer != null && typeof clearTimer === "function") clearTimer(timer);
    return result === true && request === current && current.state === "leader";
  }

  function markLost(target) {
    if (request !== target || target.state === "lost") return;
    target.state = "lost";
    notify(status());
  }

  function replaceRequest(next) {
    const prior = request;
    request = next;
    if (!prior) return;
    try {
      prior.abortController?.abort?.();
    } catch {}
    try {
      prior.releaseHold?.();
    } catch {}
    try {
      void prior.lease?.release?.();
    } catch {}
    prior.resolveAcquired?.(false);
  }

  return Object.freeze({
    ensureLeadership,
    hasLeadership,
    releaseLeadership,
    status,
  });
}

function defaultRequiresLeadership() {
  return Boolean(
    globalThis.window?.document &&
    globalThis.game &&
    globalThis.game?.user?.isGM === true &&
    globalThis.JournalEntry?.create,
  );
}

function defaultScope() {
  const worldId = cleanId(globalThis.game?.world?.id);
  const userId = cleanId(globalThis.game?.user?.id);
  return worldId && userId ? `${worldId}:${userId}` : null;
}

function normalizeScope(value) {
  const scope = typeof value === "string" ? value.trim() : "";
  return scope && scope.length <= 512 ? scope : null;
}

function cleanId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  return id && id.length <= 240 ? id : null;
}

function lockName(scope) {
  return `${MODULE_ID}:merchant-authority:${scope}`;
}

function defaultNotify(value) {
  globalThis.Hooks?.callAll?.(MERCHANT_TAB_LEADERSHIP_HOOK, value);
}

const merchantTabLeadership = createMerchantTabLeadership();

export function ensureMerchantTabLeadership() {
  return merchantTabLeadership.ensureLeadership();
}

export function hasMerchantTabLeadership() {
  return merchantTabLeadership.hasLeadership();
}

export function getMerchantTabLeadershipStatus() {
  return merchantTabLeadership.status();
}

export function releaseMerchantTabLeadership() {
  return merchantTabLeadership.releaseLeadership();
}
