#!/usr/bin/env node
/**
 * Generate spell-specific consumable scrolls from the bundled spell entries.
 *
 * The curated pack already ships dnd5e spell documents as `loot.spell`, but
 * the loot UI exposes a Scroll bucket (`loot.scroll`). This script creates real
 * consumable scroll item documents for every bundled spell so generated loot
 * can be dragged/deposited as inventory items instead of bare spell documents.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const PACK_PATH = "packs/infinity-dnd5e-items.db";
const GENERATED_SCHEMA = "infinity-dnd5e-spell-scroll-v1";
const GENERATED_KEYWORD = "source.infinity-dnd5e.spell-scrolls";
const GENERATED_AT = "2026-05-30T00:00:00.000Z";
const GENERATED_TIME = Date.UTC(2026, 4, 30, 12, 0, 0);
const MODULE_ID = "infinity-dnd5e";

const ID_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

const SCROLL_RULES =
  "A spell scroll bears the words of a single spell, written in a mystical cipher. If the spell is on your class's spell list, you can read the scroll and cast its spell without providing any material components. Otherwise, the scroll is unintelligible. Casting the spell by reading the scroll requires the spell's normal casting time. Once the spell is cast, the words on the scroll fade, and it crumbles to dust.";

const LEVEL_FALLBACKS = Object.freeze({
  0: {
    label: "Cantrip",
    price: 10,
    rarity: "common",
    rarityNormalized: "common",
    tier: "tier.t1",
    valueBand: "value.v1",
    img: "icons/sundries/scrolls/scroll-bound-orange-tan.webp",
  },
  1: {
    label: "1st Level",
    price: 60,
    rarity: "common",
    rarityNormalized: "common",
    tier: "tier.t1",
    valueBand: "value.v2",
    img: "icons/sundries/scrolls/scroll-bound-orange-tan.webp",
  },
  2: {
    label: "2nd Level",
    price: 120,
    rarity: "uncommon",
    rarityNormalized: "uncommon",
    tier: "tier.t2",
    valueBand: "value.v2",
    img: "icons/sundries/scrolls/scroll-bound-gold-brown.webp",
  },
  3: {
    label: "3rd Level",
    price: 200,
    rarity: "uncommon",
    rarityNormalized: "uncommon",
    tier: "tier.t2",
    valueBand: "value.v3",
    img: "icons/sundries/scrolls/scroll-bound-gold-brown.webp",
  },
  4: {
    label: "4th Level",
    price: 320,
    rarity: "rare",
    rarityNormalized: "rare",
    tier: "tier.t3",
    valueBand: "value.v3",
    img: "icons/sundries/scrolls/scroll-plain-red.webp",
  },
  5: {
    label: "5th Level",
    price: 640,
    rarity: "rare",
    rarityNormalized: "rare",
    tier: "tier.t3",
    valueBand: "value.v3",
    img: "icons/sundries/scrolls/scroll-plain-red.webp",
  },
  6: {
    label: "6th Level",
    price: 1280,
    rarity: "veryRare",
    rarityNormalized: "very-rare",
    tier: "tier.t4",
    valueBand: "value.v4",
    img: "icons/sundries/scrolls/scroll-bound-sealed-red-green.webp",
  },
  7: {
    label: "7th Level",
    price: 2560,
    rarity: "veryRare",
    rarityNormalized: "very-rare",
    tier: "tier.t4",
    valueBand: "value.v4",
    img: "icons/sundries/scrolls/scroll-bound-sealed-red-green.webp",
  },
  8: {
    label: "8th Level",
    price: 5120,
    rarity: "veryRare",
    rarityNormalized: "very-rare",
    tier: "tier.t4",
    valueBand: "value.v5",
    img: "icons/sundries/scrolls/scroll-bound-sealed-red-green.webp",
  },
  9: {
    label: "9th Level",
    price: 5120,
    rarity: "legendary",
    rarityNormalized: "legendary",
    tier: "tier.t4",
    valueBand: "value.v5",
    img: "icons/sundries/scrolls/scroll-runed-brown-purple.webp",
  },
});

const rawItems = readPack(PACK_PATH);
const itemsWithoutGenerated = rawItems.filter(
  (item) => !isGeneratedSpellScroll(item),
);
const retaggedItems = itemsWithoutGenerated.map((item) =>
  isGenericSpellScroll(item) ? retagGenericSpellScroll(item) : item,
);
const spells = retaggedItems
  .filter(isSourceSpell)
  .sort((a, b) => {
    const byLevel = Number(a.system?.level ?? 0) - Number(b.system?.level ?? 0);
    if (byLevel !== 0) return byLevel;
    return String(a.name ?? "").localeCompare(String(b.name ?? ""));
  });

const templates = collectScrollTemplates(retaggedItems);
const generated = spells.map((spell) =>
  createSpellScroll(spell, templates.get(normalizeLevel(spell.system?.level))),
);

const usedIds = new Set(retaggedItems.map((item) => item._id));
for (const item of generated) {
  assert.ok(!usedIds.has(item._id), `generated duplicate id ${item._id}`);
  usedIds.add(item._id);
}

const outputItems = [...retaggedItems, ...generated];
writePack(PACK_PATH, outputItems);

process.stdout.write(
  `generated ${generated.length} spell scrolls from ${spells.length} spells (${rawItems.length} -> ${outputItems.length} pack items)\n`,
);

function readPack(file) {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function writePack(file, items) {
  const text = `${items.map((item) => JSON.stringify(item)).join("\n")}\n`;
  writeFileSync(file, text, "utf8");
}

function isGeneratedSpellScroll(item) {
  const flags = item?.flags?.[MODULE_ID]?.spellScroll;
  if (flags?.schema === GENERATED_SCHEMA) return true;
  const keywords = item?.flags?.["party-operations"]?.keywords;
  return Array.isArray(keywords) && keywords.includes(GENERATED_KEYWORD);
}

function isGenericSpellScroll(item) {
  return (
    item?.type === "consumable" &&
    item?.system?.type?.value === "scroll" &&
    /^Spell Scroll (?:Cantrip|\d+(?:st|nd|rd|th) Level)$/i.test(
      String(item?.name ?? ""),
    )
  );
}

function isSourceSpell(item) {
  return (
    item?.type === "spell" &&
    item?.flags?.["party-operations"]?.lootType === "loot.spell" &&
    item?.flags?.["party-operations"]?.keywords?.includes("source.dnd5e.spells")
  );
}

function retagGenericSpellScroll(item) {
  const out = clone(item);
  const po = (out.flags ??= {})["party-operations"] ?? {};
  out.flags["party-operations"] = normalizeScrollFlags(po, {
    sourceClass: "generated",
    extraKeywords: ["source.dnd5e.items"],
  });
  delete out.flags["party-operations"].variableTreasureKind;
  delete out.variableTreasureKind;
  return out;
}

function normalizeScrollFlags(po, { sourceClass, extraKeywords = [] } = {}) {
  const gpValue = Number(po.gpValue ?? 0);
  const keywords = uniqueSorted([
    ...cleanScrollKeywords(po.keywords ?? []),
    ...extraKeywords,
    "economy.sellable",
    "folder.family.spells",
    "folder.path.spells.spell-scrolls",
    "folder.section.spell-scrolls",
    "foundryType.consumable",
    "loot",
    "loot.scroll",
    "merchant.arcana",
    "merchant.consumable",
    "merchant.loot",
    "merchant.magic",
    "merchant.scroll",
    "merchant.spell",
    "price.gp",
    `rarity.${po.rarityNormalized ?? ""}`,
    "sale.standard",
    `tier.${stripPrefix(po.tier, "tier.")}`,
    "subtype.scroll",
    po.valueBand,
  ]);

  return {
    ...po,
    keywords,
    lootType: "loot.scroll",
    sourceClass: sourceClass ?? po.sourceClass ?? "generated",
  };
}

function cleanScrollKeywords(keywords) {
  const removed = new Set([
    "foundryType.spell",
    "loot.consumable",
    "loot.spell",
    "loot.variable",
    "loot.variable.art",
    "merchant.art",
    "treasure.art",
  ]);
  return keywords.filter((keyword) => {
    const value = String(keyword ?? "").trim();
    if (!value || removed.has(value)) return false;
    if (/^folder\.path\.spells\.level-\d+$/.test(value)) return false;
    if (/^folder\.section\.level-\d+$/.test(value)) return false;
    if (value === "folder.path.spells.cantrips") return false;
    if (value === "folder.section.cantrips") return false;
    if (/^rarity\./.test(value)) return false;
    if (/^tier\./.test(value)) return false;
    if (/^value\.v\d+$/.test(value)) return false;
    return true;
  });
}

function collectScrollTemplates(items) {
  const templates = new Map();
  for (const item of items) {
    if (!isGenericSpellScroll(item)) continue;
    const level = levelFromGenericScrollName(item.name);
    if (level === null) continue;
    templates.set(level, item);
  }
  for (const [level, fallback] of Object.entries(LEVEL_FALLBACKS)) {
    const numericLevel = Number(level);
    if (!templates.has(numericLevel)) {
      templates.set(numericLevel, fallbackTemplate(numericLevel, fallback));
    }
  }
  return templates;
}

function createSpellScroll(spell, template) {
  const level = normalizeLevel(spell.system?.level);
  const fallback = LEVEL_FALLBACKS[level] ?? LEVEL_FALLBACKS[9];
  const templatePo = template?.flags?.["party-operations"] ?? {};
  const sourcePo = spell.flags?.["party-operations"] ?? {};
  const id = deterministicId(spell._id);
  const name = `Spell Scroll: ${spell.name}`;
  const spellUuid = sourcePo.details?.coreSourceId
    ? sourcePo.details.coreSourceId
    : `Compendium.dnd5e.spells.Item.${spell._id}`;
  const gpValue = Number(templatePo.gpValue ?? fallback.price);
  const rarityNormalized = templatePo.rarityNormalized ?? fallback.rarityNormalized;
  const tier = templatePo.tier ?? fallback.tier;
  const valueBand = templatePo.valueBand ?? fallback.valueBand;
  const activityEntries = Object.entries(spell.system?.activities ?? {});
  const activities =
    activityEntries.length > 0
      ? Object.fromEntries(
          activityEntries.map(([activityId, activity]) => [
            activityId,
            scrollActivity(activity, spell.name),
          ]),
        )
      : clone(template.system?.activities ?? {});

  const po = {
    ...sourcePo,
    keywords: scrollKeywords(sourcePo, {
      rarityNormalized,
      tier,
      valueBand,
      level,
    }),
    lootType: "loot.scroll",
    tier,
    rarityNormalized,
    gpValue,
    valueBand,
    taggedAt: GENERATED_AT,
    tagSchema: "po-loot-v3",
    details: {
      ...(sourcePo.details ?? {}),
      schema: "po-item-enrichment-v3",
      itemType: "consumable",
      activityCount: activityEntries.length || Object.keys(activities).length,
      effectCount: Array.isArray(spell.effects) ? spell.effects.length : 0,
      hasDescription: true,
      coreSourceId: spellUuid,
      folderPathKey: "spells/spell-scrolls",
      folderLabels: ["Spells", "Spell Scrolls"],
      primaryMode: "usable",
      activityTypes: uniqueSorted(
        Object.values(activities).map((activity) => activity?.type).filter(Boolean),
      ),
      activationTypes: uniqueSorted(
        Object.values(activities)
          .map((activity) => activity?.activation?.type)
          .filter(Boolean),
      ),
      transferEffectCount: 0,
      appliedEffectCount: Array.isArray(spell.effects) ? spell.effects.length : 0,
    },
    pricingSource: "spell-scroll-template",
    priceDenomination: "gp",
    merchantCategories: ["arcana", "consumable", "loot", "magic", "scroll", "spell"],
    saleLiquidity: "sale.standard",
    lootWeight: Number(sourcePo.lootWeight ?? templatePo.lootWeight ?? 1),
    maxRecommendedQty: 1,
    lootEligible: true,
    sellValueGp: Math.floor(gpValue / 2),
    folder: clone(
      templatePo.folder ?? {
        schema: "po-loot-folder-v1",
        familyKey: "spells",
        familyLabel: "Spells",
        sectionKey: "spell-scrolls",
        sectionLabel: "Spell Scrolls",
        leafKey: "",
        leafLabel: "",
        path: [
          { key: "spells", label: "Spells", sort: 4000 },
          { key: "spell-scrolls", label: "Spell Scrolls", sort: 4200 },
        ],
        pathLabels: ["Spells", "Spell Scrolls"],
        pathKeys: ["spells", "spell-scrolls"],
        pathKey: "spells/spell-scrolls",
      },
    ),
    usability: {
      ...(sourcePo.usability ?? {}),
      schema: "po-loot-usage-v1",
      isUsable: true,
      primaryMode: "usable",
      activityCount: activityEntries.length || Object.keys(activities).length,
      activityTypes: uniqueSorted(
        Object.values(activities).map((activity) => activity?.type).filter(Boolean),
      ),
      primaryActivityType: Object.values(activities)[0]?.type ?? "utility",
      activationTypes: uniqueSorted(
        Object.values(activities)
          .map((activity) => activity?.activation?.type)
          .filter(Boolean),
      ),
      effectCount: Array.isArray(spell.effects) ? spell.effects.length : 0,
      transferEffectCount: 0,
      appliedEffectCount: Array.isArray(spell.effects) ? spell.effects.length : 0,
    },
    sourceClass: "generated",
    sourcePolicy: sourcePo.sourcePolicy ?? "normal",
    curationScore: sourcePo.curationScore ?? 8,
    scrollSource: {
      schema: GENERATED_SCHEMA,
      spellId: spell._id,
      spellName: spell.name,
      spellLevel: level,
      school: spell.system?.school ?? "",
      sourceUuid: spellUuid,
    },
    art: {
      ...(templatePo.art ?? {}),
      schema: "infinity-dnd5e-art-assignment-v1",
      mode: "reusable",
      assetId: "shared/consumable-spells-spell-scrolls",
      plannedPath: "assets/item-art/shared/consumable-spells-spell-scrolls.webp",
      fallbackIcon: template.img ?? fallback.img,
      generated: false,
    },
  };
  delete po.variableTreasureKind;

  const nativeFlags = {
    ...(template?.flags?.[MODULE_ID] ?? {}),
    descriptionState: {
      schema: "infinity-dnd5e-description-state-v1",
      identified: true,
      unidentified: true,
    },
    art: clone(po.art),
    spellScroll: {
      schema: GENERATED_SCHEMA,
      sourceSpellId: spell._id,
      sourceSpellName: spell.name,
      sourceSpellUuid: spellUuid,
      spellLevel: level,
      generatedAt: GENERATED_AT,
    },
  };

  return {
    _id: id,
    name,
    type: "consumable",
    img: template.img ?? fallback.img,
    system: {
      ...clone(template.system ?? {}),
      description: {
        value: buildIdentifiedDescription({ id, name, spell, level, gpValue, rarityNormalized }),
        chat: buildChatDescription(name, spell, level),
      },
      source: sourceForScroll(spell.system?.source),
      quantity: 1,
      weight: clone(template.system?.weight ?? { value: 0, units: "lb" }),
      price: { value: gpValue, denomination: "gp" },
      attunement: "",
      equipped: false,
      rarity: template.system?.rarity ?? fallback.rarity,
      identified: true,
      uses: clone(template.system?.uses ?? {
        max: "1",
        recovery: [],
        autoDestroy: true,
        spent: 0,
      }),
      damage: clone(template.system?.damage ?? {
        base: {
          number: null,
          denomination: null,
          types: [],
          custom: { enabled: false },
          scaling: { number: 1 },
        },
        replace: false,
      }),
      unidentified: {
        description: buildUnidentifiedDescription(id),
      },
      type: clone(template.system?.type ?? { value: "scroll", subtype: "" }),
      activities,
      identifier: `spell-scroll-${spell.system?.identifier ?? slugify(spell.name)}`,
      container: null,
      attuned: false,
      magicalBonus: null,
      properties: [],
    },
    effects: clone(spell.effects ?? []),
    folder: template.folder ?? null,
    flags: {
      ...(clone(template.flags ?? {})),
      core: { sourceId: spellUuid },
      "party-operations": po,
      [MODULE_ID]: nativeFlags,
    },
    _stats: {
      compendiumSource: spellUuid,
      duplicateSource: spell._id,
      coreVersion: "12.343",
      systemId: "dnd5e",
      systemVersion: "4.4.4",
      createdTime: GENERATED_TIME,
      modifiedTime: GENERATED_TIME,
      lastModifiedBy:
        template?._stats?.lastModifiedBy ??
        spell?._stats?.lastModifiedBy ??
        "dnd5ebuilder0000",
    },
    sort: 0,
    ownership: clone(template.ownership ?? { default: 0 }),
  };
}

function scrollActivity(activity, spellName) {
  const out = clone(activity);
  out.activation = {
    ...(out.activation ?? {}),
    condition: appendCondition(
      out.activation?.condition,
      "Spell must be on the caster's spell list.",
    ),
  };
  out.consumption = {
    ...(out.consumption ?? {}),
    targets: [
      {
        type: "itemUses",
        target: "",
        value: "1",
        scaling: { mode: "", formula: "" },
      },
    ],
    scaling: out.consumption?.scaling ?? { allowed: false, max: "" },
    spellSlot: true,
  };
  out.description = {
    ...(out.description ?? {}),
    chatFlavor: `Cast ${spellName} from a spell scroll.`,
  };
  return out;
}

function scrollKeywords(sourcePo, { rarityNormalized, tier, valueBand, level }) {
  return uniqueSorted([
    ...cleanScrollKeywords(sourcePo.keywords ?? []),
    GENERATED_KEYWORD,
    "economy.sellable",
    "folder.family.spells",
    "folder.path.spells.spell-scrolls",
    "folder.section.spell-scrolls",
    "foundryType.consumable",
    "loot",
    "loot.scroll",
    "merchant.arcana",
    "merchant.consumable",
    "merchant.loot",
    "merchant.magic",
    "merchant.scroll",
    "merchant.spell",
    "price.gp",
    `rarity.${rarityNormalized}`,
    "sale.standard",
    "source.class.generated",
    "source.dnd5e.spells",
    "source.policy.normal",
    "subtype.scroll",
    `tier.${stripPrefix(tier, "tier.")}`,
    valueBand,
    `spell.level.${level}`,
  ]);
}

function sourceForScroll(source) {
  const out = clone(source ?? {});
  if (!out.custom) out.custom = "Infinity D&D5e generated spell scroll";
  out.rules ??= "2014";
  out.revision ??= 1;
  return out;
}

function buildIdentifiedDescription({ id, name, spell, level, gpValue, rarityNormalized }) {
  const spellBody = extractSpellBody(spell.system?.description?.value);
  const levelLabel = level === 0 ? "cantrip" : `${ordinal(level)}-level`;
  return `<section class="infinity-item-description infinity-item-description--identified" data-schema="infinity-dnd5e-description-state-v1" data-identification-state="identified" data-item-id="${escapeHtml(id)}"><header class="infinity-item-state-header"><p><strong>Identified State:</strong> ${escapeHtml(name)}</p></header><div class="infinity-item-body" data-content="rules"><p>${escapeHtml(SCROLL_RULES)}</p><p><strong>Stored Spell:</strong> ${escapeHtml(spell.name)} (${escapeHtml(levelLabel)} ${escapeHtml(spell.system?.school ?? "spell")}).</p>${spellBody}</div><aside class="infinity-item-state" data-content="metadata"><p><strong>Item State</strong></p><ul class="infinity-item-state-list"><li>Consumable, Scroll</li><li>Rarity: ${escapeHtml(titleCase(rarityNormalized))}</li><li>Value: ${gpValue.toLocaleString()} gp</li><li>1 use(s)</li><li>Stored spell: ${escapeHtml(spell.name)}</li><li>Planned icon: shared asset</li></ul></aside></section>`;
}

function buildChatDescription(name, spell, level) {
  const levelLabel = level === 0 ? "cantrip" : `${ordinal(level)}-level`;
  return `<p><strong>${escapeHtml(name)}</strong></p><p>A consumable spell scroll containing ${escapeHtml(spell.name)}, a ${escapeHtml(levelLabel)} spell.</p>`;
}

function buildUnidentifiedDescription(id) {
  return `<section class="infinity-item-description infinity-item-description--unidentified" data-schema="infinity-dnd5e-description-state-v1" data-identification-state="unidentified" data-item-id="${escapeHtml(id)}"><p><em>A sealed scroll awaiting identification.</em></p><p>This sealed scroll is described by paper stock, ink, and binding. Its practical use is apparent, but exact value and spell formula still need inspection.</p><ul class="infinity-item-state-list"><li>Visible form: Sealed Scroll</li><li>Inspection cues: paper stock, ink, and binding</li><li>Identification state: Unidentified</li><li>Icon plan: Shared custom art queued</li></ul></section>`;
}

function extractSpellBody(html) {
  const text = String(html ?? "").trim();
  if (!text) return "";
  const match = text.match(
    /<div class="infinity-item-body"[^>]*>([\s\S]*?)<\/div>\s*<aside/i,
  );
  const body = match?.[1]?.trim() || text;
  return `<hr />${body}`;
}

function fallbackTemplate(level, fallback) {
  return {
    name: `Spell Scroll ${fallback.label}`,
    type: "consumable",
    img: fallback.img,
    system: {
      source: { custom: "SRD 5.1", revision: 1, rules: "2014" },
      quantity: 1,
      weight: { value: 0, units: "lb" },
      price: { value: fallback.price, denomination: "gp" },
      rarity: fallback.rarity,
      identified: true,
      uses: { max: "1", recovery: [], autoDestroy: true, spent: 0 },
      type: { value: "scroll", subtype: "" },
      activities: {},
      identifier: `spell-scroll-${level}`,
      properties: [],
    },
    flags: {
      "party-operations": {
        keywords: [],
        lootType: "loot.scroll",
        tier: fallback.tier,
        rarityNormalized: fallback.rarityNormalized,
        gpValue: fallback.price,
        valueBand: fallback.valueBand,
        lootWeight: 1,
      },
    },
    ownership: { default: 0 },
  };
}

function levelFromGenericScrollName(name) {
  const raw = String(name ?? "");
  if (/cantrip/i.test(raw)) return 0;
  const match = raw.match(/Spell Scroll (\d+)(?:st|nd|rd|th) Level/i);
  return match ? normalizeLevel(match[1]) : null;
}

function normalizeLevel(value) {
  const level = Math.floor(Number(value));
  if (!Number.isFinite(level)) return 0;
  return Math.max(0, Math.min(9, level));
}

function deterministicId(spellId) {
  const hash = createHash("sha256")
    .update(`${GENERATED_SCHEMA}:${spellId}`)
    .digest();
  let out = "";
  for (let index = 0; index < 16; index += 1) {
    out += ID_ALPHABET[hash[index] % ID_ALPHABET.length];
  }
  return out;
}

function uniqueSorted(values) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))].sort();
}

function stripPrefix(value, prefix) {
  const text = String(value ?? "").trim();
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

function appendCondition(existing, condition) {
  const current = String(existing ?? "").trim();
  if (!current) return condition;
  if (current.includes(condition)) return current;
  return `${current} ${condition}`;
}

function ordinal(level) {
  const value = Number(level);
  if (value === 1) return "1st";
  if (value === 2) return "2nd";
  if (value === 3) return "3rd";
  return `${value}th`;
}

function titleCase(value) {
  return String(value ?? "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}
