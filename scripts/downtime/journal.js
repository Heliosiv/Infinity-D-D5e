/** Compact report archive, separate from the 100-block recovery history. */
export const DOWNTIME_JOURNAL_LIMIT = 200;
export function collectDowntimeJournal(store, extra = null) {
  const journal = structuredClone(store.journal ?? {});
  for (const block of [
    ...(store.history ?? []),
    store.activeBlock,
    extra,
  ].filter(Boolean)) {
    const receipts = {
      ...block.individualReceipts,
      ...block.result?.playerReceipts,
    };
    for (const [actorId, receipt] of Object.entries(receipts)) {
      if (!receipt || !receipt.activities) continue;
      const rows = journal[actorId] ?? [];
      const record = {
        blockId: block.id,
        locationName: block.locationName ?? block.settlementName,
        receipt,
      };
      const index = rows.findIndex((row) => row.blockId === block.id);
      if (index >= 0) rows[index] = record;
      else rows.push(record);
      journal[actorId] = rows
        .sort(
          (a, b) =>
            Number(a.receipt.completedAt) - Number(b.receipt.completedAt),
        )
        .slice(-DOWNTIME_JOURNAL_LIMIT);
    }
  }
  return journal;
}
