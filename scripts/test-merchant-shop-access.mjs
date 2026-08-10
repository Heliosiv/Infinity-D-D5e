/**
 * Player-initiated shop access — the authority gate (canSelfOpen) that both the
 * Shops list reply and an inbound shop-open request run through GM-side. The
 * socket handlers themselves touch Foundry, but the trust decision is this pure
 * gate, so that is what we lock down: a disallowed player, a full-GM requester,
 * and an "off" (kill-switched) shop must all be rejected before any session
 * opens. Listed Assistant GMs remain player-session eligible.
 */

import assert from "node:assert/strict";

import {
  canSelfOpen,
  normalizeMerchant,
  sanitizeMerchantForList,
} from "./merchant/store.js";

// Stub Foundry's user lookup so isUserAllowed can distinguish a full GM from
// Foundry's broader isGM flag, which also includes role-3 Assistant GMs.
const savedGame = globalThis.game;
globalThis.game = {
  users: {
    get: (id) => ({
      isGM: id === "gm-1" || id === "assistant-1",
      role: id === "gm-1" ? 4 : id === "assistant-1" ? 3 : 1,
    }),
  },
};

try {
  const openShop = normalizeMerchant({
    id: "s-open",
    allowedUserIds: ["p1", "assistant-1", "gm-1"],
    selfServiceMode: "open",
  });
  const knockShop = normalizeMerchant({
    id: "s-knock",
    allowedUserIds: ["p1"],
    selfServiceMode: "knock",
  });
  const offShop = normalizeMerchant({
    id: "s-off",
    allowedUserIds: ["p1"],
    selfServiceMode: "off",
  });

  assert.equal(
    canSelfOpen(openShop, "p1"),
    true,
    "allowed player + open → yes",
  );
  assert.equal(
    canSelfOpen(knockShop, "p1"),
    true,
    "allowed player + knock → reachable (GM approves later)",
  );
  assert.equal(
    canSelfOpen(offShop, "p1"),
    false,
    "off shop is the kill switch — never self-openable",
  );
  assert.equal(
    canSelfOpen(openShop, "p2"),
    false,
    "a player not on the allow-list is rejected",
  );
  assert.equal(
    canSelfOpen(openShop, "gm-1"),
    false,
    "a full-GM requester is rejected even when listed in allowedUserIds",
  );
  assert.equal(
    canSelfOpen(openShop, "assistant-1"),
    true,
    "a listed Assistant GM remains eligible for a player session",
  );
  assert.equal(canSelfOpen(openShop, null), false);
  assert.equal(canSelfOpen(null, "p1"), false);

  // The list reply only ever carries the sanitized projection — no economy or
  // permission internals reach the player client.
  const safe = sanitizeMerchantForList(openShop);
  assert.deepEqual(Object.keys(safe).sort(), [
    "art",
    "description",
    "id",
    "name",
    "selfServiceMode",
  ]);
  assert.equal(safe.allowedUserIds, undefined);
  assert.equal(safe.goldOnHand, undefined);
} finally {
  if (savedGame === undefined) delete globalThis.game;
  else globalThis.game = savedGame;
}

process.stdout.write("merchant-shop-access validation passed\n");
