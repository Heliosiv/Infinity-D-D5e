/**
 * Player-safe merchant projections.
 *
 * Full merchant records live in the restricted private-state journal and
 * include GM-only permissions, stock-generation rules, chat settings, and
 * inventory notes. Player shop sessions receive only the fields required to
 * render and execute the already GM-authoritative buy, sell, and bargain flows.
 */

import { normalizeMerchant } from "./store.js";

export const MERCHANT_SESSION_PROJECTION_VERSION = 1;

/**
 * Project a full merchant record to the stable shape a player session needs.
 *
 * The returned object intentionally omits:
 * - persistence version and GM-only bargain tier inputs;
 * - allowedUserIds and selfServiceMode (access-control policy);
 * - chatHidden (GM reporting policy);
 * - pool (GM stock-generation configuration);
 * - startingQty and notes (GM inventory-management metadata).
 *
 * @param {object} merchant
 * @returns {object}
 */
export function projectMerchantForSession(merchant) {
  const normalized = normalizeMerchant(merchant);
  return {
    schemaVersion: MERCHANT_SESSION_PROJECTION_VERSION,
    id: normalized.id,
    name: normalized.name,
    art: normalized.art,
    description: normalized.description,
    defaultMarkup: normalized.defaultMarkup,
    sellRatio: normalized.sellRatio,
    bargainDC: normalized.bargainDC,
    bargainFailPct: normalized.bargainFailPct,
    passiveHaggle: normalized.passiveHaggle,
    passivePctPerPoint: normalized.passivePctPerPoint,
    passiveCapPct: normalized.passiveCapPct,
    goldOnHand: normalized.goldOnHand,
    allowedSkills: [...normalized.allowedSkills],
    buyFilter: {
      lootTypes: [...normalized.buyFilter.lootTypes],
      rarities: [...normalized.buyFilter.rarities],
    },
    items: normalized.items.map((row) => ({
      uuid: row.uuid,
      qty: row.qty,
      unlimited: row.unlimited,
      priceOverrideGp: row.priceOverrideGp,
    })),
  };
}
