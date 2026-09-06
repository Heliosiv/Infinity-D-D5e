/**
 * Merchant pricing macros.
 *
 * A macro is a bounded patch applied to an explicit set of merchants. City
 * grouping is resolved from the existing shop locations; no second
 * city/merchant relationship is stored here.
 */

import { locationDirectory } from "./locations.js";
import { commitMerchantBatch } from "./socket.js";
import { loadMerchants, normalizeMerchant } from "./store.js";

const FIELD_RULES = Object.freeze({
  defaultMarkup: Object.freeze({ min: 0.1, max: 5 }),
  sellRatio: Object.freeze({ min: 0, max: 1.5 }),
  bargainDC: Object.freeze({ min: 5, max: 30, integer: true }),
  bargainSuccessPct: Object.freeze({ min: 0, max: 100 }),
  bargainFailPct: Object.freeze({ min: 0, max: 100 }),
  passivePctPerPoint: Object.freeze({ min: 0, max: 20 }),
  passiveCapPct: Object.freeze({ min: 0, max: 100 }),
});

const PATCH_FIELDS = Object.freeze([
  ...Object.keys(FIELD_RULES),
  "passiveHaggle",
  "clearItemPriceOverrides",
]);

/** Normalize and validate a reusable merchant-pricing patch. */
export function normalizeMerchantPricingPatch(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const patch = {};

  for (const [field, rule] of Object.entries(FIELD_RULES)) {
    if (!Object.hasOwn(source, field)) continue;
    const value = Number(source[field]);
    if (
      !Number.isFinite(value) ||
      value < rule.min ||
      value > rule.max ||
      (rule.integer && !Number.isInteger(value))
    ) {
      throw new RangeError(
        `${field} must be ${rule.integer ? "a whole number " : ""}from ${rule.min} to ${rule.max}.`,
      );
    }
    patch[field] = value;
  }

  if (Object.hasOwn(source, "passiveHaggle")) {
    if (typeof source.passiveHaggle !== "boolean") {
      throw new TypeError("passiveHaggle must be true or false.");
    }
    patch.passiveHaggle = source.passiveHaggle;
  }
  if (source.clearItemPriceOverrides === true) {
    patch.clearItemPriceOverrides = true;
  }

  if (Object.keys(patch).length === 0) {
    throw new TypeError("Choose at least one pricing rule to apply.");
  }
  return Object.freeze(patch);
}

/** Apply one validated patch without mutating the original merchant. */
export function applyMerchantPricingPatch(merchant, input = {}) {
  const patch = normalizeMerchantPricingPatch(input);
  const next = { ...normalizeMerchant(merchant) };
  for (const field of PATCH_FIELDS) {
    if (!Object.hasOwn(patch, field) || field === "clearItemPriceOverrides") {
      continue;
    }
    next[field] = patch[field];
  }
  if (patch.clearItemPriceOverrides) {
    next.items = next.items.map((row) => ({
      ...row,
      priceOverrideGp: null,
    }));
  }
  return normalizeMerchant(next);
}

/**
 * Resolve a macro's explicit targets. `merchantIds` wins when supplied;
 * otherwise `locationId` resolves through the merchants' canonical shop
 * assignments. The special location id `all` selects every merchant.
 */
export function resolveMerchantPricingTargets(
  { merchantIds = [], locationId = "" } = {},
  { merchants = [], locations = [] } = {},
) {
  const availableIds = new Set(
    merchants.map((merchant) => cleanId(merchant?.id)).filter(Boolean),
  );
  const explicit = uniqueIds(merchantIds);
  let targetIds = explicit;

  if (targetIds.length === 0) {
    const scopeId = cleanId(locationId);
    if (scopeId === "all") {
      targetIds = [...availableIds];
    } else {
      const location = locations.find(
        (entry) => cleanId(entry?.id) === scopeId,
      );
      if (!location) {
        throw new Error(`LocationNotFound: ${scopeId || "(blank)"}`);
      }
      targetIds = merchants
        .filter(
          (merchant) => cleanId(merchant?.shop?.locationId) === scopeId,
        )
        .map((merchant) => merchant.id);
    }
  }

  if (targetIds.length === 0) {
    throw new Error("Choose at least one merchant.");
  }
  const missing = targetIds.filter((id) => !availableIds.has(id));
  if (missing.length > 0) {
    throw new Error(`MerchantNotFound: ${missing.join(", ")}`);
  }
  return Object.freeze(targetIds);
}

