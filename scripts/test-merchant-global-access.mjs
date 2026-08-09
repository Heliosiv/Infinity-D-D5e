import assert from "node:assert/strict";

import {
  isMerchantAccessClosed,
  loadMerchantAccessState,
  normalizeMerchantAccessState,
} from "./merchant/global-access.js";
import {
  MERCHANT_EVENTS,
  pushCloseAllMerchantSessions,
  pushOpenSession,
  pushReopenMerchantSessions,
} from "./merchant/socket.js";
import { clearAllSessions, listSessions } from "./merchant/session-state.js";

const saved = {
  game: globalThis.game,
  JournalEntry: globalThis.JournalEntry,
  CONST: globalThis.CONST,
};

try {
  if (saved.JournalEntry !== undefined) delete globalThis.JournalEntry;
  globalThis.CONST = { USER_ROLES: { GAMEMASTER: 4 } };

  assert.deepEqual(
    normalizeMerchantAccessState({
      version: 99,
      closed: true,
      suspendedSessions: [
        { merchantId: " m1 ", viewerUserId: " p1 " },
        { merchantId: "m1", viewerUserId: "p1" },
        { merchantId: "", viewerUserId: "p2" },
        null,
      ],
    }),
    {
      version: 1,
      closed: true,
      suspendedSessions: [{ merchantId: "m1", viewerUserId: "p1" }],
    },
    "global access normalization deduplicates and drops malformed pairs",
  );

  const gm = { id: "gm", name: "GM", isGM: true, role: 4, active: true };
  const p1 = {
    id: "p1",
    name: "Player One",
    isGM: false,
    role: 1,
    active: true,
  };
  const p2 = {
    id: "p2",
    name: "Player Two",
    isGM: false,
    role: 1,
    active: true,
  };
  const userList = [gm, p1, p2];
  const users = {
    activeGM: gm,
    contents: userList,
    get: (id) => userList.find((user) => user.id === id) ?? null,
    forEach: (callback) => userList.forEach(callback),
  };
  const values = new Map([
    [
      "merchants",
      [
        {
          id: "m-open",
          name: "Open Shop",
          allowedUserIds: ["p1", "p2"],
          selfServiceMode: "open",
        },
        {
          id: "m-knock",
          name: "Knock Shop",
          allowedUserIds: ["p1"],
          selfServiceMode: "knock",
        },
        {
          id: "m-off",
          name: "GM Pull Shop",
          allowedUserIds: ["p1"],
          selfServiceMode: "off",
        },
      ],
    ],
  ]);
  const emitted = [];
  globalThis.game = {
    ready: true,
    user: gm,
    users,
    settings: {
      get: (_module, key) => structuredClone(values.get(key)),
      async set(_module, key, value) {
        values.set(key, structuredClone(value));
      },
    },
    socket: {
      emit: (_name, payload, options) => emitted.push({ payload, options }),
    },
  };

  clearAllSessions();
  const [openShop, knockShop] = values.get("merchants");
  assert.equal(
    pushOpenSession({ merchant: openShop, targetUserIds: ["p1", "p2"] }).length,
    2,
  );
  assert.equal(
    pushOpenSession({ merchant: knockShop, targetUserIds: ["p1"] }).length,
    1,
  );
  assert.equal(listSessions().length, 3);

  emitted.length = 0;
  const closed = await pushCloseAllMerchantSessions();
  assert.deepEqual(closed, {
    alreadyClosed: false,
    closedCount: 3,
    suspendedCount: 3,
  });
  assert.equal(isMerchantAccessClosed(), true);
  assert.equal(listSessions().length, 0, "all live sessions are removed");
  assert.equal(
    emitted.filter(
      (entry) => entry.payload.type === MERCHANT_EVENTS.SESSION_CLOSE,
    ).length,
    3,
    "every player window receives a close event",
  );
  const closedLists = emitted.filter(
    (entry) => entry.payload.type === MERCHANT_EVENTS.SHOP_LIST_REPLY,
  );
  assert.equal(closedLists.length, 2, "each active player gets a list refresh");
  assert.ok(
    closedLists.every(
      (entry) =>
        entry.payload.globallyClosed === true &&
        entry.payload.shops.length === 0,
    ),
    "the global lock immediately empties connected player shop pickers",
  );
  assert.deepEqual(
    values.get("merchants").map((merchant) => merchant.selfServiceMode),
    ["open", "knock", "off"],
    "global close does not rewrite per-shop access modes",
  );
  assert.equal(
    pushOpenSession({ merchant: openShop, targetUserIds: ["p1"] }).length,
    0,
    "GM-pushed sessions fail closed while the global lock is active",
  );

  const repeated = await pushCloseAllMerchantSessions();
  assert.equal(repeated.alreadyClosed, true);
  assert.equal(
    loadMerchantAccessState().suspendedSessions.length,
    3,
    "a repeated close preserves the original restore snapshot",
  );

  // Access changed while shops were closed: restore valid pairs only.
  values.get("merchants")[0].allowedUserIds = ["p1"];
  emitted.length = 0;
  const reopened = await pushReopenMerchantSessions();
  assert.deepEqual(reopened, {
    alreadyOpen: false,
    openedCount: 2,
    skippedCount: 1,
  });
  assert.equal(isMerchantAccessClosed(), false);
  assert.equal(listSessions().length, 2);
  assert.deepEqual(loadMerchantAccessState().suspendedSessions, []);
  assert.deepEqual(
    listSessions()
      .map((session) => `${session.merchantId}::${session.viewerUserId}`)
      .sort(),
    ["m-knock::p1", "m-open::p1"],
    "reopen restores the exact still-authorized merchant/viewer pairs",
  );
  const reopenedLists = emitted.filter(
    (entry) => entry.payload.type === MERCHANT_EVENTS.SHOP_LIST_REPLY,
  );
  assert.ok(
    reopenedLists.every((entry) => entry.payload.globallyClosed === false),
    "connected player shop pickers receive the reopened state",
  );
} finally {
  clearAllSessions();
  if (saved.game === undefined) delete globalThis.game;
  else globalThis.game = saved.game;
  if (saved.JournalEntry === undefined) delete globalThis.JournalEntry;
  else globalThis.JournalEntry = saved.JournalEntry;
  if (saved.CONST === undefined) delete globalThis.CONST;
  else globalThis.CONST = saved.CONST;
}

process.stdout.write("merchant-global-access validation passed\n");
