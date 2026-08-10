import assert from "node:assert/strict";

import { createBrowserLeaseManager } from "./browser-lock.js";

function makeAtomicStore() {
  const records = new Map();
  let chain = Promise.resolve();
  const atomicUpdate = (name, transform) => {
    const operation = chain.then(() => {
      const current = records.has(name)
        ? structuredClone(records.get(name))
        : null;
      const decision = transform(current) ?? { value: undefined };
      if (Object.hasOwn(decision, "next")) {
        if (decision.next === null) records.delete(name);
        else records.set(name, structuredClone(decision.next));
      }
      return structuredClone(decision.value);
    });
    chain = operation.catch(() => {});
    return operation;
  };
  return { atomicUpdate, records };
}

function makeCountingAbortSignal() {
  const listeners = new Set();
  let added = 0;
  return {
    signal: {
      aborted: false,
      addEventListener(type, listener) {
        if (type !== "abort") return;
        added += 1;
        listeners.add(listener);
      },
      removeEventListener(type, listener) {
        if (type === "abort") listeners.delete(listener);
      },
    },
    listenerCount: () => listeners.size,
    addedCount: () => added,
  };
}

{
  const store = makeAtomicStore();
  let token = 0;
  const manager = createBrowserLeaseManager({
    atomicUpdate: store.atomicUpdate,
    randomToken: () => `owner-${++token}`,
    delay: async () => {},
    schedule: null,
    cancel: null,
  });
  const first = await manager.acquire("shared", { ttlMs: 1000 });
  assert.equal(first.isHeld(), true);
  assert.equal(
    await manager.acquire("shared", {
      ttlMs: 1000,
      timeoutMs: 1,
      retryMs: 1,
    }),
    null,
  );
  assert.equal(await first.release(), true);
  const second = await manager.acquire("shared", { ttlMs: 1000 });
  assert.equal(second.isHeld(), true);
  await second.release();
}

{
  const store = makeAtomicStore();
  let token = 0;
  let time = 0;
  let attempts = 0;
  const manager = createBrowserLeaseManager({
    atomicUpdate: async (...args) => {
      const result = await store.atomicUpdate(...args);
      attempts += 1;
      if (attempts > 1) time += 1;
      return result;
    },
    now: () => time,
    randomToken: () => `owner-${++token}`,
    schedule: null,
    cancel: null,
  });
  const first = await manager.acquire("retry-listeners", { ttlMs: 1000 });
  const counting = makeCountingAbortSignal();
  assert.equal(
    await manager.acquire("retry-listeners", {
      ttlMs: 1000,
      retryMs: 1,
      timeoutMs: 4,
      signal: counting.signal,
    }),
    null,
  );
  assert.ok(
    counting.addedCount() > 1,
    "the failed acquisition should exercise multiple retry delays",
  );
  assert.equal(
    counting.listenerCount(),
    0,
    "completed retry delays must not retain abort listeners",
  );
  await first.release();
}

{
  const store = makeAtomicStore();
  let time = 10_000;
  let token = 0;
  const manager = createBrowserLeaseManager({
    atomicUpdate: store.atomicUpdate,
    now: () => time,
    randomToken: () => `owner-${++token}`,
    delay: async () => {},
    schedule: null,
    cancel: null,
  });
  const expired = await manager.acquire("expiring", { ttlMs: 1000 });
  time += 1001;
  const replacement = await manager.acquire("expiring", { ttlMs: 1000 });
  assert.equal(expired.isHeld(), false);
  assert.equal(replacement.isHeld(), true);
  assert.equal(
    await expired.release(),
    false,
    "an expired owner cannot delete its replacement's lease",
  );
  assert.equal(store.records.get("expiring").owner, replacement.owner);
  await replacement.release();
}

{
  const store = makeAtomicStore();
  let time = 20_000;
  const manager = createBrowserLeaseManager({
    atomicUpdate: store.atomicUpdate,
    now: () => time,
    randomToken: () => "owner-stale",
    delay: async () => {},
    schedule: null,
    cancel: null,
  });
  const lease = await manager.acquire("stale-renew", { ttlMs: 1000 });
  time += 1001;
  assert.equal(
    await lease.renew(),
    false,
    "an expired lease cannot silently renew after a background-tab pause",
  );
  assert.equal(lease.isHeld(), false);
}

{
  const store = makeAtomicStore();
  let token = 0;
  const manager = createBrowserLeaseManager({
    atomicUpdate: store.atomicUpdate,
    randomToken: () => `owner-${++token}`,
    delay: async () => {},
    schedule: null,
    cancel: null,
  });
  const trace = [];
  const result = await manager.withLease("operation", async (lease) => {
    trace.push(lease.isHeld());
    return 42;
  });
  assert.deepEqual(result, { acquired: true, value: 42 });
  assert.deepEqual(trace, [true]);
  assert.equal(store.records.has("operation"), false);
}

process.stdout.write("browser lock validation passed\n");
