/**
 * Cross-tab browser lease with an IndexedDB atomic-update backend.
 *
 * Web Locks are unavailable on ordinary HTTP/LAN Foundry pages. IndexedDB
 * readwrite transactions are serialized across tabs and remain available in
 * that topology, so they provide the fallback mutual-exclusion primitive.
 */

const MODULE_ID = "infinity-dnd5e";
const DATABASE_NAME = `${MODULE_ID}-browser-locks`;
const STORE_NAME = "leases";
const DATABASE_VERSION = 1;
const DEFAULT_TTL_MS = 6000;
const DEFAULT_RETRY_MS = 100;

export function createBrowserLeaseManager({
  atomicUpdate = createIndexedDbAtomicUpdate(),
  now = () => Date.now(),
  randomToken = createRandomToken,
  delay = defaultDelay,
  schedule = globalThis.setTimeout?.bind(globalThis),
  cancel = globalThis.clearTimeout?.bind(globalThis),
} = {}) {
  async function acquire(
    rawName,
    {
      ttlMs = DEFAULT_TTL_MS,
      retryMs = DEFAULT_RETRY_MS,
      timeoutMs = Number.POSITIVE_INFINITY,
      signal = null,
      onLost = null,
    } = {},
  ) {
    const name = normalizeName(rawName);
    const ttl = positiveInteger(ttlMs, "ttlMs");
    const retry = positiveInteger(retryMs, "retryMs");
    const startedAt = now();
    const owner = randomToken();

    while (!signal?.aborted) {
      const acquired = await atomicUpdate(name, (current) => {
        const time = now();
        if (
          current &&
          current.owner !== owner &&
          Number.isFinite(current.expiresAt) &&
          current.expiresAt > time
        ) {
          return { value: false };
        }
        const next = { name, owner, expiresAt: time + ttl };
        return { next, value: next };
      });
      if (acquired) {
        return createLeaseHandle({
          name,
          owner,
          initial: acquired,
          ttl,
          atomicUpdate,
          now,
          schedule,
          cancel,
          onLost,
        });
      }
      if (Number.isFinite(timeoutMs) && now() - startedAt >= timeoutMs) {
        return null;
      }
      await delay(retry, signal);
    }
    return null;
  }

  async function withLease(name, operation, options = {}) {
    if (typeof operation !== "function") {
      throw new TypeError("Browser lease operation must be a function");
    }
    const lease = await acquire(name, options);
    if (!lease) return { acquired: false, value: undefined };
    try {
      return { acquired: true, value: await operation(lease) };
    } finally {
      await lease.release();
    }
  }

  return Object.freeze({ acquire, withLease });
}

function createLeaseHandle({
  name,
  owner,
  initial,
  ttl,
  atomicUpdate,
  now,
  schedule,
  cancel,
  onLost,
}) {
  let held = true;
  let expiresAt = initial.expiresAt;
  let timer = null;
  const interval = Math.max(250, Math.floor(ttl / 3));

  const lose = () => {
    if (!held) return;
    held = false;
    if (timer != null && typeof cancel === "function") cancel(timer);
    timer = null;
    try {
      onLost?.();
    } catch {}
  };

  const renew = async () => {
    if (!held) return false;
    try {
      const renewed = await atomicUpdate(name, (current) => {
        const time = now();
        if (
          !current ||
          current.owner !== owner ||
          !Number.isFinite(current.expiresAt) ||
          current.expiresAt <= time
        ) {
          return { value: false };
        }
        const next = { name, owner, expiresAt: time + ttl };
        return { next, value: next };
      });
      if (!renewed) {
        lose();
        return false;
      }
      expiresAt = renewed.expiresAt;
      arm();
      return true;
    } catch {
      lose();
      return false;
    }
  };

  const arm = () => {
    if (!held || typeof schedule !== "function") return;
    if (timer != null && typeof cancel === "function") cancel(timer);
    timer = schedule(() => {
      timer = null;
      void renew();
    }, interval);
  };

  const release = async () => {
    if (!held) return false;
    held = false;
    if (timer != null && typeof cancel === "function") cancel(timer);
    timer = null;
    try {
      return await atomicUpdate(name, (current) =>
        current?.owner === owner
          ? { next: null, value: true }
          : { value: false },
      );
    } catch {
      return false;
    }
  };

  arm();
  return Object.freeze({
    name,
    owner,
    isHeld: () => held && now() < expiresAt,
    renew,
    release,
  });
}

/**
 * Create the IndexedDB atomic update primitive. The transform executes inside
 * one readwrite transaction; another tab cannot interleave a lease decision.
 */
export function createIndexedDbAtomicUpdate({
  indexedDBInstance = globalThis.indexedDB,
  databaseName = DATABASE_NAME,
  storeName = STORE_NAME,
} = {}) {
  let databasePromise = null;

  function openDatabase() {
    if (!indexedDBInstance?.open) {
      return Promise.reject(new Error("BrowserLockIndexedDbUnavailable"));
    }
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDBInstance.open(databaseName, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(storeName)) {
          database.createObjectStore(storeName, { keyPath: "name" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error("BrowserLockOpenFailed"));
      request.onblocked = () => reject(new Error("BrowserLockOpenBlocked"));
    }).catch((error) => {
      databasePromise = null;
      throw error;
    });
    return databasePromise;
  }

  return async function atomicUpdate(name, transform) {
    if (typeof transform !== "function") {
      throw new TypeError("Browser lock transform must be a function");
    }
    const database = await openDatabase();
    return await new Promise((resolve, reject) => {
      let decision;
      const transaction = database.transaction(storeName, "readwrite");
      const store = transaction.objectStore(storeName);
      const read = store.get(name);
      read.onsuccess = () => {
        try {
          decision = transform(read.result ?? null) ?? { value: undefined };
          if (Object.hasOwn(decision, "next")) {
            if (decision.next === null) store.delete(name);
            else store.put(decision.next);
          }
        } catch (error) {
          try {
            transaction.abort();
          } catch {}
          reject(error);
        }
      };
      read.onerror = () => {
        try {
          transaction.abort();
        } catch {}
        reject(read.error ?? new Error("BrowserLockReadFailed"));
      };
      transaction.oncomplete = () => resolve(decision?.value);
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("BrowserLockTransactionFailed"));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("BrowserLockTransactionAborted"));
    });
  };
}

function normalizeName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > 1024)
    throw new TypeError("Invalid browser lease name");
  return name;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function createRandomToken() {
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues !== "function") {
    throw new Error("BrowserLockRandomUnavailable");
  }
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function defaultDelay(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let settled = false;
    let timer = null;
    const settle = (clearTimer = false) => {
      if (settled) return;
      settled = true;
      if (clearTimer && timer != null) globalThis.clearTimeout?.(timer);
      timer = null;
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    };
    const onAbort = () => settle(true);
    timer = globalThis.setTimeout?.(() => settle(), ms);
    signal?.addEventListener?.("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export const browserLeaseManager = createBrowserLeaseManager();

export function acquireBrowserLease(name, options) {
  return browserLeaseManager.acquire(name, options);
}

export function withBrowserLease(name, operation, options) {
  return browserLeaseManager.withLease(name, operation, options);
}
