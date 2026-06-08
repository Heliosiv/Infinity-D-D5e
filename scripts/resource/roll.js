/**
 * Infinity D&D5e — Survival roll (Foundry-touching)
 *
 * Thin wrapper around dnd5e's `actor.rollSkill('sur', …)` for the foraging
 * gather check, reusing the v3/v4 return-shape normalization the merchant
 * bargain engine already solved (`rollSkillCompat`). The roll runs on the
 * player's own client so their bonuses, dice-so-nice, and advantage prompts
 * all apply; only the resulting total travels to the GM.
 */

import { rollSkillCompat } from "../merchant/bargain.js";

const MODULE_ID = "infinity-dnd5e";

/** dnd5e skill id for Wisdom (Survival). */
export const SURVIVAL_SKILL_ID = "sur";

/** The actor's Wisdom modifier (0 when unreadable). */
export function getWisMod(actor) {
  const mod = Number(actor?.system?.abilities?.wis?.mod);
  return Number.isFinite(mod) ? mod : 0;
}

/** The actor's passive Survival score, or null when unreadable. */
export function getSurvivalPassive(actor) {
  const passive = Number(actor?.system?.skills?.[SURVIVAL_SKILL_ID]?.passive);
  return Number.isFinite(passive) ? passive : null;
}

/**
 * Roll Survival on the supplied actor. Returns `{ total, roll }` or `null` when
 * the actor can't roll or the dialog was dismissed.
 *
 * @param {Actor} actor
 * @param {object} [opts]
 * @param {boolean} [opts.advantage=false]
 * @param {boolean} [opts.disadvantage=false]
 * @param {boolean} [opts.chatMessage=true] - post the roll to chat (players like seeing it)
 * @returns {Promise<{ total:number, roll:object }|null>}
 */
export async function rollSurvivalTotal(
  actor,
  { advantage = false, disadvantage = false, chatMessage = true } = {},
) {
  if (!actor || typeof actor.rollSkill !== "function") return null;
  let roll;
  try {
    roll = await rollSkillCompat(actor, SURVIVAL_SKILL_ID, {
      advantage: advantage === true,
      disadvantage: disadvantage === true,
      chatMessage,
    });
  } catch (error) {
    console.error(`${MODULE_ID} | survival roll failed`, error);
    return null;
  }
  if (!roll) return null;
  const total = Number(roll.total);
  return Number.isFinite(total) ? { total, roll } : null;
}
