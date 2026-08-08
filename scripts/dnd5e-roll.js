/**
 * Cross-version D&D5e roll helpers shared by authoritative module services.
 *
 * D&D5e 5 moved the selected skill into a configuration object and may return
 * an array of rolls. The supported 4.0.4 baseline and older releases use a
 * string-first signature and return a single roll. Callers receive one
 * normalized roll without needing to know which system major is active.
 */

export async function rollSkillCompat(actor, skillId, options = {}) {
  if (!actor || typeof actor.rollSkill !== "function") return null;
  const id = String(skillId ?? "").trim();
  if (!id) return null;
  const {
    advantage = false,
    disadvantage = false,
    chatMessage = false,
    fastForward = false,
  } = options;
  const major = Number.parseInt(
    String(globalThis.game?.system?.version ?? ""),
    10,
  );
  let result;
  if (Number.isFinite(major) && major >= 5) {
    result = await actor.rollSkill(
      {
        skill: id,
        advantage: advantage === true,
        disadvantage: disadvantage === true,
        fastForward: fastForward === true,
      },
      {},
      { create: chatMessage === true },
    );
  } else {
    result = await actor.rollSkill(id, {
      advantage: advantage === true,
      disadvantage: disadvantage === true,
      chatMessage: chatMessage === true,
      fastForward: fastForward === true,
    });
  }
  if (!result) return null;
  if (Array.isArray(result)) return result.find(Boolean) ?? null;
  return result;
}

/** Roll a skill and return only a verified finite total. */
export async function rollSkillTotal(actor, skillId, options = {}) {
  try {
    const roll = await rollSkillCompat(actor, skillId, options);
    if (!roll) return { ok: false, reason: "cancelled" };
    const total = Number(roll.total);
    if (!Number.isFinite(total)) {
      return { ok: false, reason: "skill-roll-failed" };
    }
    return { ok: true, total, roll, skillId: String(skillId) };
  } catch (error) {
    return { ok: false, reason: "skill-roll-failed", error };
  }
}
