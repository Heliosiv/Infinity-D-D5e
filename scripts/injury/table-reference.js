/** Read-only audit notes for the canonical V2 table; no rule or Actor writes. */
import {
  CRITICAL_INJURY_TABLE,
  CRITICAL_INJURY_TABLE_VERSION,
  getCriticalInjuryRecoveryFormula,
  treatmentSkillLabel,
} from "./table.js";

export const INJURY_AUTOMATION_AUDIT = Object.freeze({
  "lost-limb": {
    status: "partial",
    automatic: "A rolled leg halves walking speed.",
    manual:
      "Arm equipment restrictions and restoration by magic require the GM. Other movement speeds are unchanged.",
  },
  "crippling-injury": {
    status: "partial",
    midi: true,
    automatic:
      "A rolled leg halves walking speed. A rolled arm adds disadvantage to all weapon attacks.",
    manual:
      "The penalty is not limited to the injured limb. Limb-dependent checks and shield protection are not enforced.",
  },
  concussion: {
    status: "automated",
    midi: true,
    automatic:
      "Intelligence/Wisdom check and save disadvantage; passive Perception −5.",
    manual:
      "Ability-linked skill rolls need installed-world verification; the effect emits ability-check flags, not individual skill flags.",
  },
  "broken-arm": {
    status: "manual",
    automatic: "Injury, recovery deadline, and kit downgrade are recorded.",
    manual:
      "Weapon, shield, and somatic-component restrictions are not enforced.",
    recoveryNote:
      "Kit treatment halves remaining days and then doubles recovery speed: roughly one quarter of the original remaining time, not simply half.",
  },
  "fractured-ribs": {
    status: "partial",
    midi: true,
    automatic: "Dexterity-save and Constitution-check disadvantage.",
    manual: "The GM must apply the 1d4 damage from Dashing.",
  },
  "internal-bleeding": {
    status: "automated",
    automatic:
      "Combat start rolls 1d6; on a 1, rolls 1d4 and subtracts it from current HP.",
    manual:
      "Damage bypasses temporary HP and the system damage workflow. Combat duplicate protection lasts only for the current GM session.",
    recoveryNote:
      "Automatically expires after 3 days even though the written rule requires treatment or magic.",
  },
  "deep-cut": {
    status: "automated",
    automatic:
      "Rolled 1d6 maximum-HP reduction is applied through an Active Effect.",
    manual:
      "The one-hour rest plus Medicine alternative has no dedicated action.",
    recoveryNote:
      "Automatically expires after 1 day despite 'until treated'. The kit path also requires DC 13 Medicine, although the text assigns that check to the rest alternative.",
  },
  "loss-of-eye": {
    status: "automated",
    midi: true,
    automatic:
      "Perception disadvantage and ranged weapon/spell attack disadvantage.",
    manual: "Magical restoration requires the GM to remove the injury.",
  },
  "loss-of-hearing": {
    status: "manual",
    automatic: "Permanent injury is recorded.",
    manual:
      "Sound-based Perception disadvantage and magical restoration require the GM.",
  },
  "shattered-knee": {
    status: "partial",
    automatic:
      "Walking speed is halved; untreated deadline converts the injury to permanent.",
    manual: "Dash is not blocked. Other movement speeds are unchanged.",
  },
  "dislocated-shoulder": {
    status: "automated",
    midi: true,
    automatic: "Strength-check and melee weapon/spell attack disadvantage.",
    manual:
      "Strength-linked skill rolls need installed-world verification; only the ability-check flag is emitted.",
  },
  infection: {
    status: "automated",
    automatic:
      "Long-rest DC 15 Constitution save; each failure adds 1 maximum-HP loss. Saved rest receipts prevent duplicate application.",
    manual:
      "A confirmed rest and active GM are required; interrupted work uses the existing recovery flow.",
    recoveryNote:
      "Automatically expires after 3 days although the written recovery lists only 2 kit charges.",
  },
  "minor-injury": {
    status: "narrative",
    automatic:
      "Recovery is tracked; the table intentionally has no combat penalty.",
    manual: "Describe bruising, limping, or other cosmetic consequences.",
  },
  "deep-scar": {
    status: "partial",
    automatic: "Intimidation +1 and Persuasion −1 are applied continuously.",
    manual:
      "Visibility is not checked. The GM must account for a concealed scar.",
  },
  "psychic-trauma": {
    status: "manual",
    automatic: "Injury and recovery are recorded.",
    manual: "Fear/charm-only save disadvantage is not implemented.",
  },
  "nerve-damage": {
    status: "automated",
    automatic:
      "The rolled ability is reduced by 1. Failed treatment makes it permanent.",
    manual: "The GM still decides magical or narrative restoration.",
    recoveryNote:
      "Also becomes permanent at the untreated 7-day deadline; the table text only specifies a failed Constitution treatment save.",
  },
  nightmares: {
    status: "manual",
    automatic: "Injury and recovery are recorded.",
    manual:
      "First daily initiative disadvantage and blocking exhaustion recovery on long rests are not implemented. Remove Curse is not detected.",
    recoveryNote:
      "Automatically expires after 7 days even though the written rule requires Remove Curse or 4 kit charges.",
  },
  "soul-shaken": {
    status: "automated",
    automatic: "Wisdom saves receive a permanent −1 bonus.",
    manual:
      "Divine magic or quest resolution requires the GM to remove the injury.",
  },
});

const STATUS_LABELS = {
  automated: "Effect supported",
  partial: "Partly automated",
  manual: "GM applies effect",
  narrative: "No combat penalty",
};

export function buildCriticalInjuryTableReference() {
  return CRITICAL_INJURY_TABLE.map((definition) => {
    const audit = INJURY_AUTOMATION_AUDIT[definition.key];
    return {
      ...definition,
      range:
        definition.min === definition.max
          ? String(definition.min)
          : `${definition.min}–${definition.max}`,
      tableVersion: CRITICAL_INJURY_TABLE_VERSION,
      recoveryFormula: getCriticalInjuryRecoveryFormula(definition),
      detailFormula: definition.detailRoll?.formula ?? "",
      treatment:
        definition.kitCharges > 0
          ? `${definition.kitCharges} kit charge(s)${definition.treatmentDc ? ` + DC ${definition.treatmentDc} ${treatmentSkillLabel(definition.treatmentSkill)}` : ""}; stabilizes recovery`
          : "No kit treatment",
      status: audit?.status ?? "manual",
      statusLabel: STATUS_LABELS[audit?.status] ?? "Needs audit",
      automatic:
        audit?.automatic ?? "Automation has not been reviewed for this entry.",
      manual: audit?.manual ?? "GM review required.",
      recoveryNote: audit?.recoveryNote ?? "",
      requiresMidi: audit?.midi === true,
    };
  });
}
