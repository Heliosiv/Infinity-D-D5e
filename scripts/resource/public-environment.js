const LABELS = [
  "Very easy",
  "Easy",
  "Moderate",
  "Hard",
  "Very hard",
  "Nearly impossible",
];

export function forageDifficulty(value) {
  if (value == null || value === "" || !Number.isFinite(Number(value)))
    return "";
  const dc = Number(value);
  return LABELS[
    dc <= 5 ? 0 : dc <= 10 ? 1 : dc <= 15 ? 2 : dc <= 20 ? 3 : dc <= 25 ? 4 : 5
  ];
}

/** Explicit allowlist: never send the DC or yield formula to a player. */
export function publicForageEnvironment(
  environment,
  { waterEnabled = true } = {},
) {
  if (!environment || typeof environment !== "object") return null;
  const safeLabel = (value) => (LABELS.includes(value) ? value : "");
  return {
    id: String(environment.id ?? "").slice(0, 160),
    label: String(environment.label ?? "Unknown").slice(0, 500),
    forageable: environment.forageable !== false,
    foodDifficulty:
      safeLabel(environment.foodDifficulty) ||
      forageDifficulty(environment.foodDc ?? environment.dc),
    waterDifficulty: waterEnabled
      ? safeLabel(environment.waterDifficulty) ||
        forageDifficulty(environment.waterDc ?? environment.dc)
      : "",
  };
}

export function forageDifficultyLabel(
  environment,
  { food = true, water = true } = {},
) {
  const safe = publicForageEnvironment(environment) ?? {};
  const foodLabel = food ? safe.foodDifficulty : "";
  const waterLabel = water ? safe.waterDifficulty : "";
  if (foodLabel && waterLabel && foodLabel === waterLabel) return foodLabel;
  return [
    foodLabel && `Food: ${foodLabel}`,
    waterLabel && `Water: ${waterLabel}`,
  ]
    .filter(Boolean)
    .join(" · ");
}
