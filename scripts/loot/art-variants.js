/**
 * Infinity D&D5e - Art treasure variants
 *
 * Turns reusable art-object base items into specific rolled treasures.
 * The original compendium entry stays intact; the loot result receives
 * a generated display name and appraisal summary while preserving the
 * base market gp value.
 */

import { getItemGpValue, getItemKeywords } from "./tag-vocabulary.js";

const ART_CONDITIONS = Object.freeze([
  {
    id: "chipped",
    prefix: "Chipped",
    summary: "visible damage is noted for sale negotiation",
  },
  {
    id: "smoke-darkened",
    prefix: "Smoke-Darkened",
    summary: "age and grime need careful cleaning",
  },
  {
    id: "patinaed",
    prefix: "Patinaed",
    summary: "age is visible but not damaging",
  },
  {
    id: "well-kept",
    prefix: "Well-Kept",
    summary: "condition matches the expected market value",
  },
  {
    id: "restored",
    prefix: "Restored",
    summary: "competent restoration is visible",
  },
  {
    id: "masterwork",
    prefix: "Masterwork",
    summary: "fine workmanship stands out",
  },
  {
    id: "signed",
    prefix: "Signed",
    summary: "a maker's mark may attract collectors",
  },
]);

const ART_PROVENANCES = Object.freeze([
  {
    id: "unknown-workshop",
    label: "Unknown workshop",
    summary: "no known provenance",
  },
  {
    id: "merchant-estate",
    label: "Merchant estate",
    summary: "estate papers support a normal resale",
  },
  {
    id: "minor-noble",
    label: "Minor noble house",
    summary: "minor noble provenance adds prestige",
  },
  {
    id: "temple-commission",
    label: "Temple commission",
    summary: "religious buyers may pay a premium",
  },
  {
    id: "lost-dynasty",
    label: "Lost dynasty",
    summary: "rare provenance makes the piece harder to price",
  },
]);

const ART_MARKETS = Object.freeze([
  {
    id: "cold-market",
    label: "Cold market",
    summary: "current buyers are scarce",
  },
  {
    id: "steady-market",
    label: "Steady market",
    summary: "ordinary luxury resale",
  },
  {
    id: "collector-interest",
    label: "Collector interest",
    summary: "a collector would likely bid above baseline",
  },
  {
    id: "court-fashion",
    label: "Court fashion",
    summary: "court taste is pushing the price up",
  },
]);

const ART_DETAILS_BY_CATEGORY = Object.freeze({
  "wall-art": Object.freeze([
    {
      id: "gilt-frame",
      label: "Gilt frame",
      summary: "gilded framing helps display",
    },
    {
      id: "rare-pigments",
      label: "Rare pigments",
      summary: "rare pigments remain vivid",
    },
    {
      id: "faded-panel",
      label: "Faded panel",
      summary: "some color has faded",
    },
    {
      id: "court-subject",
      label: "Court subject",
      summary: "the subject has noble appeal",
    },
  ]),
  sculpture: Object.freeze([
    {
      id: "fine-carving",
      label: "Fine carving",
      summary: "the carving is unusually precise",
    },
    {
      id: "missing-inlay",
      label: "Missing inlay",
      summary: "lost inlay is visible",
    },
    {
      id: "rare-stone",
      label: "Rare stone",
      summary: "uncommon material draws buyer interest",
    },
    {
      id: "portable-scale",
      label: "Portable scale",
      summary: "easy transport improves liquidity",
    },
  ]),
  jewelry: Object.freeze([
    {
      id: "matched-stones",
      label: "Matched stones",
      summary: "matched stones are intact",
    },
    {
      id: "loose-setting",
      label: "Loose setting",
      summary: "repair is needed before resale",
    },
    {
      id: "fashionable-cut",
      label: "Fashionable cut",
      summary: "the cut is currently in demand",
    },
    {
      id: "old-clasp",
      label: "Old clasp",
      summary: "the clasp limits practical wear",
    },
  ]),
  decorative: Object.freeze([
    {
      id: "delicate-metalwork",
      label: "Delicate metalwork",
      summary: "metalwork quality is notable",
    },
    {
      id: "ritual-use",
      label: "Ritual use",
      summary: "ritual associations add a buyer niche",
    },
    {
      id: "awkward-display",
      label: "Awkward display",
      summary: "display and transport are inconvenient",
    },
    {
      id: "complete-set",
      label: "Complete set",
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
  const gpValue = baseGp;
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
    valueLabel: "",
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
  const generatedTreasure = {
    schema: "infinity-generated-treasure-v1",
    kind: "art",
    sourceUuid,
    sourceName: variant.baseName,
    variantId: variant.id,
    baseGp: variant.baseGp,
    gpValue: variant.gpValue,
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

  return itemData;
}

export function getVariableTreasureKind(item) {
  return String(
    item?.flags?.["infinity-dnd5e"]?.variableTreasureKind ??
      item?.flags?.["party-operations"]?.variableTreasureKind ??
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
    )} has a market value of ${variant.gpValue.toLocaleString()} gp.</p>`,
    `<p><strong>Appraisal notes:</strong> ${escapeHtml(variant.summary)}</p>`,
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
    item?.flags?.["infinity-dnd5e"] ?? item?.flags?.["party-operations"] ?? {};
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

function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
