/**
 * Infinity D&D5e - Art treasure variants
 *
 * Turns reusable art-object base items into specific rolled treasures.
 * The original compendium entry stays intact; the loot result receives
 * a generated display name, appraisal summary, and adjusted gp value.
 */

import { getItemGpValue, getItemKeywords } from "./tag-vocabulary.js";

const ART_CONDITIONS = Object.freeze([
  {
    id: "chipped",
    prefix: "Chipped",
    multiplier: 0.6,
    summary: "visible damage lowers the appraisal",
  },
  {
    id: "smoke-darkened",
    prefix: "Smoke-Darkened",
    multiplier: 0.8,
    summary: "age and grime need careful cleaning",
  },
  {
    id: "patinaed",
    prefix: "Patinaed",
    multiplier: 0.95,
    summary: "age is visible but not damaging",
  },
  {
    id: "well-kept",
    prefix: "Well-Kept",
    multiplier: 1,
    summary: "condition matches the expected market value",
  },
  {
    id: "restored",
    prefix: "Restored",
    multiplier: 1.15,
    summary: "competent restoration improves its sale price",
  },
  {
    id: "masterwork",
    prefix: "Masterwork",
    multiplier: 1.5,
    summary: "fine workmanship raises the appraisal",
  },
  {
    id: "signed",
    prefix: "Signed",
    multiplier: 1.85,
    summary: "a maker's mark attracts collectors",
  },
]);

const ART_PROVENANCES = Object.freeze([
  {
    id: "unknown-workshop",
    label: "Unknown workshop",
    multiplier: 0.9,
    summary: "no known provenance",
  },
  {
    id: "merchant-estate",
    label: "Merchant estate",
    multiplier: 1.05,
    summary: "estate papers support a normal resale",
  },
  {
    id: "minor-noble",
    label: "Minor noble house",
    multiplier: 1.18,
    summary: "minor noble provenance adds prestige",
  },
  {
    id: "temple-commission",
    label: "Temple commission",
    multiplier: 1.25,
    summary: "religious buyers may pay a premium",
  },
  {
    id: "lost-dynasty",
    label: "Lost dynasty",
    multiplier: 1.55,
    summary: "rare provenance makes the piece harder to price",
  },
]);

const ART_MARKETS = Object.freeze([
  {
    id: "cold-market",
    label: "Cold market",
    multiplier: 0.85,
    summary: "current buyers are scarce",
  },
  {
    id: "steady-market",
    label: "Steady market",
    multiplier: 1,
    summary: "ordinary luxury resale",
  },
  {
    id: "collector-interest",
    label: "Collector interest",
    multiplier: 1.2,
    summary: "a collector would likely bid above baseline",
  },
  {
    id: "court-fashion",
    label: "Court fashion",
    multiplier: 1.35,
    summary: "court taste is pushing the price up",
  },
]);

const ART_DETAILS_BY_CATEGORY = Object.freeze({
  "wall-art": Object.freeze([
    {
      id: "gilt-frame",
      label: "Gilt frame",
      multiplier: 1.08,
      summary: "gilded framing improves display value",
    },
    {
      id: "rare-pigments",
      label: "Rare pigments",
      multiplier: 1.18,
      summary: "rare pigments remain vivid",
    },
    {
      id: "faded-panel",
      label: "Faded panel",
      multiplier: 0.82,
      summary: "some color has faded",
    },
    {
      id: "court-subject",
      label: "Court subject",
      multiplier: 1.12,
      summary: "the subject has noble appeal",
    },
  ]),
  sculpture: Object.freeze([
    {
      id: "fine-carving",
      label: "Fine carving",
      multiplier: 1.16,
      summary: "the carving is unusually precise",
    },
    {
      id: "missing-inlay",
      label: "Missing inlay",
      multiplier: 0.78,
      summary: "lost inlay reduces the price",
    },
    {
      id: "rare-stone",
      label: "Rare stone",
      multiplier: 1.22,
      summary: "uncommon material raises buyer interest",
    },
    {
      id: "portable-scale",
      label: "Portable scale",
      multiplier: 1.06,
      summary: "easy transport improves liquidity",
    },
  ]),
  jewelry: Object.freeze([
    {
      id: "matched-stones",
      label: "Matched stones",
      multiplier: 1.2,
      summary: "matched stones increase the appraisal",
    },
    {
      id: "loose-setting",
      label: "Loose setting",
      multiplier: 0.75,
      summary: "repair is needed before resale",
    },
    {
      id: "fashionable-cut",
      label: "Fashionable cut",
      multiplier: 1.18,
      summary: "the cut is currently in demand",
    },
    {
      id: "old-clasp",
      label: "Old clasp",
      multiplier: 0.9,
      summary: "the clasp limits practical wear",
    },
  ]),
  decorative: Object.freeze([
    {
      id: "delicate-metalwork",
      label: "Delicate metalwork",
      multiplier: 1.14,
      summary: "metalwork quality raises the appraisal",
    },
    {
      id: "ritual-use",
      label: "Ritual use",
      multiplier: 1.1,
      summary: "ritual associations add a buyer niche",
    },
    {
      id: "awkward-display",
      label: "Awkward display",
      multiplier: 0.86,
      summary: "display and transport are inconvenient",
    },
    {
      id: "complete-set",
      label: "Complete set",
      multiplier: 1.25,
      summary: "all matching pieces are still present",
    },
  ]),
});

