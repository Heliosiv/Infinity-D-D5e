/**
 * Critical Injury Table, Version 2.
 *
 * This is the campaign table previously shipped by Party Operations, moved
 * into a pure data/domain module so the roll bands, recovery rules, and
 * mechanical changes can be tested without Foundry globals.
 */

export const CRITICAL_INJURY_TABLE_VERSION = 2;
export const CRITICAL_INJURY_ROLL_FORMULA = "1d100";

export const CRITICAL_INJURY_TABLE = Object.freeze([
  {
    key: "lost-limb",
    min: 1,
    max: 5,
    label: "Lost Limb",
    effect:
      "Lose an arm or leg (1d4). Limb is unusable. Movement is halved if it is a leg; weapons and shields cannot be used with a lost arm.",
    recovery: "Permanent. Only Regenerate or divine magic can restore it.",
    permanent: true,
    kitCharges: 0,
    detailRoll: { type: "body-part", formula: "1d4" },
  },
  {
    key: "crippling-injury",
    min: 6,
    max: 10,
    label: "Crippling Injury",
    effect:
      "Disadvantage on actions using the injured limb. Speed is halved for a leg; shield protection is impaired for an arm.",
    recovery: "1d4 days or 2 Healer's Kit charges plus DC 12 Medicine.",
    recoveryFormula: "1d4",
    dayMin: 1,
    dayMax: 4,
    kitCharges: 2,
    treatmentDc: 12,
    treatmentSkill: "med",
    detailRoll: { type: "body-part", formula: "1d4" },
  },
  {
    key: "concussion",
    min: 11,
    max: 15,
    label: "Concussion",
    effect:
      "Disadvantage on Intelligence and Wisdom checks and saves. Passive Perception is reduced by 5.",
    recovery: "1d4 days or 1 Healer's Kit charge.",
    recoveryFormula: "1d4",
    dayMin: 1,
    dayMax: 4,
    kitCharges: 1,
  },
  {
    key: "broken-arm",
    min: 16,
    max: 20,
    label: "Broken Arm",
    effect:
      "The injured arm cannot be used for weapons, shields, or somatic spell components.",
    recovery:
      "2d4 days, or 2 Healer's Kit charges to downgrade it to a Crippling Injury with half the remaining recovery.",
    recoveryFormula: "2d4",
    dayMin: 2,
    dayMax: 8,
    kitCharges: 2,
    downgradeTo: "crippling-injury",
    downgradeHalfDays: true,
  },
  {
    key: "fractured-ribs",
    min: 21,
    max: 25,
    label: "Fractured Ribs",
    effect:
      "Disadvantage on Dexterity saves and Constitution checks. Dashing causes 1d4 damage.",
    recovery: "1d4+1 days or 2 Healer's Kit charges.",
    recoveryFormula: "1d4+1",
    dayMin: 2,
    dayMax: 5,
    kitCharges: 2,
  },
  {
    key: "internal-bleeding",
    min: 26,
    max: 30,
    label: "Internal Bleeding",
    effect: "At the start of combat, roll 1d6. On a 1, take 1d4 damage.",
    recovery:
      "3 Healer's Kit charges plus DC 15 Medicine, or suitable magical healing.",
    recoveryFormula: "3",
    dayMin: 3,
    dayMax: 3,
    kitCharges: 3,
    treatmentDc: 15,
    treatmentSkill: "med",
  },
  {
    key: "deep-cut",
    min: 31,
    max: 35,
    label: "Deep Cut",
    effect: "Lose 1d6 maximum HP. It cannot be regained until treated.",
    recovery: "1 Healer's Kit charge, or 1 hour of rest plus DC 13 Medicine.",
    recoveryFormula: "1",
    dayMin: 1,
    dayMax: 1,
    kitCharges: 1,
    treatmentDc: 13,
    treatmentSkill: "med",
    detailRoll: { type: "max-hp-loss", formula: "1d6" },
  },
  {
    key: "loss-of-eye",
    min: 36,
    max: 40,
    label: "Loss of Eye",
    effect: "Disadvantage on Perception checks and ranged attacks.",
    recovery: "Permanent unless magically restored.",
    permanent: true,
    kitCharges: 0,
  },
  {
    key: "loss-of-hearing",
    min: 41,
    max: 45,
    label: "Loss of Hearing",
    effect: "Disadvantage on sound-based Perception checks.",
    recovery: "Permanent unless magically restored.",
    permanent: true,
    kitCharges: 0,
  },
  {
    key: "shattered-knee",
    min: 46,
    max: 50,
    label: "Shattered Knee",
    effect: "Cannot Dash. Speed is halved and movement is painful.",
    recovery:
      "1 week or 3 Healer's Kit charges. It becomes permanent if untreated.",
    recoveryFormula: "7",
    dayMin: 7,
    dayMax: 7,
    kitCharges: 3,
    canBecomePermanent: true,
  },
  {
    key: "dislocated-shoulder",
    min: 51,
    max: 55,
    label: "Dislocated Shoulder",
    effect: "Disadvantage on Strength checks and melee attacks.",
    recovery: "1d6 days of rest.",
    recoveryFormula: "1d6",
    dayMin: 1,
    dayMax: 6,
    kitCharges: 0,
  },
  {
    key: "infection",
    min: 56,
    max: 60,
    label: "Infection",
    effect:
      "After each long rest, make a DC 15 Constitution save. On a failure, lose 1 maximum HP until the infection heals.",
    recovery: "2 Healer's Kit charges.",
    recoveryFormula: "3",
    dayMin: 3,
    dayMax: 3,
    kitCharges: 2,
  },
  {
    key: "minor-injury",
    min: 61,
    max: 70,
    label: "Minor Injury",
    effect: "No combat effect. The character is bloodied, limping, or bruised.",
    recovery: "1 Healer's Kit charge or 1d3 days of rest.",
    recoveryFormula: "1d3",
    dayMin: 1,
    dayMax: 3,
    kitCharges: 1,
  },
  {
    key: "deep-scar",
    min: 71,
    max: 80,
    label: "Deep Scar",
    effect: "+1 Intimidation and -1 Persuasion while the scar is visible.",
    recovery: "Permanent.",
    permanent: true,
    kitCharges: 0,
  },
  {
    key: "psychic-trauma",
    min: 81,
    max: 90,
    label: "Psychic Trauma",
    effect: "Disadvantage on saves against fear and charm.",
    recovery: "1 week, or 2 Healer's Kit charges plus one DC 13 Insight check.",
    recoveryFormula: "7",
    dayMin: 7,
    dayMax: 7,
    kitCharges: 2,
    treatmentDc: 13,
    treatmentSkill: "ins",
  },
  {
    key: "nerve-damage",
    min: 91,
    max: 95,
    label: "Nerve Damage",
    effect: "One ability score (1d6) is reduced by 1 temporarily.",
    recovery:
      "1 week or 2 Healer's Kit charges. It becomes permanent on a failed DC 13 Constitution save.",
    recoveryFormula: "7",
    dayMin: 7,
    dayMax: 7,
    kitCharges: 2,
    treatmentDc: 13,
    treatmentSkill: "con",
    canBecomePermanent: true,
    detailRoll: { type: "ability", formula: "1d6" },
  },
  {
    key: "nightmares",
    min: 96,
    max: 99,
    label: "Nightmares",
    effect:
      "Disadvantage on the first initiative roll each day. Long rests do not remove exhaustion.",
    recovery:
      "Remove Curse, or 4 Healer's Kit charges to ease the mental symptoms.",
    recoveryFormula: "7",
    dayMin: 7,
    dayMax: 7,
    kitCharges: 4,
  },
  {
    key: "soul-shaken",
    min: 100,
    max: 100,
    label: "Soul-Shaken",
    effect: "Permanent -1 to Wisdom saves. Shadows cling to the soul.",
    recovery:
      "Permanent unless resolved through divine magic or a narrative quest.",
    permanent: true,
    kitCharges: 0,
  },
]);

