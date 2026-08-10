import assert from "node:assert/strict";

import {
  getPrivateState,
  initializePrivateState,
  resetPrivateStateForTests,
  setPrivateState,
} from "./private-state.js";
import {
  commitMerchantWrite,
  MERCHANT_EVENTS,
  receiveMerchantPayload,
  subscribe,
} from "./merchant/socket.js";
import {
  clearAllSessions,
  closeSession,
  getBargain,
  openSession,
  recordBargain,
} from "./merchant/session-state.js";
import { merchantTransactionCoordinator } from "./merchant/transaction-coordinator.js";
import {
  buildMerchantTransactionKey,
  merchantCommitRequestFingerprint,
} from "./merchant/transaction-ledger.js";
import { normalizeMerchant } from "./merchant/store.js";

const MODULE_ID = "infinity-dnd5e";
const saved = {
  game: globalThis.game,
  ui: globalThis.ui,
  Hooks: globalThis.Hooks,
  CONST: globalThis.CONST,
  JournalEntry: globalThis.JournalEntry,
  fromUuid: globalThis.fromUuid,
};

const clone = (value) => structuredClone(value);

function commitId(seed) {
  const numeric = 10_000 + seed;
  return `m1.${numeric.toString(36)}.${numeric.toString(16).padStart(32, "0")}`;
}

function makeHooks() {
  let nextId = 0;
  const handlers = new Map();
  return {
    on(event, callback) {
      const id = ++nextId;
      if (!handlers.has(event)) handlers.set(event, new Map());
      handlers.get(event).set(id, callback);
      return id;
    },
    off(event, id) {
      handlers.get(event)?.delete(id);
    },
    call(event, ...args) {
      for (const callback of handlers.get(event)?.values() ?? []) {
        callback(...args);
      }
    },
  };
}

function makeEmbeddedItem(actor, input) {
  const source = clone(input);
  source._id = String(source._id ?? source.id ?? "");
  delete source.id;
  return {
    parent: actor,
    get id() {
      return source._id;
    },
    get _id() {
      return source._id;
    },
    get name() {
      return source.name;
    },
    get type() {
      return source.type;
    },
    get system() {
      return source.system;
    },
    get flags() {
      return source.flags;
    },
    toObject() {
      return clone(source);
    },
    async update(patch) {
      if (Object.hasOwn(patch, "system.quantity")) {
        source.system.quantity = Number(patch["system.quantity"]);
      }
      return this;
    },
  };
}

function makeActor(id, ownerId) {
  const items = new Map();
  const actor = {
    id,
    uuid: `Actor.${id}`,
    name: `${ownerId} Hero`,
    type: "character",
    ownership: { [ownerId]: 3 },
    system: { currency: { pp: 0, gp: 100, ep: 0, sp: 0, cp: 0 } },
    items,
    createCalls: 0,
    afterNextCreate: null,
    noApplyCreates: false,
    testUserPermission(user) {
      return user?.id === ownerId;
    },
    async update(patch) {
      for (const [path, value] of Object.entries(patch ?? {})) {
        const match = /^system\.currency\.(pp|gp|ep|sp|cp)$/.exec(path);
        if (match) this.system.currency[match[1]] = Number(value);
      }
      return this;
    },
    async createEmbeddedDocuments(_type, sources) {
      this.createCalls += 1;
      const created = [];
      if (!this.noApplyCreates) {
        for (const source of sources) {
          const item = makeEmbeddedItem(this, source);
          items.set(item.id, item);
          created.push(item);
        }
      }
      const afterCreate = this.afterNextCreate;
      this.afterNextCreate = null;
      afterCreate?.();
      return created;
    },
    async deleteEmbeddedDocuments(_type, ids) {
      for (const itemId of ids) items.delete(itemId);
      return ids;
    },
  };
  actor.seedItem = (source) => {
    const item = makeEmbeddedItem(actor, source);
    items.set(item.id, item);
    return item;
  };
  return actor;
}

function makeMerchant(id, userId, itemUuid) {
  return normalizeMerchant({
    id,
    name: `${id} Shop`,
    defaultMarkup: 0,
    sellRatio: 0.5,
    passiveHaggle: false,
    goldOnHand: 100,
    allowedUserIds: [userId],
    selfServiceMode: "open",
    items: [
      {
        uuid: itemUuid,
        qty: 5,
        startingQty: 5,
        unlimited: false,
        priceOverrideGp: 10,
      },
    ],
  });
}

function makeFrame({ userId, sessionId, itemUuid, id, qty = 1 }) {
  return {
    type: MERCHANT_EVENTS.COMMIT_PURCHASE,
    originUserId: userId,
    sessionId,
    actorId: `actor-${userId}`,
    itemUuid,
    qty,
    totalGp: qty * 10,
    commitId: id,
  };
}