/**
 * Does this item represent a variable art-object base.
 *
 * Spell scrolls and magic consumables sometimes carry treasure-adjacent
 * tags, so we only promote actual loot/art-object entries.
 */
export function isVariableArtItem(item) {
  const kind = getVariableTreasureKind(item);
  if (kind === "art") return true;
  if (kind && kind !== "art") return false;

  const keywords = new Set(getItemKeywords(item));
  const hasArtTag =
    keywords.has("treasure.art") ||
    keywords.has("loot.variable.art") ||
    keywords.has("merchant.art");
  if (!hasArtTag) return false;

  const folderPath = getFolderPathKey(item);
  if (folderPath.includes("art-objects")) return true;
  return String(item?.type ?? "").trim() === "loot";
}

/** Generate a specific art-object variant for a rolled loot result. */
export function createArtVariant(item, { rng = Math.random } = {}) {
  const baseGp = getItemGpValue(item);
  const condition = pick(ART_CONDITIONS, rng);
  const provenance = pick(ART_PROVENANCES, rng);
  const category = inferArtCategory(item);
  const detail = pick(ART_DETAILS_BY_CATEGORY[category], rng);
  const market = pick(ART_MARKETS, rng);
  const multiplier = clampMultiplier(
    condition.multiplier *
      provenance.multiplier *
      detail.multiplier *
      market.multiplier,
  );
  const gpValue = roundArtGp(baseGp * multiplier);
  const baseName = String(item?.name ?? "Art Object").trim() || "Art Object";
  const displayName = `${condition.prefix} ${baseName}`;

  return {
    kind: "art",
    id: [
      "art",
      slugify(baseName),
      condition.id,
      provenance.id,
      detail.id,
      market.id,
    ].join("-"),
    baseName,
    displayName,
    category,
    gpValue,
    baseGp,
    valueMultiplier: Number(multiplier.toFixed(2)),
    valueLabel: `${formatMultiplier(multiplier)} base value`,
    summary: [
      detail.summary,
      provenance.summary,
      market.summary,
      condition.summary,
    ].join("; "),
    condition,
    provenance,
    detail,
    market,
  };
}

/** Build a Foundry-item-shaped source snapshot for a generated art result. */
export function createArtVariantItemData(item, variant, { quantity = 1 } = {}) {
  const itemData = clonePlain(item);
  const sourceUuid = item?.uuid ?? item?.flags?.core?.sourceId ?? "";
  const safeQuantity = Math.max(1, Math.floor(Number(quantity) || 1));

  delete itemData._id;
  delete itemData.id;
  delete itemData.uuid;

  itemData.name = variant.displayName;
  itemData.type = itemData.type || "loot";
  itemData.img = item?.img ?? itemData.img ?? "icons/svg/item-bag.svg";
  itemData.system = clonePlain(itemData.system);
  itemData.system.quantity = safeQuantity;
  itemData.system.price = {
    ...(itemData.system.price ?? {}),
    value: variant.gpValue,
    denomination: itemData.system.price?.denomination ?? "gp",
  };
  itemData.system.description = {
    ...(itemData.system.description ?? {}),
    value: appendAppraisalHtml(
      itemData.system.description?.value ?? "",
      variant,
    ),
    chat: `<p><strong>${escapeHtml(variant.displayName)}</strong></p><p>${escapeHtml(
      variant.summary,
    )}</p>`,
  };

  itemData.flags = clonePlain(itemData.flags);
  const nativeFlags = clonePlain(itemData.flags["infinity-dnd5e"]);
  const legacyFlags = clonePlain(itemData.flags["party-operations"]);
  const generatedTreasure = {
    schema: "infinity-generated-treasure-v1",
    kind: "art",
    sourceUuid,
    sourceName: variant.baseName,
    variantId: variant.id,
    baseGp: variant.baseGp,
    gpValue: variant.gpValue,
    valueMultiplier: variant.valueMultiplier,
    condition: variant.condition.id,
    provenance: variant.provenance.id,
    detail: variant.detail.id,
    market: variant.market.id,
    summary: variant.summary,
  };

  itemData.flags["infinity-dnd5e"] = {
    ...nativeFlags,
    gpValue: variant.gpValue,
    sellValueGp: Math.floor(variant.gpValue / 2),
    generatedTreasure,
  };
  itemData.flags["party-operations"] = {
    ...legacyFlags,
    gpValue: variant.gpValue,
    sellValueGp: Math.floor(variant.gpValue / 2),
    generatedTreasure,
  };

  return itemData;
}

