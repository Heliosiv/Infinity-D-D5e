/**
 * Build the read-only summary used by the Shops directory.
 *
 * Keep this projection separate from MerchantWorkspaceApp so layout changes do
 * not acquire campaign-write responsibilities. The caller supplies the same
 * normalized rows already used by the directory.
 */
export function buildMerchantWorkspaceOverview({
  merchants = [],
  locations = [],
  sessions = [],
  transactionReviewCount = 0,
  selectedLocationId = null,
  accessClosed = false,
} = {}) {
  const merchantRows = Array.isArray(merchants) ? merchants : [];
  const sessionRows = Array.isArray(sessions) ? sessions : [];
  const hasSelectedLocation =
    selectedLocationId !== null && selectedLocationId !== undefined;
  const sessionCounts = new Map();
  for (const session of sessionRows) {
    const merchantId = cleanId(session?.merchantId);
    if (!merchantId) continue;
    sessionCounts.set(merchantId, (sessionCounts.get(merchantId) ?? 0) + 1);
  }

  const decoratedLocations = (Array.isArray(locations) ? locations : []).map(
    (location) => {
      const id = cleanId(location?.id);
      const shops = merchantRows.filter(
        (merchant) => cleanId(merchant?.locationId) === id,
      );
      const openCount = accessClosed
        ? 0
        : shops.filter((merchant) => merchant?.status === "Open").length;
      const emptyCount = shops.filter(
        (merchant) => Number(merchant?.itemCount) === 0,
      ).length;
      const activeSessionCount = shops.reduce(
        (total, merchant) =>
          total + (sessionCounts.get(cleanId(merchant?.id)) ?? 0),
        0,
      );
      const count = shops.length;
      const closedCount = Math.max(0, count - openCount);
      return {
        ...location,
        id,
        count,
        openCount,
        closedCount,
        emptyCount,
        activeSessionCount,
        hasAttention: emptyCount > 0,
        searchText: [location?.name, ...shops.map((shop) => shop?.name)]
          .join(" ")
          .toLocaleLowerCase(),
        selected: hasSelectedLocation && id === cleanId(selectedLocationId),
      };
    },
  );

  const openCount = accessClosed
    ? 0
    : merchantRows.filter((merchant) => merchant?.status === "Open").length;
  const emptyCount = merchantRows.filter(
    (merchant) => Number(merchant?.itemCount) === 0,
  ).length;
  const reviewCount = nonNegativeInteger(transactionReviewCount);
  const selectedLocation =
    decoratedLocations.find((location) => location.selected) ?? null;

  return {
    locations: decoratedLocations,
    selectedLocation,
    stats: {
      locationCount: decoratedLocations.filter((location) => location.id)
        .length,
      shopCount: merchantRows.length,
      openCount,
      closedCount: Math.max(0, merchantRows.length - openCount),
      emptyCount,
      activeSessionCount: sessionRows.length,
      reviewCount,
      hasAttention: emptyCount > 0 || reviewCount > 0,
    },
  };
}

function cleanId(value) {
  return String(value ?? "").trim();
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}
