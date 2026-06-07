/**
 * Infinity D&D5e — Bargain Engine
 *
 * Skill-check arbiter for merchant haggling. The pure path
 * (`computeBargainOutcome`) takes a roll total + DC + tier list and
 * returns the matching tier with its price delta. The Foundry-touching
 * path (`runBargain`) wraps dnd5e's `actor.rollSkill()` and harmonizes
 * the v3 / v4 return-shape divergence.
 */

import {
  BARGAIN_SKILLS,
  PASSIVE_HAGGLE_BASELINE,
  getDefaultBargainTiers,
} from "./store.js";
import { SETTING_KEYS, getSetting } from "../settings.js";

const MODULE_ID = "infinity-dnd5e";

/* ------------------------------------------------------------------ *
 * Passive haggle
 * ------------------------------------------------------------------ */

/**
 * Compute the always-on passive price nudge for a shopper, BEFORE any active
 * bargain roll. Uses the best passive among the merchant's allowed bargain
 * skills, measured against the "average commoner" baseline of 10.
 *
 * Returns a deltaPct in the same convention as a bargain seal:
 *   negative = better for the shopper (discount on buy, bonus on sell),
 *   positive = worse. 0 when passive haggle is off, no actor, or no skills.
 *
 * Pure read of `actor.system.skills[id].passive`; safe outside Foundry.
 *
 * @param {object} merchant - normalized merchant record
 * @param {object} actor - the shopper's actor (or null)
 * @returns {number} deltaPct, clamped to ±passiveCapPct
 */
export function computePassiveBargainPct(merchant, actor) {
  if (!merchant || merchant.passiveHaggle === false) return 0;
  const skills = actor?.system?.skills;
  if (!skills || typeof skills !== "object") return 0;
  const allowed =
    Array.isArray(merchant.allowedSkills) && merchant.allowedSkills.length > 0
      ? merchant.allowedSkills
      : Object.keys(BARGAIN_SKILLS);

  let bestPassive = null;
  for (const id of allowed) {
    const passive = Number(skills[id]?.passive);
    if (!Number.isFinite(passive)) continue;
    if (bestPassive == null || passive > bestPassive) bestPassive = passive;
  }
  if (bestPassive == null) return 0;

  const perPoint = Math.max(0, Number(merchant.passivePctPerPoint) || 0);
  const cap = Math.max(0, Number(merchant.passiveCapPct) || 0);
  // Above baseline helps the shopper (negative delta); below hurts (positive).
  const raw = -(bestPassive - PASSIVE_HAGGLE_BASELINE) * perPoint;
  // `|| 0` also collapses a -0 (passive exactly at baseline) to a clean 0.
  return Math.max(-cap, Math.min(cap, raw)) || 0;
}

/* ------------------------------------------------------------------ *
 * Tier resolution
 * ------------------------------------------------------------------ */

/**
 * Pick the matching tier for a given (rollTotal, dc) using an ordered
 * list of `{ minMargin, deltaPct, id }`. Tiers are scanned from highest
 * minMargin to lowest — first match wins.
 *
 * @param {number} rollTotal
 * @param {number} dc
 * @param {Array<object>} tiers
 * @returns {{tier:object|null, margin:number, deltaPct:number}}
 */
export function computeBargainOutcome(rollTotal, dc, tiers) {
  const margin = Number(rollTotal) - Number(dc);
  const list =
    Array.isArray(tiers) && tiers.length > 0 ? tiers : getDefaultBargainTiers();
  const sorted = list
    .filter((tier) => tier && typeof tier === "object")
    .map((tier) => ({
      id: String(tier.id ?? ""),
      minMargin: Number(tier.minMargin),
      deltaPct: Number(tier.deltaPct) || 0,
    }))
    .sort((a, b) => b.minMargin - a.minMargin);

  const match = sorted.find((tier) => margin >= tier.minMargin) ?? null;
  return {
    tier: match,
    margin,
    deltaPct: match?.deltaPct ?? 0,
  };
}

/**
 * Read the configured tier list from settings (falling back to defaults
 * when the setting is unset or malformed).
 */
export function loadBargainTiers() {
  const raw = getSetting(SETTING_KEYS.MERCHANT_BARGAIN_TIERS);
  if (!Array.isArray(raw) || raw.length === 0) return getDefaultBargainTiers();
  const cleaned = raw
    .map((tier) => {
      if (!tier || typeof tier !== "object") return null;
      const id = String(tier.id ?? "").trim();
      const minMargin = Number(tier.minMargin);
      const deltaPct = Number(tier.deltaPct);
      if (!id || !Number.isFinite(deltaPct)) return null;
      return {
        id,
        minMargin: Number.isFinite(minMargin) ? minMargin : -Infinity,
        deltaPct,
      };
    })
    .filter(Boolean);
  return cleaned.length > 0 ? cleaned : getDefaultBargainTiers();
}

/* ------------------------------------------------------------------ *
 * Roll execution
 * ------------------------------------------------------------------ */

/**
 * Roll the bargain skill check on the supplied actor and resolve the
 * tier. Returns:
 *   { ok: true, rollTotal, tier, margin, deltaPct, skillId, dc, roll }
 *   { ok: false, reason }
 *
 * - `reason: "no-actor"` — no usable actor
 * - `reason: "skill-roll-failed"` — actor.rollSkill returned nothing
 * - `reason: "cancelled"` — dialog dismissed (rollSkill resolved null)
 */
export async function runBargain({
  actor,
  skillId,
  dc,
  tiers = null,
  advantage = false,
  disadvantage = false,
  chatMessage = false,
} = {}) {
  if (!actor || typeof actor.rollSkill !== "function") {
    return { ok: false, reason: "no-actor" };
  }
  const id = String(skillId ?? "").trim();
  if (!id) return { ok: false, reason: "no-skill" };

  let roll;
  try {
    roll = await rollSkillCompat(actor, id, {
      advantage: advantage === true,
      disadvantage: disadvantage === true,
      chatMessage,
    });
  } catch (error) {
    console.error(`${MODULE_ID} | bargain roll failed`, error);
    return { ok: false, reason: "skill-roll-failed", error };
  }

  if (!roll) return { ok: false, reason: "cancelled" };

  const total = Number(roll.total);
  if (!Number.isFinite(total)) {
    return { ok: false, reason: "skill-roll-failed" };
  }

  const tierList =
    Array.isArray(tiers) && tiers.length > 0 ? tiers : loadBargainTiers();

  const outcome = computeBargainOutcome(total, Number(dc) || 0, tierList);
  return {
    ok: true,
    rollTotal: total,
    tier: outcome.tier,
    margin: outcome.margin,
    deltaPct: outcome.deltaPct,
    skillId: id,
    dc: Number(dc) || 0,
    roll,
  };
}

/**
 * Call `actor.rollSkill(skillId, options)` and normalize the return
 * shape across dnd5e v3 / v4. v3 returns a single Roll (or null); v4
 * may return an Array<Roll>. We return the first non-null Roll.
 */
async function rollSkillCompat(actor, skillId, options) {
  const result = await actor.rollSkill(skillId, options);
  if (!result) return null;
  if (Array.isArray(result)) return result.find(Boolean) ?? null;
  return result;
}