export function getVariableTreasureKind(item) {
  return String(
    item?.flags?.["party-operations"]?.variableTreasureKind ??
      item?.flags?.["infinity-dnd5e"]?.variableTreasureKind ??
      item?.variableTreasureKind ??
      "",
  )
    .trim()
    .toLowerCase();
}

function appendAppraisalHtml(existingHtml, variant) {
  const existing = String(existingHtml ?? "").trim();
  const appraisal = [
    "<hr />",
    `<p><strong>Generated appraisal:</strong> ${escapeHtml(
      variant.displayName,
    )} is worth ${variant.gpValue.toLocaleString()} gp (${escapeHtml(
      variant.valueLabel,
    )}).</p>`,
    `<p>${escapeHtml(variant.summary)}</p>`,
  ].join("");
  return existing ? `${existing}${appraisal}` : appraisal;
}

function clonePlain(value) {
  if (!value || typeof value !== "object") return {};
  return JSON.parse(JSON.stringify(value));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inferArtCategory(item) {
  const haystack = [
    getFolderPathKey(item),
    String(item?.name ?? ""),
    getItemKeywords(item).join(" "),
  ]
    .join(" ")
    .toLowerCase();

  if (
    haystack.includes("wall-art") ||
    /\b(banner|chart|mosaic|painting|portrait|tapestry|triptych)\b/.test(
      haystack,
    )
  ) {
    return "wall-art";
  }
  if (
    haystack.includes("sculptures-idols") ||
    /\b(bust|idol|mask|relief|statue|statuette)\b/.test(haystack)
  ) {
    return "sculpture";
  }
  if (
    haystack.includes("jewelry") ||
    /\b(broach|brooch|bracelet|crown|gem|necklace|pendant|ring)\b/.test(
      haystack,
    )
  ) {
    return "jewelry";
  }
  return "decorative";
}

function getFolderPathKey(item) {
  const flags =
    item?.flags?.["party-operations"] ?? item?.flags?.["infinity-dnd5e"] ?? {};
  const explicit = String(
    flags?.folder?.pathKey ?? flags?.details?.folderPathKey ?? "",
  )
    .trim()
    .toLowerCase();
  if (explicit) return explicit;

  const folderKeyword = getItemKeywords(item).find((keyword) =>
    String(keyword).startsWith("folder.path."),
  );
  return String(folderKeyword ?? "")
    .replace(/^folder\.path\./, "")
    .replace(/\./g, "/")
    .trim()
    .toLowerCase();
}

function pick(values, rng) {
  const index = Math.min(
    values.length - 1,
    Math.max(0, Math.floor(rng() * values.length)),
  );
  return values[index];
}

/**
 * The lowest and highest realized-value multipliers any art variant can
 * produce, after condition × provenance × detail × market. Exported so
 * the roller can reason about the realized-gp range without duplicating
 * the clamp constants.
 */
export const MIN_ART_MULTIPLIER = 0.35;
export const MAX_ART_MULTIPLIER = 2.75;

function clampMultiplier(value) {
  return Math.min(MAX_ART_MULTIPLIER, Math.max(MIN_ART_MULTIPLIER, value));
}

function roundArtGp(value) {
  const safe = Number.isFinite(value) && value > 0 ? value : 0;
  if (safe <= 0) return 0;
  if (safe < 50) return Math.max(1, Math.round(safe));
  if (safe < 250) return Math.max(5, Math.round(safe / 5) * 5);
  if (safe < 1000) return Math.max(25, Math.round(safe / 25) * 25);
  return Math.max(100, Math.round(safe / 100) * 100);
}

function formatMultiplier(value) {
  return `${Number(value.toFixed(2))}x`;
}

function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