try {
  resetPrivateStateForTests();
  clearAllSessions();
  globalThis.Hooks = makeHooks();
  globalThis.CONST = {
    DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, OWNER: 3 },
    USER_ROLES: { GAMEMASTER: 4 },
  };

  const gm = { id: "gm", isGM: true, role: 4, active: true, name: "GM" };
  const playerIds = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9"];
  const actors = new Map(
    playerIds.map((userId) => [
      `actor-${userId}`,
      makeActor(`actor-${userId}`, userId),
    ]),
  );
  const users = new Map([
    [gm.id, gm],
    ...playerIds.map((userId) => [
      userId,
      {
        id: userId,
        isGM: false,
        active: true,
        name: userId,
        character: actors.get(`actor-${userId}`),
      },
    ]),
  ]);
  const itemByUser = Object.fromEntries(
    playerIds.map((userId) => [
      userId,
      `Compendium.infinity-dnd5e.items.Item.${userId}`,
    ]),
  );
  actors.get("actor-p7").seedItem({
    _id: "sale-item-p7",
    name: "Silver Cup",
    type: "loot",
    system: {
      quantity: 1,
      price: { value: 20, denomination: "gp" },
    },
    flags: {},
  });
  const flags = {
    privateStateStore: true,
    schemaVersion: 7,
    merchants: ["p1", "p2", "p3", "p6", "p7", "p8", "p9"].map((userId) =>
      makeMerchant(`shop-${userId}`, userId, itemByUser[userId]),
    ),
    merchantTransactions: {
      version: 1,
      revision: 0,
      authorityId: null,
      authorityEpoch: null,
      writeToken: null,
      replayFloors: [],
      records: [],
    },
    merchantAccess: {},
    factions: [],
    resourceConfig: {},
    resourceRunState: {},
    criticalInjuryWorkflow: {},
    criticalInjuryWorkflowCheckpoint: {},
    downtimeConfig: {},
    downtimeWorkflow: {},
    downtimeWorkflowCheckpoint: {},
  };
  const store = {
    id: "durable-merchant-store",
    ownership: { default: 0 },
    updateCalls: [],
    throwAfterPreparedCommitId: null,
    pauseBeforePreparedCommitId: null,
    onBeforePreparedPaused: null,
    resumeBeforePreparedWrite: null,
    pauseAfterPreparedCommitId: null,
    onPreparedPaused: null,
    resumePreparedWrite: null,
    getFlag(scope, key) {
      return scope === MODULE_ID ? flags[key] : undefined;
    },
    async update(patch) {
      if (
        this.pauseBeforePreparedCommitId &&
        patch[`flags.${MODULE_ID}.merchantTransactions`]?.records?.some(
          (record) =>
            record.commitId === this.pauseBeforePreparedCommitId &&
            record.stage === "prepared",
        )
      ) {
        this.pauseBeforePreparedCommitId = null;
        this.onBeforePreparedPaused?.();
        await this.resumeBeforePreparedWrite;
        this.onBeforePreparedPaused = null;
        this.resumeBeforePreparedWrite = null;
      }
      this.updateCalls.push(clone(patch));
      for (const [path, value] of Object.entries(patch)) {
        const match = /^flags\.infinity-dnd5e\.(.+)$/.exec(path);
        if (match) flags[match[1]] = clone(value);
      }
      globalThis.Hooks.call("updateJournalEntry", this, patch);
      if (
        this.pauseAfterPreparedCommitId &&
        flags.merchantTransactions?.records?.some(
          (record) =>
            record.commitId === this.pauseAfterPreparedCommitId &&
            record.stage === "prepared",
        )
      ) {
        this.pauseAfterPreparedCommitId = null;
        this.onPreparedPaused?.();
        await this.resumePreparedWrite;
        this.onPreparedPaused = null;
        this.resumePreparedWrite = null;
      }
      if (
        this.throwAfterPreparedCommitId &&
        flags.merchantTransactions?.records?.some(
          (record) =>
            record.commitId === this.throwAfterPreparedCommitId &&
            record.stage === "prepared",
        )
      ) {
        this.throwAfterPreparedCommitId = null;
        throw new Error("injected prepared checkpoint apply-then-throw");
      }
      return this;
    },
  };
  const notices = [];
  globalThis.ui = {
    notifications: {
      info() {},
      warn() {},
      error(message) {
        notices.push(String(message));
      },
    },
  };
  globalThis.game = {
    ready: true,
    user: gm,
    users: {
      get activeGM() {
        return gm.active && gm.isGM ? gm : null;
      },
      get: (id) => users.get(id) ?? null,
      forEach: (callback) => users.forEach(callback),
      filter: (predicate) => [...users.values()].filter(predicate),
    },
    actors: {
      get: (id) => actors.get(id) ?? null,
      find: (predicate) => [...actors.values()].find(predicate) ?? null,
    },
    journal: { find: (predicate) => (predicate(store) ? store : null) },
    settings: {
      get(_moduleId, key) {
        if (key === "privateStateStoreId") return store.id;
        if (key === "merchants" || key === "factions") return [];
        return {};
      },
      async set() {
        throw new Error("live fixture must use the canonical Journal");
      },
    },
    socket: { emit() {}, on() {} },
  };
  globalThis.JournalEntry = {
    async create() {
      throw new Error("canonical Journal should be reused");
    },
  };
  globalThis.fromUuid = async (uuid) => ({
    _id: String(uuid).split(".").at(-1),
    name: "Trail Ration",
    type: "consumable",
    system: {
      quantity: 1,
      price: { value: 10, denomination: "gp" },
    },
    flags: {},
    toObject() {
      return {
        _id: this._id,
        name: this.name,
        type: this.type,
        system: clone(this.system),
        flags: {},
      };
    },
  });

  assert.equal(await initializePrivateState(), true);
  await merchantTransactionCoordinator.register();
  const results = [];
  const unsubscribe = subscribe(MERCHANT_EVENTS.COMMIT_RESULT, (payload) =>
    results.push(payload),
  );

  // Live Foundry rejects the old arbitrary IDs instead of entering the
  // rollback-based compatibility path.
  await receiveMerchantPayload(
    makeFrame({
      userId: "p1",
      sessionId: "missing-session",
      itemUuid: itemByUser.p1,
      id: "legacy-id",
    }),
    "p1",
  );
  assert.equal(results.at(-1)?.reason, "invalid-commit-id");
  assert.equal(getPrivateState("merchantTransactions").records.length, 0);

  const resultCountBeforeOversizedIdentity = results.length;
  await receiveMerchantPayload(
    {
      ...makeFrame({
        userId: "p1",
        sessionId: "missing-session",
        itemUuid: itemByUser.p1,
        id: commitId(90),
      }),
      actorId: "a".repeat(201),
      sealId: "s".repeat(201),
    },
    "p1",
  );
  assert.equal(
    results.length,
    resultCountBeforeOversizedIdentity,
    "oversized fingerprint fields are dropped before lookup or reply",
  );
  assert.equal(getPrivateState("merchantTransactions").records.length, 0);

  // A canonical request commits once, survives session loss, and replays its
  // exact terminal result without a second Actor or Merchant mutation.
  const p1Session = openSession({
    merchantId: "shop-p1",
    viewerUserId: "p1",
  });
  const p1Frame = makeFrame({
    userId: "p1",
    sessionId: p1Session.sessionId,
    itemUuid: itemByUser.p1,
    id: commitId(1),
  });
  await receiveMerchantPayload(p1Frame, "p1");
  assert.equal(results.at(-1)?.ok, true);
  assert.equal(actors.get("actor-p1").system.currency.gp, 90);
  assert.equal(
    flags.merchants.find((entry) => entry.id === "shop-p1").items[0].qty,
    4,
  );
  const p1CreateCalls = actors.get("actor-p1").createCalls;
  closeSession(p1Session.sessionId);
  await receiveMerchantPayload(p1Frame, "p1");
  assert.equal(
    results.at(-1)?.ok,
    true,
    "terminal replay ignores session loss",
  );
  assert.equal(actors.get("actor-p1").system.currency.gp, 90);
  assert.equal(actors.get("actor-p1").createCalls, p1CreateCalls);
  await receiveMerchantPayload({ ...p1Frame, qty: 2, totalGp: 20 }, "p1");
  assert.equal(
    results.at(-1)?.reason,
    "commit-id-conflict",
    "fingerprint conflict wins before missing-session validation",
  );

  // A queued GM edit cannot slip between the durable prepared checkpoint and
  // the first canonical drive. The player trade completes under the existing
  // merchant+actor lock, then the edit reads and preserves that result.
  const p1AtomicSession = openSession({
    merchantId: "shop-p1",
    viewerUserId: "p1",
  });
  const p1AtomicFrame = makeFrame({
    userId: "p1",
    sessionId: p1AtomicSession.sessionId,
    itemUuid: itemByUser.p1,
    id: commitId(91),
  });
  let signalPreparedPaused;
  const preparedPaused = new Promise((resolve) => {
    signalPreparedPaused = resolve;
  });
  let resumePreparedWrite;
  store.resumePreparedWrite = new Promise((resolve) => {
    resumePreparedWrite = resolve;
  });
  store.pauseAfterPreparedCommitId = p1AtomicFrame.commitId;
  store.onPreparedPaused = signalPreparedPaused;
  const p1AtomicTrade = receiveMerchantPayload(p1AtomicFrame, "p1");
  await preparedPaused;
  const p1AtomicEdit = commitMerchantWrite("shop-p1", (merchant) => ({
    ...merchant,
    name: `${merchant.name} (edited)`,
  }));
  resumePreparedWrite();
  await Promise.all([p1AtomicTrade, p1AtomicEdit]);
  const p1AtomicMerchant = getPrivateState("merchants").find(
    (merchant) => merchant.id === "shop-p1",
  );
  const p1AtomicRecord = getPrivateState("merchantTransactions").records.find(
    (record) => record.commitId === p1AtomicFrame.commitId,
  );
  assert.equal(results.at(-1)?.commitId, p1AtomicFrame.commitId);
  assert.equal(results.at(-1)?.ok, true);
  assert.equal(p1AtomicRecord?.stage, "terminal");
  assert.equal(p1AtomicMerchant?.items[0].qty, 3);
  assert.equal(p1AtomicMerchant?.goldOnHand, 120);
  assert.equal(p1AtomicMerchant?.name.endsWith("(edited)"), true);
  assert.equal(actors.get("actor-p1").system.currency.gp, 80);

  // If a first handler's prepared write applies and then throws, an exact
  // duplicate already queued behind it must drive that checkpoint before a GM
  // edit queued third. The duplicate must not release and reacquire the lock.
  const p1DuplicateFrame = makeFrame({
    userId: "p1",
    sessionId: p1AtomicSession.sessionId,
    itemUuid: itemByUser.p1,
    id: commitId(92),
  });
  let signalBeforePreparedPaused;
  const beforePreparedPaused = new Promise((resolve) => {
    signalBeforePreparedPaused = resolve;
  });
  let resumeBeforePreparedWrite;
  store.resumeBeforePreparedWrite = new Promise((resolve) => {
    resumeBeforePreparedWrite = resolve;
  });
  store.pauseBeforePreparedCommitId = p1DuplicateFrame.commitId;
  store.onBeforePreparedPaused = signalBeforePreparedPaused;
  store.throwAfterPreparedCommitId = p1DuplicateFrame.commitId;
  const p1FirstAttempt = receiveMerchantPayload(p1DuplicateFrame, "p1");
  await beforePreparedPaused;
  const p1ExactDuplicate = receiveMerchantPayload(p1DuplicateFrame, "p1");
  // Let the duplicate pass its initial missing lookup and queue on the held
  // merchant lock before the GM edit enters that same queue third.
  await new Promise((resolve) => setImmediate(resolve));
  const p1QueuedEdit = commitMerchantWrite("shop-p1", (merchant) => ({
    ...merchant,
    name: `${merchant.name} (replayed)`,
  }));
  const p1CreatesBeforeDuplicate = actors.get("actor-p1").createCalls;
  const p1ResultsBeforeDuplicate = results.length;
  resumeBeforePreparedWrite();
  await Promise.all([p1FirstAttempt, p1ExactDuplicate, p1QueuedEdit]);
  const p1DuplicateMerchant = getPrivateState("merchants").find(
    (merchant) => merchant.id === "shop-p1",
  );
  const p1DuplicateRecord = getPrivateState(
    "merchantTransactions",
  ).records.find((record) => record.commitId === p1DuplicateFrame.commitId);
  assert.equal(results.length, p1ResultsBeforeDuplicate + 1);
  assert.equal(results.at(-1)?.commitId, p1DuplicateFrame.commitId);
  assert.equal(results.at(-1)?.ok, true);
  assert.equal(p1DuplicateRecord?.stage, "terminal");
  assert.equal(p1DuplicateMerchant?.items[0].qty, 2);
  assert.equal(p1DuplicateMerchant?.goldOnHand, 130);
  assert.equal(p1DuplicateMerchant?.name.endsWith("(replayed)"), true);
  assert.equal(actors.get("actor-p1").system.currency.gp, 70);
  assert.equal(
    actors.get("actor-p1").createCalls,
    p1CreatesBeforeDuplicate + 1,
  );

  const p7Session = openSession({
    merchantId: "shop-p7",
    viewerUserId: "p7",
  });
  const p7Frame = {
    type: MERCHANT_EVENTS.COMMIT_SALE,
    originUserId: "p7",
    sessionId: p7Session.sessionId,
    actorId: "actor-p7",
    itemUuid: "sale-item-p7",
    qty: 1,
    totalGp: 10,
    commitId: commitId(7),
  };
  await receiveMerchantPayload(
    { ...p7Frame, commitId: commitId(77), totalGp: 9 },
    "p7",
  );
  assert.equal(results.at(-1)?.ok, false);
  assert.equal(results.at(-1)?.reason, "price-changed");
  assert.ok(actors.get("actor-p7").items.get("sale-item-p7"));
  assert.equal(
    flags.merchants.find((entry) => entry.id === "shop-p7").goldOnHand,
    100,
  );
  await receiveMerchantPayload(p7Frame, "p7");
  assert.equal(results.at(-1)?.ok, true);
  assert.equal(results.at(-1)?.side, "sell");
  assert.equal(actors.get("actor-p7").system.currency.gp, 110);
  assert.equal(actors.get("actor-p7").items.get("sale-item-p7"), undefined);
  assert.equal(
    flags.merchants.find((entry) => entry.id === "shop-p7").goldOnHand,
    90,
  );

  const p8Session = openSession({
    merchantId: "shop-p8",
    viewerUserId: "p8",
  });
  const p8Seal = recordBargain(p8Session.sessionId, {
    itemUuid: itemByUser.p8,
    side: "buy",
    tier: { id: "success" },
    deltaPct: -10,
  });
  const p8Frames = [81, 82].map((seed) => ({
    ...makeFrame({
      userId: "p8",
      sessionId: p8Session.sessionId,
      itemUuid: itemByUser.p8,
      id: commitId(seed),
    }),
    totalGp: 9,
    sealId: p8Seal.sealId,
  }));
  for (const frame of p8Frames) {
    await receiveMerchantPayload(frame, "p8");
  }
  const p8Results = results.filter((result) =>
    p8Frames.some((frame) => frame.commitId === result.commitId),
  );
  assert.equal(
    p8Results.filter((result) => result.sealId === p8Seal.sealId).length,
    1,
    "the bargain seal is applied to exactly one durable purchase",
  );
  assert.equal(
    p8Results.find((result) => result.ok === false)?.reason,
    "bargain-expired",
    "a consumed bargain is rejected instead of silently repricing at base",
  );
  assert.equal(actors.get("actor-p8").system.currency.gp, 91);

  // A prepared checkpoint may apply canonically and still reject. Reserve the
  // one-use bargain for that exact durable identity before the await, then burn
  // it when canonical replay proves the record exists. A second commit cannot
  // spend the same seal.
  const p8AmbiguousSession = openSession({
    merchantId: "shop-p8",
    viewerUserId: "p8",
  });
  const p8AmbiguousSeal = recordBargain(p8AmbiguousSession.sessionId, {
    itemUuid: itemByUser.p8,
    side: "buy",
    tier: { id: "success" },
    deltaPct: -10,
  });
  const p8AmbiguousFrame = {
    ...makeFrame({
      userId: "p8",
      sessionId: p8AmbiguousSession.sessionId,
      itemUuid: itemByUser.p8,
      id: commitId(83),
    }),
    totalGp: 9,
    sealId: p8AmbiguousSeal.sealId,
  };
  const p8WalletBeforeAmbiguous = actors.get("actor-p8").system.currency.gp;
  const p8StockBeforeAmbiguous = flags.merchants.find(
    (entry) => entry.id === "shop-p8",
  ).items[0].qty;
  const p8CreatesBeforeAmbiguous = actors.get("actor-p8").createCalls;
  const p8ResultsBeforeAmbiguous = results.length;
  store.throwAfterPreparedCommitId = p8AmbiguousFrame.commitId;
  await receiveMerchantPayload(p8AmbiguousFrame, "p8");
  assert.equal(
    results.length,
    p8ResultsBeforeAmbiguous,
    "an ambiguous prepared write emits no premature terminal result",
  );
  assert.ok(
    getPrivateState("merchantTransactions").records.some(
      (record) => record.commitId === p8AmbiguousFrame.commitId,
    ),
    "the applied prepared checkpoint remains durable",
  );
  await receiveMerchantPayload(p8AmbiguousFrame, "p8");
  assert.equal(results.at(-1)?.ok, true);
  assert.equal(
    actors.get("actor-p8").system.currency.gp,
    p8WalletBeforeAmbiguous - 9,
  );
  assert.equal(
    flags.merchants.find((entry) => entry.id === "shop-p8").items[0].qty,
    p8StockBeforeAmbiguous - 1,
  );
  assert.equal(
    actors.get("actor-p8").createCalls,
    p8CreatesBeforeAmbiguous + 1,
  );
  assert.equal(
    getBargain(p8AmbiguousSession.sessionId, itemByUser.p8, "buy"),
    null,
    "durable replay burns the exact reserved bargain",
  );

  const p8CompetingFrame = {
    ...p8AmbiguousFrame,
    commitId: commitId(84),
  };
  const p8ResultsBeforeCompeting = results.length;
  await receiveMerchantPayload(p8CompetingFrame, "p8");
  assert.equal(results.length, p8ResultsBeforeCompeting + 1);
  assert.equal(results.at(-1)?.reason, "bargain-expired");
  assert.equal(
    actors.get("actor-p8").system.currency.gp,
    p8WalletBeforeAmbiguous - 9,
  );
  assert.equal(
    flags.merchants.find((entry) => entry.id === "shop-p8").items[0].qty,
    p8StockBeforeAmbiguous - 1,
    "the competing commit performs no second stock or wallet mutation",
  );

  // A scalar replay floor cannot prove that an unseen old id matches the
  // compacted request, so the player receives an explicit uncertain outcome.
  const currentLedger = getPrivateState("merchantTransactions");
  await setPrivateState("merchantTransactions", {
    ...currentLedger,
    revision: currentLedger.revision + 1,
    replayFloors: [{ originUserId: "p1", throughCommitId: p1Frame.commitId }],
    records: currentLedger.records.filter(
      (record) => record.originUserId !== "p1",
    ),
  });
  await receiveMerchantPayload(p1Frame, "p1");
  assert.equal(results.at(-1)?.ok, false);
  assert.equal(results.at(-1)?.reason, "transaction-history-expired");

  const p1ExpiredSealSession = openSession({
    merchantId: "shop-p1",
    viewerUserId: "p1",
  });
  const p1ExpiredSealFrame = {
    ...makeFrame({
      userId: "p1",
      sessionId: p1ExpiredSealSession.sessionId,
      itemUuid: itemByUser.p1,
      id: commitId(8),
    }),
    sealId: "expired-seal",
  };
  await receiveMerchantPayload(p1ExpiredSealFrame, "p1");
  assert.equal(results.at(-1)?.ok, false);
  assert.equal(
    results.at(-1)?.reason,
    "bargain-expired",
    "an unknown bargain is rejected before any canonical write",
  );

  const p1PriceChangedFrame = {
    ...makeFrame({
      userId: "p1",
      sessionId: p1ExpiredSealSession.sessionId,
      itemUuid: itemByUser.p1,
      id: commitId(88),
    }),
    totalGp: 9,
  };
  const p1WalletBeforePriceChange = actors.get("actor-p1").system.currency.gp;
  const p1StockBeforePriceChange = flags.merchants.find(
    (entry) => entry.id === "shop-p1",
  ).items[0].qty;
  await receiveMerchantPayload(p1PriceChangedFrame, "p1");
  assert.equal(results.at(-1)?.ok, false);
  assert.equal(results.at(-1)?.reason, "price-changed");
  assert.equal(
    actors.get("actor-p1").system.currency.gp,
    p1WalletBeforePriceChange,
  );
  assert.equal(
    flags.merchants.find((entry) => entry.id === "shop-p1").items[0].qty,
    p1StockBeforePriceChange,
  );

  // Compendium resolution yields control, so a session closed during that
  // await must be revalidated before a new durable plan can be persisted.
  const p9Session = openSession({
    merchantId: "shop-p9",
    viewerUserId: "p9",
  });
  const p9Frame = makeFrame({
    userId: "p9",
    sessionId: p9Session.sessionId,
    itemUuid: itemByUser.p9,
    id: commitId(9),
  });
  const immediateFromUuid = globalThis.fromUuid;
  let signalPlanningStarted;
  let releasePlanning;
  const planningStarted = new Promise((resolve) => {
    signalPlanningStarted = resolve;
  });
  const planningGate = new Promise((resolve) => {
    releasePlanning = resolve;
  });
  globalThis.fromUuid = async (uuid) => {
    if (uuid === itemByUser.p9) {
      signalPlanningStarted();
      await planningGate;
    }
    return immediateFromUuid(uuid);
  };
  const p9Pending = receiveMerchantPayload(p9Frame, "p9");
  await planningStarted;
  closeSession(p9Session.sessionId);
  releasePlanning();
  await p9Pending;
  globalThis.fromUuid = immediateFromUuid;
  assert.equal(results.at(-1)?.reason, "no-session");
  assert.equal(
    getPrivateState("merchantTransactions").records.some(
      (record) => record.commitId === p9Frame.commitId,
    ),
    false,
  );
  assert.equal(actors.get("actor-p9").system.currency.gp, 100);

  // Removing a viewer from the canonical allow-list revokes an already-open
  // session at every authority boundary. Bargain, durable commit, and reconnect
  // resume all close the stale session without rolling or mutating campaign
  // data.
  const revokedMerchants = getPrivateState("merchants").map((merchant) =>
    merchant.id === "shop-p9" ? { ...merchant, allowedUserIds: [] } : merchant,
  );
  await setPrivateState("merchants", revokedMerchants);
  const revokedActor = actors.get("actor-p9");
  const revokedCreatesBefore = revokedActor.createCalls;
  const revokedWalletBefore = revokedActor.system.currency.gp;
  const revokedStockBefore = getPrivateState("merchants").find(
    (merchant) => merchant.id === "shop-p9",
  ).items[0].qty;
  const revokedRecordsBefore = getPrivateState("merchantTransactions").records
    .length;

  const revokedCommitSession = openSession({
    merchantId: "shop-p9",
    viewerUserId: "p9",
  });
  const revokedFrame = makeFrame({
    userId: "p9",
    sessionId: revokedCommitSession.sessionId,
    itemUuid: itemByUser.p9,
    id: commitId(99),
  });
  await receiveMerchantPayload(revokedFrame, "p9");
  assert.equal(results.at(-1)?.reason, "no-session");
  assert.equal(revokedActor.createCalls, revokedCreatesBefore);
  assert.equal(revokedActor.system.currency.gp, revokedWalletBefore);
  assert.equal(
    getPrivateState("merchants").find((merchant) => merchant.id === "shop-p9")
      .items[0].qty,
    revokedStockBefore,
  );
  assert.equal(
    getPrivateState("merchantTransactions").records.length,
    revokedRecordsBefore,
  );

  const revokedBargainSession = openSession({
    merchantId: "shop-p9",
    viewerUserId: "p9",
  });
  await receiveMerchantPayload(
    {
      type: MERCHANT_EVENTS.BARGAIN_RESULT,
      originUserId: "p9",
      sessionId: revokedBargainSession.sessionId,
      actorId: "actor-p9",
      itemUuid: itemByUser.p9,
      side: "buy",
      skillId: "per",
      rollTotal: 20,
    },
    "p9",
  );
  assert.equal(
    revokedActor.createCalls,
    revokedCreatesBefore,
    "revoked bargain access performs no Actor work",
  );

  const revokedResumeSession = openSession({
    merchantId: "shop-p9",
    viewerUserId: "p9",
  });
  const resumedSessions = [];
  const unsubscribeResume = subscribe(MERCHANT_EVENTS.SESSION_OPEN, (payload) =>
    resumedSessions.push(payload),
  );
  await receiveMerchantPayload(
    {
      type: MERCHANT_EVENTS.SESSION_RESUME_REQUEST,
      originUserId: "p9",
    },
    "p9",
  );
  unsubscribeResume();
  assert.equal(resumedSessions.length, 0);
  assert.equal(
    closeSession(revokedResumeSession.sessionId),
    false,
    "resume removes the stale unauthorized session",
  );

  // Authority loss after the Actor item write leaves a prepared plan. A later
  // authority epoch finishes it from the ledger after the session is gone.
  const p2Session = openSession({
    merchantId: "shop-p2",
    viewerUserId: "p2",
  });
  const p2Frame = makeFrame({
    userId: "p2",
    sessionId: p2Session.sessionId,
    itemUuid: itemByUser.p2,
    id: commitId(2),
  });
  const p2Actor = actors.get("actor-p2");
  p2Actor.afterNextCreate = () => {
    gm.isGM = false;
    globalThis.Hooks.call("updateUser", gm, { role: 1 });
  };
  const p2ResultsBefore = results.length;
  await receiveMerchantPayload(p2Frame, "p2");
  assert.equal(
    results.length,
    p2ResultsBefore,
    "authority ambiguity has no ack",
  );
  closeSession(p2Session.sessionId);
  gm.isGM = true;
  merchantTransactionCoordinator.unregister();
  await initializePrivateState();
  await merchantTransactionCoordinator.register();
  await merchantTransactionCoordinator.reconcilePending();
  await receiveMerchantPayload(p2Frame, "p2");
  assert.equal(results.at(-1)?.ok, true);
  assert.equal(p2Actor.system.currency.gp, 90);
  assert.equal(
    flags.merchants.find((entry) => entry.id === "shop-p2").items[0].qty,
    4,
  );

  // A genuine third state is durably quarantined, reported as uncertain, and
  // never overwritten on replay.
  const p3Session = openSession({
    merchantId: "shop-p3",
    viewerUserId: "p3",
  });
  const p3Frame = makeFrame({
    userId: "p3",
    sessionId: p3Session.sessionId,
    itemUuid: itemByUser.p3,
    id: commitId(3),
  });
  const p3Actor = actors.get("actor-p3");
  p3Actor.afterNextCreate = () => {
    gm.isGM = false;
    globalThis.Hooks.call("updateUser", gm, { role: 1 });
  };
  await receiveMerchantPayload(p3Frame, "p3");
  closeSession(p3Session.sessionId);
  p3Actor.system.currency.gp = 77;
  gm.isGM = true;
  merchantTransactionCoordinator.unregister();
  await initializePrivateState();
  await merchantTransactionCoordinator.register();
  await merchantTransactionCoordinator.reconcilePending();
  const p3ResultsBefore = results.length;
  await receiveMerchantPayload(p3Frame, "p3");
  assert.equal(results.length, p3ResultsBefore + 1);
  assert.equal(results.at(-1)?.reason, "transaction-needs-review");
  assert.equal(
    getPrivateState("merchantTransactions").records.find(
      (record) => record.commitId === p3Frame.commitId,
    )?.stage,
    "needs-review",
  );
  assert.ok(notices.some((message) => message.includes("shop-p3")));

  const p3BlockedSession = openSession({
    merchantId: "shop-p3",
    viewerUserId: "p3",
  });
  const p3BlockedFrame = makeFrame({
    userId: "p3",
    sessionId: p3BlockedSession.sessionId,
    itemUuid: itemByUser.p3,
    id: commitId(4),
  });
  const p3CreatesBeforeBlocked = p3Actor.createCalls;
  await receiveMerchantPayload(p3BlockedFrame, "p3");
  assert.equal(results.at(-1)?.reason, "unresolved-transaction-collision");
  assert.equal(
    p3Actor.createCalls,
    p3CreatesBeforeBlocked,
    "a blocked plan performs no Actor write",
  );

  // A GM may finish a safe recheck while the player is offline. The inert
  // client review later asks only for this exact fingerprint's durable status.
  p3Actor.system.currency.gp = 100;
  const p3Recovered = await merchantTransactionCoordinator.recheck({
    originUserId: "p3",
    commitId: p3Frame.commitId,
    requestFingerprint: merchantCommitRequestFingerprint(p3Frame),
  });
  assert.equal(p3Recovered.status, "terminal");
  const beforeP3Status = results.length;
  await receiveMerchantPayload(
    {
      type: MERCHANT_EVENTS.COMMIT_STATUS_REQUEST,
      originUserId: "p3",
      commitId: p3Frame.commitId,
      requestFingerprint: merchantCommitRequestFingerprint(p3Frame),
    },
    "p3",
  );
  assert.equal(results.length, beforeP3Status + 1);
  assert.equal(results.at(-1)?.ok, true);
  assert.equal(results.at(-1)?.commitId, p3Frame.commitId);

  // An unconfirmed Actor implementation cannot make one inbound frame spin
  // forever. The coordinator's bounded drive returns pending with no ack.
  const p6Session = openSession({
    merchantId: "shop-p6",
    viewerUserId: "p6",
  });
  const p6Frame = makeFrame({
    userId: "p6",
    sessionId: p6Session.sessionId,
    itemUuid: itemByUser.p6,
    id: commitId(6),
  });
  const p6Actor = actors.get("actor-p6");
  p6Actor.noApplyCreates = true;
  const p6ResultsBefore = results.length;
  await receiveMerchantPayload(p6Frame, "p6");
  assert.equal(results.length, p6ResultsBefore);
  assert.ok(
    p6Actor.createCalls > 0 && p6Actor.createCalls <= 16,
    "one frame uses the coordinator's bounded drive budget",
  );
  assert.equal(
    getPrivateState("merchantTransactions").records.find(
      (record) => record.commitId === p6Frame.commitId,
    )?.stage,
    "prepared",
  );
  const collisionLedger = getPrivateState("merchantTransactions");
  const p6Record = collisionLedger.records.find(
    (record) => record.commitId === p6Frame.commitId,
  );
  const blockingCommitId = commitId(66);
  await setPrivateState("merchantTransactions", {
    ...collisionLedger,
    revision: collisionLedger.revision + 1,
    records: [
      ...collisionLedger.records,
      {
        ...clone(p6Record),
        key: buildMerchantTransactionKey("p5", blockingCommitId),
        originUserId: "p5",
        commitId: blockingCommitId,
        requestFingerprint: "test-persisted-drive-collision",
      },
    ],
  });
  const p6ResultsBeforeBlockedDrive = results.length;
  const p6CreatesBeforeBlockedDrive = p6Actor.createCalls;
  await receiveMerchantPayload(p6Frame, "p6");
  assert.equal(
    results.length,
    p6ResultsBeforeBlockedDrive,
    "a persisted blocked transaction stays pending without a terminal ack",
  );
  assert.equal(p6Actor.createCalls, p6CreatesBeforeBlockedDrive);

  // Brand-new IDs are rate-limited per authenticated origin. Replays above
  // never consumed this budget, and another user remains unaffected.
  for (let index = 0; index < 11; index += 1) {
    await receiveMerchantPayload(
      makeFrame({
        userId: "p4",
        sessionId: "missing-p4",
        itemUuid: itemByUser.p4,
        id: commitId(100 + index),
      }),
      "p4",
    );
  }
  assert.equal(results.at(-1)?.reason, "rate-limited");
  await receiveMerchantPayload(
    makeFrame({
      userId: "p5",
      sessionId: "missing-p5",
      itemUuid: itemByUser.p5,
      id: commitId(200),
    }),
    "p5",
  );
  assert.equal(results.at(-1)?.reason, "no-session");

  unsubscribe();
  process.stdout.write("merchant durable socket validation passed\n");
} finally {
  merchantTransactionCoordinator.unregister();
  clearAllSessions();
  resetPrivateStateForTests();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
}
