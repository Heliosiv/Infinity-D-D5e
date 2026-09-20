/**
 * Foundry may add Item model defaults when embedding a purchased compendium
 * item. Only additive fields are tolerated; every planned value and the
 * module's purchase marker must remain intact.
 */
export function isAdditivePurchaseItemAfter(
  observed,
  expected,
  { itemId, merchantId, totalGp, qty } = {},
) {
  if (
    !observed ||
    !expected ||
    observed._id !== itemId ||
    expected._id !== itemId
  ) {
    return false;
  }
  const marker = expected.flags?.["infinity-dnd5e"]?.purchasedFromMerchant;
  return Boolean(
    marker?.operationId &&
    marker.merchantId === merchantId &&
    marker.pricePaidGp === totalGp &&
    expected.system?.quantity === qty &&
    containsAllPlannedFields(observed, expected),
  );
}

function containsAllPlannedFields(actual, expected) {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((entry, index) =>
        containsAllPlannedFields(actual[index], entry),
      )
    );
  }
  if (expected && typeof expected === "object") {
    return Boolean(
      actual &&
      typeof actual === "object" &&
      !Array.isArray(actual) &&
      Object.keys(expected).every(
        (key) =>
          Object.hasOwn(actual, key) &&
          containsAllPlannedFields(actual[key], expected[key]),
      ),
    );
  }
  return Object.is(actual, expected);
}