/** Build a deterministic review plan for a city or hand-picked merchant set. */
export function planMerchantPricingMacro(
  merchants,
  { merchantIds = [], patch = {} } = {},
) {
  const list = Array.isArray(merchants) ? merchants.map(normalizeMerchant) : [];
  const ids = resolveMerchantPricingTargets(
    { merchantIds },
    { merchants: list },
  );
  const normalizedPatch = normalizeMerchantPricingPatch(patch);
  const targets = new Set(ids);
  const changes = [];
  const nextMerchants = list.map((merchant) => {
    if (!targets.has(merchant.id)) return merchant;
    const next = applyMerchantPricingPatch(merchant, normalizedPatch);
    const fields = describeMerchantPricingChanges(merchant, next);
    if (fields.length > 0) {
      changes.push({
        merchantId: merchant.id,
        merchantName: merchant.name,
        fields,
        summary: fields.join("; "),
      });
    }
    return next;
  });
  return Object.freeze({
    merchantIds: ids,
    patch: normalizedPatch,
    targetedCount: ids.length,
    changedCount: changes.length,
    unchangedCount: ids.length - changes.length,
    changes: Object.freeze(changes),
    merchants: Object.freeze(nextMerchants),
  });
}

/** Stable signature used to invalidate an on-screen preview after edits. */
export function merchantPricingMacroSignature({
  merchantIds = [],
  patch = {},
}) {
  return JSON.stringify({
    merchantIds: uniqueIds(merchantIds).sort(),
    patch: normalizeMerchantPricingPatch(patch),
  });
}

/**
 * Apply a reviewed macro against fresh records under all target shop locks,
 * then return a canonical read-back plan.
 */
export async function applyMerchantPricingMacro(options = {}) {
  const before = loadMerchants();
  const locations = locationDirectory(before);
  const merchantIds = resolveMerchantPricingTargets(options, {
    merchants: before,
    locations,
  });
  const patch = normalizeMerchantPricingPatch(options.patch ?? options);
  const preview = planMerchantPricingMacro(before, { merchantIds, patch });
  if (preview.changedCount === 0) {
    return Object.freeze({ ...preview, verified: true });
  }

  const expectedIds = [...merchantIds].sort();
  await commitMerchantBatch(merchantIds, (current) => {
    const freshIds = resolveMerchantPricingTargets(options, {
      merchants: current,
      locations,
    }).sort();
    if (JSON.stringify(freshIds) !== JSON.stringify(expectedIds)) {
      throw new Error("MerchantPricingTargetsChanged");
    }
    const targets = new Set(merchantIds);
    return current.map((merchant) =>
      targets.has(merchant.id)
        ? applyMerchantPricingPatch(merchant, patch)
        : merchant,
    );
  });

  const after = loadMerchants();
  const readBack = planMerchantPricingMacro(after, { merchantIds, patch });
  if (readBack.changedCount !== 0) {
    throw new Error("MerchantPricingReadBackMismatch");
  }
  return Object.freeze({
    ...preview,
    merchants: Object.freeze(after),
    verified: true,
  });
}

function describeMerchantPricingChanges(before, after) {
  const descriptions = [];
  describeNumber(
    descriptions,
    "Buy price",
    before.defaultMarkup,
    after.defaultMarkup,
    2,
    "×",
  );
  describeNumber(
    descriptions,
    "Sell-back",
    before.sellRatio,
    after.sellRatio,
    2,
    "×",
  );
  describeNumber(
    descriptions,
    "Bargain DC",
    before.bargainDC,
    after.bargainDC,
    0,
  );
  describeNumber(
    descriptions,
    "Success discount",
    before.bargainSuccessPct,
    after.bargainSuccessPct,
    1,
    "%",
  );
  describeNumber(
    descriptions,
    "Failure penalty",
    before.bargainFailPct,
    after.bargainFailPct,
    1,
    "%",
  );
  if (before.passiveHaggle !== after.passiveHaggle) {
    descriptions.push(
      `Charm pricing ${before.passiveHaggle ? "on" : "off"} → ${after.passiveHaggle ? "on" : "off"}`,
    );
  }
  describeNumber(
    descriptions,
    "Charm shift",
    before.passivePctPerPoint,
    after.passivePctPerPoint,
    1,
    "%/point",
  );
  describeNumber(
    descriptions,
    "Charm cap",
    before.passiveCapPct,
    after.passiveCapPct,
    1,
    "%",
  );
  const cleared = before.items.filter(
    (row, index) =>
      row.priceOverrideGp != null &&
      after.items[index]?.priceOverrideGp == null,
  ).length;
  if (cleared > 0) {
    descriptions.push(
      `${cleared} item price override${cleared === 1 ? "" : "s"} cleared`,
    );
  }
  return descriptions;
}

function describeNumber(out, label, before, after, decimals, suffix = "") {
  if (Number(before) === Number(after)) return;
  out.push(
    `${label} ${Number(before).toFixed(decimals)}${suffix} → ${Number(after).toFixed(decimals)}${suffix}`,
  );
}

function cleanId(value) {
  return String(value ?? "").trim();
}

function uniqueIds(values) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : []).map(cleanId).filter(Boolean),
    ),
  ];
}