const BODY_PARTS = Object.freeze({
  1: { key: "left-arm", label: "Left arm", kind: "arm" },
  2: { key: "right-arm", label: "Right arm", kind: "arm" },
  3: { key: "left-leg", label: "Left leg", kind: "leg" },
  4: { key: "right-leg", label: "Right leg", kind: "leg" },
});

const ABILITIES = Object.freeze({
  1: { key: "str", label: "Strength" },
  2: { key: "dex", label: "Dexterity" },
  3: { key: "con", label: "Constitution" },
  4: { key: "int", label: "Intelligence" },
  5: { key: "wis", label: "Wisdom" },
  6: { key: "cha", label: "Charisma" },
});

export function getCriticalInjuryDefinition(key) {
  const normalized = String(key ?? "").trim();
  return (
    CRITICAL_INJURY_TABLE.find((entry) => entry.key === normalized) ?? null
  );
}

export function findCriticalInjuryByRoll(roll) {
  const value = Math.max(1, Math.min(100, Math.floor(Number(roll) || 1)));
  return (
    CRITICAL_INJURY_TABLE.find(
      (entry) => value >= entry.min && value <= entry.max,
    ) ?? CRITICAL_INJURY_TABLE[0]
  );
}

/** Return the table's displayed recovery formula without duplicating dice data. */
export function getCriticalInjuryRecoveryFormula(definition, fallback = 3) {
  if (definition?.permanent) return "Permanent";
  const configured = String(definition?.recoveryFormula ?? "").trim();
  if (configured) return configured;
  const min = Number(definition?.dayMin ?? fallback);
  const max = Number(definition?.dayMax ?? min);
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return String(Math.max(1, Math.floor(Number(fallback) || 3)));
  }
  const low = Math.max(1, Math.floor(Math.min(min, max)));
  const high = Math.max(low, Math.floor(Math.max(min, max)));
  if (low === high) return String(low);
  const span = high - low + 1;
  return low === 1 ? `1d${span}` : `1d${span}+${low - 1}`;
}

