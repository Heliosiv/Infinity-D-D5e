/** Versioned campaign injury tables and pure effect rules. */
import { LEGACY_CRITICAL_INJURY_TABLE } from "./table-v2.js";
import { EXPANDED_CRITICAL_INJURIES } from "./table-v3.js";
export const CRITICAL_INJURY_TABLE_VERSION = 3;
export const CRITICAL_INJURY_ROLL_FORMULA = "1d100";

const EXPANDED_BANDS = {
  "crippling-injury": [6, 8],
  concussion: [11, 13],
  "broken-arm": [16, 18],
  "fractured-ribs": [21, 23],
  "internal-bleeding": [26, 28],
  "deep-cut": [31, 33],
  "dislocated-shoulder": [51, 53],
  infection: [56, 58],
  "minor-injury": [61, 63],
  "psychic-trauma": [81, 85],
};
export const CRITICAL_INJURY_TABLE = Object.freeze(
  [
    ...LEGACY_CRITICAL_INJURY_TABLE.map((entry) => {
      const band = EXPANDED_BANDS[entry.key];
      return Object.freeze(
        band ? { ...entry, min: band[0], max: band[1] } : { ...entry },
      );
    }),
    ...EXPANDED_CRITICAL_INJURIES,
  ].sort((a, b) => a.min - b.min),
);

export function getCriticalInjuryTable(
  version = CRITICAL_INJURY_TABLE_VERSION,
) {
  if (Number(version) === 2) return LEGACY_CRITICAL_INJURY_TABLE;
  if (Number(version) === CRITICAL_INJURY_TABLE_VERSION)
    return CRITICAL_INJURY_TABLE;
  return [];
}

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

export function getCriticalInjuryDefinition(
  key,
  version = CRITICAL_INJURY_TABLE_VERSION,
) {
  const normalized = String(key ?? "").trim();
  return (
    getCriticalInjuryTable(version).find((entry) => entry.key === normalized) ??
    null
  );
}

export function findCriticalInjuryByRoll(
  roll,
  version = CRITICAL_INJURY_TABLE_VERSION,
) {
  const table = getCriticalInjuryTable(version);
  const value = Math.max(1, Math.min(100, Math.floor(Number(roll) || 1)));
  return (
    table.find((entry) => value >= entry.min && value <= entry.max) ??
    table[0] ??
    null
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

  for (const change of definition?.mechanicalChanges ?? [])
    add(change.key, change.value);

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
