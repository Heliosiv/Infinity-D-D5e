/** Explicit recovery rules. Saved V2/V3 injuries keep their original timers. */
export const TREATMENT_RECOVERY = Object.freeze({
  "internal-bleeding": {
    recovery:
      "3 Healer's Kit charges and a moderate Medicine check, or GM-confirmed suitable magical healing. Successful treatment cures immediately.",
    methods: ["kit", "magic"],
    dc: 15,
  },
  "deep-cut": {
    recovery:
      "1 Healer's Kit charge without a check, or 1 hour of rest and a moderate Medicine check. Successful treatment cures immediately.",
    methods: ["kit", "rest"],
    dc: 0,
  },
  infection: {
    recovery:
      "2 Healer's Kit charges without a check cures the infection and removes its maximum-HP penalty. It does not restore current HP.",
    methods: ["kit"],
    dc: 0,
  },
  nightmares: {
    recovery:
      "Remove Curse or 4 Healer's Kit charges without a check cures Nightmares completely.",
    methods: ["kit", "magic"],
    dc: 0,
  },
});

export function requiresInjuryTreatment(injury) {
  return (
    Number(injury?.tableVersion) === 4 &&
    Object.hasOwn(TREATMENT_RECOVERY, injury?.injuryKey ?? "")
  );
}

export function injuryTreatmentMethods(injury) {
  return requiresInjuryTreatment(injury)
    ? TREATMENT_RECOVERY[injury.injuryKey].methods
    : ["kit"];
}

export function treatmentMethodLabel(method, injury) {
  if (method === "rest") return "Completed 1 hour of rest + Medicine";
  if (method === "magic")
    return injury.injuryKey === "nightmares"
      ? "GM confirms Remove Curse"
      : "GM confirms suitable magical healing";
  return "Healer's Kit";
}
