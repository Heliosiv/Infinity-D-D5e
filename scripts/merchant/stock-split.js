/** Integer percentages for selected stock types; the total is always 100. */
export function normalizeStockTypeShares(types, raw = {}) {
  const selected = [
    ...new Set(Array.isArray(types) ? types.filter(Boolean) : []),
  ];
  if (!selected.length) return {};
  const weights = selected.map((type) => {
    const value = Number(raw?.[type]);
    return Number.isFinite(value) && value > 0 ? Math.min(100, value) : 0;
  });
  const total = weights.reduce((sum, value) => sum + value, 0);
  const shares = total
    ? weights.map((value) => (value * 100) / total)
    : selected.map(() => 100 / selected.length);
  const rounded = shares.map(Math.floor);
  let remaining = 100 - rounded.reduce((sum, value) => sum + value, 0);
  const order = selected
    .map((_, index) => index)
    .sort((a, b) => shares[b] - rounded[b] - (shares[a] - rounded[a]) || a - b);
  for (const index of order) {
    if (remaining-- <= 0) break;
    rounded[index] += 1;
  }
  return Object.fromEntries(
    selected.map((type, index) => [type, rounded[index]]),
  );
}

/** Keep the edited share fixed while distributing the rest among other types. */
export function editStockTypeShare(types, current, editedType, value) {
  const selected = [...new Set(types)];
  if (!selected.includes(editedType))
    return normalizeStockTypeShares(selected, current);
  const fixed = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  const others = selected.filter((type) => type !== editedType);
  if (!others.length) return { [editedType]: 100 };
  const prior = normalizeStockTypeShares(selected, current);
  return {
    ...allocateStockUnits(100 - fixed, others, prior),
    [editedType]: fixed,
  };
}

/** Divide integer units (copper pieces or line caps) without losing any. */
export function allocateStockUnits(total, types, shares) {
  const units = Math.max(0, Math.floor(Number(total) || 0));
  const selected = [...new Set(types)];
  const normalized = normalizeStockTypeShares(selected, shares);
  const exact = selected.map((type) => (units * normalized[type]) / 100);
  const rounded = exact.map(Math.floor);
  let leftover = units - rounded.reduce((sum, n) => sum + n, 0);
  for (const index of selected
    .map((_, i) => i)
    .sort((a, b) => exact[b] - rounded[b] - (exact[a] - rounded[a]) || a - b)) {
    if (leftover-- <= 0) break;
    rounded[index] += 1;
  }
  return Object.fromEntries(selected.map((type, i) => [type, rounded[i]]));
}