/** Interpret the secondary roll required by a few V2 entries. */
export function resolveCriticalInjuryDetail(definition, total) {
  const type = definition?.detailRoll?.type;
  const value = Math.max(1, Math.floor(Number(total) || 1));
  if (type === "body-part") {
    return { type, roll: value, ...(BODY_PARTS[value] ?? BODY_PARTS[1]) };
  }
  if (type === "ability") {
    return { type, roll: value, ...(ABILITIES[value] ?? ABILITIES[1]) };
  }
  if (type === "max-hp-loss") {
    return {
      type,
      roll: value,
      key: "max-hp-loss",
      label: `${value} maximum HP`,
      amount: value,
    };
  }
  return null;
}

export function buildCriticalInjuryEffectText(definition, detail = null) {
  const base = String(definition?.effect ?? "").trim();
  if (!detail?.label) return base;
  return `${base} Rolled detail: ${detail.label}.`;
}

/**
 * Build the exact Active Effect changes this injury can safely automate.
 * Narrative restrictions remain in the effect description when a blanket
 * numeric penalty would be less accurate than the table rule.
 */
export function buildCriticalInjuryChanges(
  definition,
  { detail = null, infectionHpLoss = 0 } = {},
  modes = {},
) {
  const ADD = Number(modes.ADD ?? 2);
  const MULTIPLY = Number(modes.MULTIPLY ?? 1);
  const OVERRIDE = Number(modes.OVERRIDE ?? 5);
  const priority = 20;
  const changes = [];
  const add = (key, value, mode = ADD) =>
    changes.push({ key, mode, value: String(value), priority });
  const disadvantage = (key) => add(`flags.midi-qol.${key}`, "1", OVERRIDE);

  switch (definition?.key) {
    case "lost-limb":
      if (detail?.kind === "leg") {
        add("system.attributes.movement.walk", "0.5", MULTIPLY);
      }
      break;
    case "crippling-injury":
      if (detail?.kind === "leg") {
        add("system.attributes.movement.walk", "0.5", MULTIPLY);
      } else if (detail?.kind === "arm") {
        disadvantage("disadvantage.attack.mwak");
        disadvantage("disadvantage.attack.rwak");
      }
      break;
    case "concussion":
      for (const ability of ["int", "wis"]) {
        disadvantage(`disadvantage.ability.check.${ability}`);
        disadvantage(`disadvantage.ability.save.${ability}`);
      }
      add("system.skills.prc.bonuses.passive", "-5");
      break;
    case "fractured-ribs":
      disadvantage("disadvantage.ability.save.dex");
      disadvantage("disadvantage.ability.check.con");
      break;
    case "deep-cut":
      add(
        "system.attributes.hp.bonuses.overall",
        `-${Math.max(1, Number(detail?.amount) || 1)}`,
      );
      break;
    case "loss-of-eye":
      disadvantage("disadvantage.skill.prc");
      disadvantage("disadvantage.attack.rwak");
      disadvantage("disadvantage.attack.rsak");
      break;
    case "shattered-knee":
      add("system.attributes.movement.walk", "0.5", MULTIPLY);
      break;
    case "dislocated-shoulder":
      disadvantage("disadvantage.ability.check.str");
      disadvantage("disadvantage.attack.mwak");
      disadvantage("disadvantage.attack.msak");
      break;
    case "infection":
      if (Number(infectionHpLoss) > 0) {
        add(
          "system.attributes.hp.bonuses.overall",
          `-${Math.floor(Number(infectionHpLoss))}`,
        );
      }
      break;
    case "deep-scar":
      add("system.skills.itm.bonuses.check", "+1");
      add("system.skills.per.bonuses.check", "-1");
      break;
    case "nerve-damage":
      if (detail?.key) add(`system.abilities.${detail.key}.value`, "-1");
      break;
    case "soul-shaken":
      add("system.abilities.wis.bonuses.save", "-1");
      break;
    default:
      break;
  }
  return changes;
}

export function treatmentSkillLabel(skill) {
  if (skill === "med") return "Medicine";
  if (skill === "ins") return "Insight";
  if (skill === "con") return "Constitution save";
  return "No check";
}
