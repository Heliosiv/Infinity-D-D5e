import assert from "node:assert/strict";

import {
  CAMPAIGN_TAB_LEADERSHIP_HOOK,
  createCampaignTabLeadership,
  ensureCampaignTabLeadership,
  getCampaignTabLeadershipStatus,
  hasCampaignTabLeadership,
  releaseCampaignTabLeadership,
} from "./campaign-tab-leadership.js";
import {
  createMerchantTabLeadership,
  ensureMerchantTabLeadership,
  getMerchantTabLeadershipStatus,
  hasMerchantTabLeadership,
  MERCHANT_TAB_LEADERSHIP_HOOK,
  releaseMerchantTabLeadership,
} from "./merchant/tab-leadership.js";

class FakeLocks {
  constructor() {
    this.held = new Set();
    this.names = [];
    this.queues = new Map();
  }

  request(name, options, callback) {
    this.names.push(name);
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

function leadership(factory, locks, scope, overrides = {}) {
  return factory({
    locks,
    getScope: () => scope,
    requiresLeadership: () => true,
    waitMs: 5,
    ...overrides,
  });
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// Merchant compatibility names are direct aliases to the shared implementation
// and, crucially, the same singleton rather than a second Merchant-only owner.
assert.equal(createMerchantTabLeadership, createCampaignTabLeadership);
assert.equal(ensureMerchantTabLeadership, ensureCampaignTabLeadership);
assert.equal(hasMerchantTabLeadership, hasCampaignTabLeadership);
assert.equal(getMerchantTabLeadershipStatus, getCampaignTabLeadershipStatus);
assert.equal(releaseMerchantTabLeadership, releaseCampaignTabLeadership);
assert.equal(
  MERCHANT_TAB_LEADERSHIP_HOOK,
  "infinity-dnd5e.merchantTabLeadership",
);

{
  const locks = new FakeLocks();
  const campaign = leadership(
    createCampaignTabLeadership,
    locks,
    "world-a:gm-a",
  );
  const merchantAlias = leadership(
    createMerchantTabLeadership,
    locks,
    "world-a:gm-a",
  );

  assert.equal(await campaign.ensureLeadership(), true);
  assert.equal(campaign.status().generation, 1);
  assert.equal(await merchantAlias.ensureLeadership(), false);
  assert.deepEqual(locks.names, [
    "infinity-dnd5e:merchant-authority:world-a:gm-a",
    "infinity-dnd5e:merchant-authority:world-a:gm-a",
  ]);

  campaign.releaseLeadership();
  await tick();
  assert.equal(merchantAlias.hasLeadership(), true);
  merchantAlias.releaseLeadership();
}

{
  const notifications = [];
  const priorHooks = globalThis.Hooks;
  globalThis.Hooks = {
    callAll: (hook, status) => notifications.push({ hook, status }),
  };
  try {
    const shared = leadership(
      createCampaignTabLeadership,
      new FakeLocks(),
      "world-b:gm-a",
    );
    assert.equal(await shared.ensureLeadership(), true);
    assert.ok(
      notifications.some(
        ({ hook, status }) =>
          hook === CAMPAIGN_TAB_LEADERSHIP_HOOK && status.state === "leader",
      ),
    );
    assert.ok(
      notifications.some(
        ({ hook, status }) =>
          hook === MERCHANT_TAB_LEADERSHIP_HOOK && status.state === "leader",
      ),
    );
    shared.releaseLeadership();
  } finally {
    if (priorHooks === undefined) delete globalThis.Hooks;
    else globalThis.Hooks = priorHooks;
  }
}

{
  let loseLease;
  let acquireCount = 0;
  const leaseNames = [];
  const leaseManager = {
    async acquire(name, { onLost }) {
      acquireCount += 1;
      leaseNames.push(name);
      let held = true;
      loseLease = () => {
        held = false;
        onLost?.();
      };
      return {
        isHeld: () => held,
        renew: async () => held,
        release: async () => {
          held = false;
          return true;
        },
      };
    },
  };
  const fallbackEvents = [];
  const fallback = leadership(
    createCampaignTabLeadership,
    null,
    "world-c:gm-b",
    {
      leaseManager,
      notify: (status) => fallbackEvents.push(status),
    },
  );

  assert.equal(await fallback.ensureLeadership(), true);
  assert.equal(fallback.status().generation, 1);
  loseLease();
  assert.equal(fallback.status().state, "lost");
  assert.equal(fallback.status().generation, 1);
  assert.ok(fallbackEvents.some((status) => status.state === "lost"));

  assert.equal(await fallback.ensureLeadership(), true);
  assert.equal(fallback.status().generation, 2);
  assert.equal(acquireCount, 2);
  assert.deepEqual(leaseNames, [
    "infinity-dnd5e:merchant-authority:world-c:gm-b",
    "infinity-dnd5e:merchant-authority:world-c:gm-b",
  ]);
  fallback.releaseLeadership();
}

process.stdout.write("campaign tab leadership validation passed\n");
