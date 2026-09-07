/** New temporary outcomes for V3. Core numeric modifiers; no conditional roll flags. */
export const EXPANDED_CRITICAL_INJURIES = Object.freeze(
  [
    {
      key: "sprained-ankle",
      min: 9,
      max: 10,
      label: "Sprained Ankle",
      effect:
        "−2 to Acrobatics checks. The ankle aches when balancing or tumbling.",
      recovery:
        "1d3 days. 1 Healer's Kit charge stabilizes the injury and doubles recovery speed; it does not cure it immediately.",
      recoveryFormula: "1d3",
      dayMin: 1,
      dayMax: 3,
      kitCharges: 1,
      bodyRegion: "legs",
      mechanicalChanges: [
        {
          key: "system.skills.acr.bonuses.check",
          value: "-2",
        },
      ],
    },
    {
      key: "lingering-headache",
      min: 14,
      max: 15,
      label: "Lingering Headache",
      effect: "−1 to Intelligence checks, including skills using Intelligence.",
      recovery:
        "1d3 days. 1 Healer's Kit charge stabilizes the injury and doubles recovery speed; it does not cure it immediately.",
      recoveryFormula: "1d3",
      dayMin: 1,
      dayMax: 3,
      kitCharges: 1,
      bodyRegion: "head",
      mechanicalChanges: [
        {
          key: "system.abilities.int.bonuses.check",
          value: "-1",
        },
      ],
    },
    {
      key: "sprained-wrist",
      min: 19,
      max: 20,
      label: "Sprained Wrist",
      effect: "−2 to Sleight of Hand checks. Fine manipulation is painful.",
      recovery:
        "1d3 days. 1 Healer's Kit charge stabilizes the injury and doubles recovery speed; it does not cure it immediately.",
      recoveryFormula: "1d3",
      dayMin: 1,
      dayMax: 3,
      kitCharges: 1,
      bodyRegion: "arms",
      mechanicalChanges: [
        {
          key: "system.skills.slt.bonuses.check",
          value: "-2",
        },
      ],
    },
    {
      key: "bruised-ribs",
      min: 24,
      max: 25,
      label: "Bruised Ribs",
      effect: "−1 to Constitution saving throws. Deep breaths hurt.",
      recovery:
        "1d3 days. 1 Healer's Kit charge stabilizes the injury and doubles recovery speed; it does not cure it immediately.",
      recoveryFormula: "1d3",
      dayMin: 1,
      dayMax: 3,
      kitCharges: 1,
      bodyRegion: "torso",
      mechanicalChanges: [
        {
          key: "system.abilities.con.bonuses.save",
          value: "-1",
        },
      ],
    },
    {
      key: "winded",
      min: 29,
      max: 30,
      label: "Winded",
      effect: "−2 to Athletics checks. Sustained exertion is difficult.",
      recovery:
        "1d3 days. 1 Healer's Kit charge stabilizes the injury and doubles recovery speed; it does not cure it immediately.",
      recoveryFormula: "1d3",
      dayMin: 1,
      dayMax: 3,
      kitCharges: 1,
      bodyRegion: "torso",
      mechanicalChanges: [
        {
          key: "system.skills.ath.bonuses.check",
          value: "-2",
        },
      ],
    },
    {
      key: "pulled-back",
      min: 34,
      max: 35,
      label: "Pulled Back",
      effect: "−1 to Strength checks, including skills using Strength.",
      recovery:
        "1d4 days. 2 Healer's Kit charges stabilize the injury and double recovery speed; they do not cure it immediately.",
      recoveryFormula: "1d4",
      dayMin: 1,
      dayMax: 4,
      kitCharges: 2,
      bodyRegion: "torso",
      mechanicalChanges: [
        {
          key: "system.abilities.str.bonuses.check",
          value: "-1",
        },
      ],
    },
    {
      key: "strained-shoulder",
      min: 54,
      max: 55,
      label: "Strained Shoulder",
      effect:
        "−1 to melee weapon attack rolls. Swinging a weapon pulls at the shoulder.",
      recovery:
        "1d4 days. 2 Healer's Kit charges stabilize the injury and double recovery speed; they do not cure it immediately.",
      recoveryFormula: "1d4",
      dayMin: 1,
      dayMax: 4,
      kitCharges: 2,
      bodyRegion: "arms",
      mechanicalChanges: [
        {
          key: "system.bonuses.mwak.attack",
          value: "-1",
        },
      ],
    },
    {
      key: "feverish",
      min: 59,
      max: 60,
      label: "Feverish",
      effect: "−1 to Intelligence saving throws. Fever clouds the mind.",
      recovery:
        "1d3 days. 1 Healer's Kit charge stabilizes the injury and doubles recovery speed; it does not cure it immediately.",
      recoveryFormula: "1d3",
      dayMin: 1,
      dayMax: 3,
      kitCharges: 1,
      bodyRegion: "whole-body",
      mechanicalChanges: [
        {
          key: "system.abilities.int.bonuses.save",
          value: "-1",
        },
      ],
    },
    {
      key: "rattled-nerves",
      min: 64,
      max: 65,
      label: "Rattled Nerves",
      effect:
        "−1 to initiative rolls until recovery. Sudden danger provokes hesitation.",
      recovery:
        "1d3 days. 1 Healer's Kit charge stabilizes the injury and doubles recovery speed; it does not cure it immediately.",
      recoveryFormula: "1d3",
      dayMin: 1,
      dayMax: 3,
      kitCharges: 1,
      bodyRegion: "mind",
      mechanicalChanges: [
        {
          key: "system.attributes.init.bonus",
          value: "-1",
        },
      ],
    },
    {
      key: "blurred-vision",
      min: 66,
      max: 67,
      label: "Blurred Vision",
      effect: "−2 to Perception checks. Details are difficult to make out.",
      recovery:
        "1d3 days. 1 Healer's Kit charge stabilizes the injury and doubles recovery speed; it does not cure it immediately.",
      recoveryFormula: "1d3",
      dayMin: 1,
      dayMax: 3,
      kitCharges: 1,
      bodyRegion: "head",
      mechanicalChanges: [
        {
          key: "system.skills.prc.bonuses.check",
          value: "-2",
        },
      ],
    },
    {
      key: "drained-vitality",
      min: 68,
      max: 70,
      label: "Drained Vitality",
      effect:
        "−1 to Constitution checks. The character feels weak and depleted.",
      recovery:
        "1d3 days. 1 Healer's Kit charge stabilizes the injury and doubles recovery speed; it does not cure it immediately.",
      recoveryFormula: "1d3",
      dayMin: 1,
      dayMax: 3,
      kitCharges: 1,
      bodyRegion: "whole-body",
      mechanicalChanges: [
        {
          key: "system.abilities.con.bonuses.check",
          value: "-1",
        },
      ],
    },
    {
      key: "shaken-confidence",
      min: 86,
      max: 90,
      label: "Shaken Confidence",
      effect:
        "−1 to Wisdom checks, including skills using Wisdom. Self-doubt clouds judgment.",
      recovery:
        "1d3 days. 1 Healer's Kit charge stabilizes the injury and doubles recovery speed; it does not cure it immediately.",
      recoveryFormula: "1d3",
      dayMin: 1,
      dayMax: 3,
      kitCharges: 1,
      bodyRegion: "mind",
      mechanicalChanges: [
        {
          key: "system.abilities.wis.bonuses.check",
          value: "-1",
        },
      ],
    },
  ].map((entry) =>
    Object.freeze({
      ...entry,
      mechanicalChanges: Object.freeze(
        entry.mechanicalChanges.map(Object.freeze),
      ),
    }),
  ),
);
