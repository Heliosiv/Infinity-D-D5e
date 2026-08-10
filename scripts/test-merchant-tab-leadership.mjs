import assert from "node:assert/strict";

import { createMerchantTabLeadership } from "./merchant/tab-leadership.js";

class FakeLocks {
  constructor() {
    this.held = new Set();
    this.queues = new Map();
  }

  request(name, options, callback) {
    return new Promise((resolve, reject) => {
      const entry = { callback, resolve, reject, signal: options?.signal };
      const queue = this.queues.get(name) ?? [];
      queue.push(entry);
      this.queues.set(name, queue);
      entry.signal?.addEventListener?.(
        "abort",
        () => {
          const pending = this.queues.get(name) ?? [];
          const index = pending.indexOf(entry);
          if (index >= 0) pending.splice(index, 1);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        },
        { once: true },
      );
      this.#pump(name);
    });
  }

  #pump(name) {
    if (this.held.has(name)) return;
    const queue = this.queues.get(name) ?? [];
    const entry = queue.shift();
    if (!entry) return;
    if (entry.signal?.aborted) {
      this.#pump(name);
      return;
    }
    this.held.add(name);
    Promise.resolve(entry.callback({ name, mode: "exclusive" })).then(
      (value) => {
        this.held.delete(name);
        entry.resolve(value);
        this.#pump(name);
      },
      (error) => {
        this.held.delete(name);
        entry.reject(error);
        this.#pump(name);
      },
    );
  }
}

function leadership(locks, scope, notifications = []) {
  return createMerchantTabLeadership({
    locks,
    getScope: () => scope,
    requiresLeadership: () => true,
    waitMs: 5,
    notify: (status) => notifications.push(status),
  });
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

{
  const locks = new FakeLocks();
  const firstEvents = [];
  const secondEvents = [];
  const first = leadership(locks, "world-a:gm-a", firstEvents);
  const second = leadership(locks, "world-a:gm-a", secondEvents);

  assert.equal(await first.ensureLeadership(), true);
  assert.equal(first.hasLeadership(), true);
  assert.equal(await second.ensureLeadership(), false);
  assert.equal(second.hasLeadership(), false);
  assert.equal(second.status().state, "waiting");

  first.releaseLeadership();
  await tick();
  assert.equal(second.hasLeadership(), true);
  assert.equal(second.status().state, "leader");
  assert.ok(firstEvents.some((event) => event.state === "leader"));
  assert.ok(secondEvents.some((event) => event.state === "leader"));
  second.releaseLeadership();
}

{
  const locks = new FakeLocks();
  const worldA = leadership(locks, "world-a:gm-a");
  const worldB = leadership(locks, "world-b:gm-a");
  assert.equal(await worldA.ensureLeadership(), true);
  assert.equal(await worldB.ensureLeadership(), true);
  worldA.releaseLeadership();
  worldB.releaseLeadership();
}

{
  let held = true;
  let renewCalls = 0;
  const leaseManager = {
    async acquire(_name, { onLost }) {
      return {
        isHeld: () => held,
        async renew() {
          renewCalls++;
          return held;
        },
        async release() {
          held = false;
          onLost?.();
          return true;
        },
      };
    },
  };
  const fallback = createMerchantTabLeadership({
    locks: null,
    leaseManager,
    getScope: () => "world-a:gm-a",
    requiresLeadership: () => true,
    waitMs: 5,
  });
  assert.equal(await fallback.ensureLeadership(), true);
  assert.equal(await fallback.ensureLeadership(), true);
  assert.equal(renewCalls, 1, "each later write preflight renews ownership");
  held = false;
  assert.equal(fallback.hasLeadership(), false);
  assert.equal(fallback.status().state, "lost");
}

{
  const unavailable = createMerchantTabLeadership({
    locks: null,
    getScope: () => "world-a:gm-a",
    requiresLeadership: () => true,
  });
  assert.equal(await unavailable.ensureLeadership(), false);
  assert.equal(unavailable.hasLeadership(), false);
  assert.equal(unavailable.status().state, "unavailable");
}

{
  const nodeFallback = createMerchantTabLeadership({
    locks: null,
    requiresLeadership: () => false,
  });
  assert.equal(await nodeFallback.ensureLeadership(), true);
  assert.equal(nodeFallback.hasLeadership(), true);
}

process.stdout.write("merchant tab leadership validation passed\n");
