/** Guided crafting quotes and verified, recoverable inventory transactions. */
import { FIELD_OUTPUT } from "./field-ammunition.js";
import {
  quoteFieldAmmunition,
  projectFieldAmmunition,
} from "./field-ammunition-work.js";
import {
  readWalletStrict,
  updateCurrencyVerified,
  walletsEqual,
} from "../merchant/currency.js";
import {
  createActorItemVerified,
  deleteActorItemVerified,
  findActorItem,
  merchantItemId,
  updateActorItemQuantityVerified,
} from "../merchant/write-verification.js";
import {
  AMMUNITION_RECIPES,
  actorHasAnyTool,
  collectionValues,
  normalizeItemName,
  planWalletDeltaCp,
  resolveItemSnapshot,
} from "./items.js";
import {
  FLETCHERS_TOOLS_NAME,
  normalizeRequiredTools,
  requiredToolNames,
} from "./tool-requirements.js";
import {
  learningProblems,
  learningRates,
  normalizeSpellLearning,
  prepareLearnedSpell,
  spellEdition,
} from "./spell-learning.js";

const MODULE_ID = "infinity-dnd5e";
export const WORK_DAY_HOURS = 8;
// 2024 Basic Rules, Equipment: Spell Scroll Costs. Components are additional.
export const SCROLL_WORK = Object.freeze([
  [1, 15],
  [1, 25],
  [3, 100],
  [5, 150],
  [10, 1000],
  [25, 1500],
  [40, 10000],
  [50, 12500],
  [60, 15000],
  [120, 50000],
]);
export const WORK_OUTPUT_OPTIONS = Object.freeze(
  [
    ["none", "Costs / resources only"],
    [FIELD_OUTPUT, "Field ammunition (Drakmor house rules)"],
    ["arrows", "Arrows (20 per batch)"],
    ["bolts", "Crossbow bolts (20 per batch)"],
    ["needles", "Blowgun needles (20 per batch)"],
    ["sling-bullets", "Sling bullets (20 per batch)"],
    ["scroll", "Scribe an owned spell or copy an owned spell scroll"],
    ["learn-spell", "Learn Spell — Copy into Spellbook"],
    ["item", "Craft a configured item"],
  ].map(([id, label]) => Object.freeze({ id, label })),
);
const OUTPUT_IDS = new Set(WORK_OUTPUT_OPTIONS.map(({ id }) => id));
const clone = (value) => structuredClone(value);
const sourceOf = (item) => item?.toObject?.() ?? item;
const quantityOf = (item) => Number(sourceOf(item)?.system?.quantity ?? 0);
const money = (cp) => `${Number((cp / 100).toFixed(2))} gp`;
const cleanName = (value) =>
  String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 100);

function number(
  value,
  label,
  { max = 100000, min = 0, integer = false, fallback = 0 } = {},
) {
  const n = value === undefined || value === "" ? fallback : Number(value);
  if (
    !Number.isFinite(n) ||
    n < min ||
    n > max ||
    (integer
      ? !Number.isInteger(n)
      : Math.abs(n * 100 - Math.round(n * 100)) > 0.000001)
  ) {
    throw new Error(
      `${label}: enter ${integer ? "a whole number" : "a number with at most two decimal places"} from ${min} to ${max}.`,
    );
  }
  return n;
}

/** Reject invalid economic configuration; never silently turn a bad cost into free work. */
export function normalizeGuidedWork(raw) {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Invalid activity costs.");
  const output = String(raw.output ?? "none");
  if (!OUTPUT_IDS.has(output))
    throw new Error("Choose a supported crafting result.");
  if (output === FIELD_OUTPUT)
    return {
      output,
      fieldRiskPercent: number(
        raw.fieldRiskPercent,
        "Gathering complication percent per hour",
        { min: 0, max: 100, fallback: 5 },
      ),
    };
  const materials = (Array.isArray(raw.materials) ? raw.materials : []).filter(
    (entry) => cleanName(entry?.name),
  );
  if (materials.length > 4)
    throw new Error("Use at most four material requirements.");
  const requiredTools = normalizeRequiredTools(raw.requiredTools);
  const work = {
    output,
    ...(output === "learn-spell"
      ? { learning: normalizeSpellLearning(raw.learning) }
      : {}),
    gpPerBlock: number(raw.gpPerBlock, "GP per block"),
    gpPerDay: number(raw.gpPerDay, "GP per day"),
    batchGp: number(raw.batchGp, "GP per finished batch"),
    batchHours: number(raw.batchHours, "Hours per batch", {
      min: 1,
      max: 10000,
      integer: true,
      fallback: 8,
    }),
    quantity: number(raw.quantity, "Items per batch", {
      min: 1,
      max: 1000,
      integer: true,
      fallback: 1,
    }),
    itemUuid: String(raw.itemUuid ?? "")
      .trim()
      .slice(0, 300),
    tool: cleanName(raw.tool),
    ...(requiredTools.length ? { requiredTools } : {}),
    materials: materials.map((entry) => {
      const per = String(entry.per ?? "batch");
      if (!["block", "day", "batch"].includes(per))
        throw new Error("Choose a material cost basis.");
      return {
        name: cleanName(entry.name),
        quantity: number(entry.quantity, "Material quantity", {
          min: 1,
          max: 10000,
          integer: true,
        }),
        per,
      };
    }),
  };
  if (
    new Set(work.materials.map((entry) => normalizeItemName(entry.name)))
      .size !== work.materials.length
  ) {
    throw new Error("Combine duplicate material names into one requirement.");
  }
  if (
    work.materials.some((entry) =>
      requiredToolNames(work).some(
        (name) => normalizeItemName(entry.name) === normalizeItemName(name),
      ),
    )
  ) {
    throw new Error("A required tool cannot also be consumed as a material.");
  }
  if (
    output === "none" &&
    work.materials.some((entry) => entry.per === "batch")
  )
    throw new Error(
      "For an activity without crafted items, consume materials per block or per workday.",
    );
  if (["none", "scroll", "learn-spell"].includes(output)) work.batchGp = 0;
  if (
    output === "item" &&
    !/^(Item\.[A-Za-z0-9]+|Compendium\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.Item\.[A-Za-z0-9]+)$/.test(
      work.itemUuid,
    )
  ) {
    throw new Error(
      "Choose an Item UUID from a world item or compendium for the crafting result.",
    );
  }
  if (
    output === "none" &&
    !work.gpPerBlock &&
    !work.gpPerDay &&
    !work.batchGp &&
    !work.materials.length &&
    !work.tool &&
    !requiredTools.length
  )
    return null;
  return work;
}

export function guidedWorkPreset(output) {
  if (output === "learn-spell")
    return {
      id: "guided-learn-spell",
      name: "Learn Spell — Copy into Spellbook",
      blockHours: 1,
      description:
        "Copy a GM-approved Wizard spell into your carried spellbook. Learning is permanent and protected from DDB reimports; preparation is separate.",
      image: "icons/sundries/books/book-open-purple.webp",
      skills: [],
      work: normalizeGuidedWork({ output }),
      outcomes: [
        "Study recorded",
        "Careful transcription",
        "Spellbook progress",
      ].map((label) => ({
        label,
        report:
          "Your recorded study advances the spellbook project. Completion and any scroll check are listed below.",
        rewardGp: 0,
      })),
    };
  const scroll = output === "scroll";
  const ammo = AMMUNITION_RECIPES[output];
  if (!scroll && !ammo) throw new Error("Unknown crafting preset.");
  return {
    id: "",
    name: scroll ? "Scribe a Spell Scroll" : `Craft ${ammo.label}`,
    description: scroll
      ? "Scribe a spell from your sheet, or copy an owned scroll with GM approval. Your original is kept. Check spell prerequisites and components with the GM."
      : `Make usable ${ammo.label.toLowerCase()}. Work carries over between blocks. Required tools are kept.`,
    image: scroll
      ? "icons/sundries/scrolls/scroll-bound-red-tan.webp"
      : "icons/weapons/ammunition/arrows-war-white.webp",
    skills: [],
    work: normalizeGuidedWork({
      output,
      batchGp: scroll
        ? 0
        : Math.ceil((ammo.unitMarketCp * ammo.batchSize) / 2) / 100,
      batchHours: 8,
      ...(output === "arrows" ? { requiredTools: [FLETCHERS_TOOLS_NAME] } : {}),
    }),
    outcomes: ["Work completed", "Careful work", "Fine craftsmanship"].map(
      (label) => ({
        label,
        report:
          "Your work advances by the assigned hours. Finished batches and any remaining progress are listed below.",
        rewardGp: 0,
      }),
    ),
  };
}

export function scrollSourceLevel(item) {
  const source = sourceOf(item);
  if (!source) return null;
  const scroll =
    source.type === "consumable" &&
    source.system?.type?.value === "scroll" &&
    quantityOf(source) > 0;
  if (source.type !== "spell" && !scroll) return null;
  const value =
    source.type === "spell"
      ? source.system?.level
      : (source.flags?.dnd5e?.spellLevel?.value ??
        source.flags?.[MODULE_ID]?.spellScroll?.spellLevel);
  const level = Number(value);
  return value !== undefined &&
    Number.isInteger(level) &&
    level >= 0 &&
    level <= 9
    ? level
    : null;
}

// Quantities and Foundry housekeeping do not change the identity of supplies.
export function identity(item) {
  const source = clone(sourceOf(item) ?? {});
  for (const key of ["_id", "id", "_stats", "sort", "folder", "ownership"])
    delete source[key];
  if (source.system) delete source.system.quantity;
  // Foundry's server escapes ampersands in HTML fields on creation (including
  // D&D5e's &Reference[...] links). Compare equivalent text, not wire encoding.
  for (const field of ["value", "unidentified"]) {
    if (typeof source.system?.description?.[field] === "string")
      source.system.description[field] = source.system.description[
        field
      ].replace(/&amp;/g, "&");
  }
  const stable = (value) =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, stable(value[key])]),
          )
        : value;
  return JSON.stringify(stable(source));
}

export function matchMaterial(actor, name, excluded = new Set()) {
  return collectionValues(actor?.items)
    .filter(
      (item) =>
        !excluded.has(item.id ?? item._id) &&
        normalizeItemName(item.name) === normalizeItemName(name) &&
        Number.isInteger(quantityOf(item)) &&
        quantityOf(item) > 0,
    )
    .sort((a, b) => String(a.id ?? a._id).localeCompare(String(b.id ?? b._id)));
}

/** Read-only quote, calculated on the GM from current inventory and durable work hours. */
export function quoteGuidedWork({
  actor,
  activity,
  hours,
  targetId = "",
  progress = {},
  locationPresetId = "custom",
  checkTotal,
  gatheringTotal,
  complicationRoll,
}) {
  const config = normalizeGuidedWork(activity.work);
  if (!config) return null;
  if (config.output === FIELD_OUTPUT)
    return quoteFieldAmmunition({
      actor,
      activity: { ...activity, work: config },
      hours,
      targetId,
      progress,
      locationPresetId,
      checkTotal,
      gatheringTotal,
      complicationRoll,
    });
  const problems = [];
  const learning = config.output === "learn-spell";
  if (learning) problems.push(...learningProblems(actor, config.learning));
  const learningScroll = learning && config.learning?.sourceType === "scroll";
  const source =
    config.output === "scroll" || learningScroll
      ? findActorItem(actor, targetId)
      : null;
  const level = scrollSourceLevel(source);
  if (config.output === "scroll" && level === null)
    problems.push(
      "Choose an owned spell or a spell scroll with a recorded spell level.",
    );
  if (
    learningScroll &&
    (!source ||
      source.type !== "consumable" ||
      source.system?.type?.value !== "scroll" ||
      !Number.isInteger(quantityOf(source)) ||
      quantityOf(source) < 1 ||
      normalizeItemName(source.name) !==
        normalizeItemName(config.learning.sourceName) ||
      level !== config.learning.level)
  )
    problems.push(
      "Choose the carried scroll specified by the GM for this spell and edition.",
    );
  const rates = learningRates(actor, config.learning);
  const requiredHours = learning
    ? rates.hours
    : config.output === "scroll" && level !== null
      ? SCROLL_WORK[level][0] * 8
      : config.batchHours;
  const batchCostCp = learning
    ? rates.gp * 100
    : config.output === "scroll" && level !== null
      ? SCROLL_WORK[level][1] * 100
      : Math.round(config.batchGp * 100);
  const key = merchantItemId(
    JSON.stringify([
      actor.id,
      activity.id,
      config,
      config.output === "scroll" ? [targetId, level, source?.name] : null,
    ]),
  );
  const before = Number(progress[key] ?? 0);
  if (
    !Number.isSafeInteger(before) ||
    before < 0 ||
    !Number.isInteger(hours) ||
    hours < 1 ||
    hours > 240
  )
    throw new Error("Crafting time could not be verified.");
  const after = before + hours;
  if (learning && hours > requiredHours - (before % requiredHours))
    problems.push(
      `Allocate at most ${requiredHours - (before % requiredHours)} more hours to this spell. It can be learned only once.`,
    );
  const batches =
    config.output === "none"
      ? 0
      : Math.floor(after / requiredHours) - Math.floor(before / requiredHours);
  const dailyRateCp = Math.round(config.gpPerDay * 100);
  const dailyCp =
    Math.ceil((after * dailyRateCp) / WORK_DAY_HOURS) -
    Math.ceil((before * dailyRateCp) / WORK_DAY_HOURS);
  // Charge the difference of cumulative rounded costs so short blocks never overcharge a batch.
  const craftingCp =
    Math.ceil((after * batchCostCp) / requiredHours) -
    Math.ceil((before * batchCostCp) / requiredHours);
  const costCp = Math.round(config.gpPerBlock * 100) + dailyCp + craftingCp;
  const wallet = readWalletStrict(actor.system?.currency);
  if (!wallet.ok || !planWalletDeltaCp(wallet.wallet, -costCp))
    problems.push(
      `You need ${money(costCp)} available before the GM applies this work.`,
    );
  const ammo = AMMUNITION_RECIPES[config.output];
  if (
    ammo &&
    !config.requiredTools?.length &&
    !actorHasAnyTool(actor, ammo.toolKeys)
  )
    problems.push(
      `Required tools: ${ammo.toolKeys.map((key) => ({ smith: "Smith's Tools", woodcarver: "Woodcarver's Tools", tinker: "Tinker's Tools" })[key]).join(" or ")}.`,
    );
  const tools = [];
  for (const name of [
    ...requiredToolNames(config),
    ...(learning && config.learning ? [config.learning.bookName] : []),
  ]) {
    const matches = matchMaterial(actor, name);
    if (!matches.length)
      problems.push(
        `Required tools: carry ${name} in your character's inventory (kept).`,
      );
    else if (!tools.includes(matches[0])) tools.push(matches[0]);
  }
  const excluded = new Set([
    targetId,
    ...tools.map((item) => item.id ?? item._id),
  ]);
  if (ammo) {
    const toolNames = ammo.toolKeys.map((key) =>
      normalizeItemName(
        {
          smith: "Smith's Tools",
          woodcarver: "Woodcarver's Tools",
          tinker: "Tinker's Tools",
        }[key],
      ),
    );
    for (const item of collectionValues(actor.items)) {
      if (toolNames.includes(normalizeItemName(item.name)))
        excluded.add(item.id ?? item._id);
    }
  }
  const materials = [];
  const materialRequirements = [];
  const materialLabels = [];
  if (learningScroll && source && level !== null && batches > 0) {
    materials.push({
      itemId: targetId,
      name: source.name,
      before: quantityOf(source),
      after: quantityOf(source) - 1,
      identity: identity(source),
    });
    materialLabels.push(
      `1 × ${source.name} (destroyed whether copying succeeds or fails)`,
    );
  }
  for (const requirement of config.materials) {
    const count =
      requirement.per === "day"
        ? Math.ceil((after * requirement.quantity) / WORK_DAY_HOURS) -
          Math.ceil((before * requirement.quantity) / WORK_DAY_HOURS)
        : requirement.quantity * (requirement.per === "batch" ? batches : 1);
    let remaining = Math.ceil(count);
    const requiredQuantity =
      requirement.per === "batch"
        ? requirement.quantity *
          (Math.ceil(after / requiredHours) -
            Math.floor(before / requiredHours))
        : Math.ceil(count);
    const matching = matchMaterial(actor, requirement.name, excluded);
    const carriedQuantity = matching.reduce(
      (total, item) => total + quantityOf(item),
      0,
    );
    if (carriedQuantity < requiredQuantity)
      problems.push(
        `Missing ${requiredQuantity - carriedQuantity} × ${requirement.name}. Carry the required materials on this character.`,
      );
    materialRequirements.push({
      name: requirement.name,
      quantity: requiredQuantity,
      excludedItemIds: [...excluded].filter(Boolean),
    });
    materialLabels.push(`${Math.ceil(count)} × ${requirement.name}`);
    for (const item of matching) {
      if (!remaining) break;
      const take = Math.min(remaining, quantityOf(item));
      materials.push({
        itemId: item.id ?? item._id,
        name: item.name,
        before: quantityOf(item),
        after: quantityOf(item) - take,
        identity: identity(item),
      });
      remaining -= take;
    }
  }
  const outputQuantity =
    batches *
    (ammo?.batchSize ??
      (config.output === "scroll" || learning ? 1 : config.quantity));
  const outputName =
    ammo?.label ??
    (learning
      ? (config.learning?.name ?? "choose a spell")
      : config.output === "scroll"
        ? source?.type === "consumable"
          ? source.name
          : `Spell Scroll: ${source?.name ?? "choose a spell"}`
        : activity.name);
  const remainingHours = config.output === "none" ? 0 : after % requiredHours;
  const detail = [
    `Spend ${money(costCp)} this block (${hours}h / ${Number((hours / 8).toFixed(3))} workdays).`,
    config.gpPerDay ? `${config.gpPerDay} gp/day.` : "",
    materialLabels.length ? `Consume: ${materialLabels.join(", ")}.` : "",
    materialRequirements.some((entry) => entry.quantity > 0) &&
    batches === 0 &&
    config.output !== "none"
      ? `Carry the materials for the unfinished batch; they are consumed when it finishes.`
      : "",
    requiredToolNames(config).length
      ? `Keep: ${requiredToolNames(config).join(", ")}.`
      : "",
    learning
      ? `${batches ? "Finish the copying attempt" : `Study progress: ${after % requiredHours}/${requiredHours}h`} for ${outputName}. ${learningScroll ? `On completion: Arcana DC ${10 + (config.learning?.level ?? 0)}; one scroll is destroyed on success or failure.` : "The written source is kept; no check is required."} Learning does not prepare the spell.`
      : config.output !== "none"
        ? `${outputQuantity ? `Receive ${outputQuantity} × ${outputName}. ` : "No finished items yet. "}${remainingHours}/${requiredHours}h toward the next batch.`
        : "",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    key,
    config,
    contributedHours: hours,
    progressBeforeHours: before,
    progressAfterHours: after,
    requiredHours,
    batches,
    outputQuantity,
    outputName,
    remainingHours,
    costCp,
    materials,
    ...(materialRequirements.length ? { materialRequirements } : {}),
    source: source ? { itemId: targetId, identity: identity(source) } : null,
    tools: tools.map((item) => ({
      itemId: item.id ?? item._id,
      identity: identity(item),
    })),
    detail,
    problems,
    ok: !problems.length,
  };
}

export function projectGuidedWork(
  actor,
  activity,
  hours,
  progress = {},
  locationPresetId = "custom",
  budgetHours = hours,
) {
  if (!activity.work) return {};
  if (activity.work.output === FIELD_OUTPUT)
    return projectFieldAmmunition(
      actor,
      activity,
      budgetHours,
      progress,
      locationPresetId,
    );
  const learning = activity.work.output === "learn-spell";
  const scroll =
    activity.work.output === "scroll" ||
    (learning && activity.work.learning?.sourceType === "scroll");
  const learningDetail = (quote) => {
    if (!quote.config.learning)
      return "The GM must select an approved spell first.";
    const rates = learningRates(actor, quote.config.learning);
    return [
      `Copy ${quote.outputName}: ${money((rates.gp * 100) / rates.hours)} per study hour; ${quote.progressBeforeHours % quote.requiredHours}/${quote.requiredHours}h already studied toward this attempt.`,
      scroll
        ? `On completion: Arcana DC ${10 + quote.config.learning.level}; one scroll is destroyed on success or failure.`
        : "The written source is kept; no check is required.",
      quote.config.gpPerBlock
        ? `Additional recipe cost: ${quote.config.gpPerBlock} gp per allocation.`
        : "",
      quote.config.gpPerDay
        ? `Additional recipe cost: ${quote.config.gpPerDay} gp per 8h.`
        : "",
      quote.config.materials.length
        ? `Required materials: ${quote.config.materials.map((r) => `${r.quantity} × ${r.name} per ${r.per}`).join(", ")}.`
        : "",
      "Learning does not prepare the spell.",
    ]
      .filter(Boolean)
      .join(" ");
  };
  const targets = scroll
    ? collectionValues(actor.items)
        .filter((item) => scrollSourceLevel(item) !== null)
        .map((item) => {
          const quote = quoteGuidedWork({
            actor,
            activity,
            hours,
            targetId: item.id,
            progress,
          });
          return {
            id: item.id,
            label: `${item.name} · level ${scrollSourceLevel(item)}${learning ? "" : ` · ${money(quote.costCp)} this block`}`,
            detail: `${learning ? learningDetail(quote) : quote.detail} ${quote.problems.join(" ")}`,
            disabled: !quote.ok,
          };
        })
    : [];
  const quote = scroll
    ? null
    : quoteGuidedWork({ actor, activity, hours, progress });
  return {
    available: scroll ? targets.some((target) => !target.disabled) : quote.ok,
    unavailableReason: scroll
      ? targets.length
        ? "No source currently meets the costs and material requirements. See each option for details."
        : "Add a spell or a spell scroll with a recorded spell level to your sheet."
      : quote.problems.join(" "),
    costLabel:
      (quote ? (learning ? learningDetail(quote) : quote.detail) : null) ??
      (learning
        ? "Choose a carried scroll to see costs and progress. On completion, one scroll is destroyed whether copying succeeds or fails."
        : "Choose a source to see this block's GP, materials, and progress. Your original spell or scroll is kept."),
    limitLabel: learning
      ? "Wizard copying: 2h and 50 gp per spell level; 2014 school Savant halves both. Carry the configured spellbook. The GM approves access and Wizard-list eligibility. Other special copying features need GM review."
      : scroll
        ? "2024 scroll time and base cost by spell level. GM confirms scribing prerequisites, permission to copy scrolls, and spell components; add consumed components as materials."
        : "Costs apply with every result. Tools are kept. Progress carries between blocks using this recipe.",
    targets,
    targetLabel: learning
      ? "Scroll to copy into your spellbook"
      : "Spell or scroll to scribe",
    targetField: "targetId",
  };
}

export function guidedWorkReceipt(work) {
  return work.detail
    .replace(/\bSpend /, "Spent ")
    .replace("Consume:", "Consumed:")
    .replace("Receive ", "Received ")
    .replace("Keep:", "Kept:");
}

export async function buildGuidedWorkPlan(options) {
  const work = quoteGuidedWork(options);
  if (!work) return null;
  if (!work.ok)
    throw new Error(`${options.actor.name}: ${work.problems.join(" ")}`);
  if (work.config.output !== "none") {
    let snapshot;
    if (work.config.output === "learn-spell") {
      const learning = work.config.learning;
      snapshot = await resolveItemSnapshot(learning.uuid);
      if (
        snapshot?.type !== "spell" ||
        snapshot.name !== learning.name ||
        Number(snapshot.system?.level) !== learning.level ||
        String(snapshot.system?.school ?? "") !== learning.school ||
        spellEdition(snapshot) !== learning.edition
      )
        throw new Error(
          "The approved spell source changed or is unavailable. Ask the GM to save the learning activity again.",
        );
      if (work.outputQuantity && learning.sourceType === "scroll") {
        const total = Number(options.checkTotal);
        if (!Number.isFinite(total) || options.checkTotal == null)
          throw new Error(
            "An Arcana roll is required to finish copying this scroll.",
          );
        work.copyCheck = {
          total,
          dc: 10 + learning.level,
          success: total >= 10 + learning.level,
        };
        if (!work.copyCheck.success) work.outputQuantity = 0;
        work.detail += ` Arcana ${total} vs DC ${work.copyCheck.dc}: ${work.copyCheck.success ? "spell learned" : "copying failed; the scroll is spent and no spell is learned"}.`;
      } else if (work.outputQuantity)
        work.detail += ` Learned ${learning.name}.`;
      snapshot = prepareLearnedSpell(snapshot, {
        operationId: options.operationId,
        learning,
        actor: options.actor,
        dateLabel: options.dateLabel ?? "",
        worldTime: Number(globalThis.game?.time?.worldTime ?? 0),
      });
      const implementation = globalThis.CONFIG?.Item?.documentClass;
      if (typeof implementation === "function")
        snapshot = new implementation(snapshot, {
          parent: options.actor,
        }).toObject();
    } else if (work.config.output === "scroll") {
      const item = findActorItem(options.actor, options.targetId);
      if (item.type === "spell") {
        const implementation =
          globalThis.CONFIG?.Item?.documentClass ??
          globalThis.Item?.implementation;
        if (typeof implementation?.createScrollFromSpell !== "function")
          throw new Error(
            "This D&D5e system cannot create a usable spell scroll. No costs were applied.",
          );
        const scroll = await implementation.createScrollFromSpell(
          item,
          {},
          { dialog: false },
        );
        snapshot = scroll?.toObject?.();
      } else snapshot = clone(sourceOf(item));
    } else
      snapshot = await resolveItemSnapshot(
        AMMUNITION_RECIPES[work.config.output]?.uuid ?? work.config.itemUuid,
      );
    if (
      !snapshot ||
      ![
        "weapon",
        "equipment",
        "consumable",
        "tool",
        "loot",
        "container",
        "spell",
      ].includes(snapshot.type) ||
      !snapshot.system
    )
      throw new Error(
        "The crafting result could not be loaded as an inventory item. No costs were applied.",
      );
    if (!work.outputQuantity) {
      delete work.problems;
      delete work.ok;
      return work;
    }
    snapshot = clone(snapshot);
    for (const key of ["id", "folder", "ownership", "sort", "_stats"])
      delete snapshot[key];
    snapshot._id = merchantItemId(`${options.operationId}:guided-work`);
    if (snapshot.type !== "spell") {
      snapshot.system.quantity = work.outputQuantity;
      snapshot.system.container = null;
    }
    if (snapshot.system.uses) snapshot.system.uses.spent = 0;
    snapshot.flags ??= {};
    snapshot.flags[MODULE_ID] ??= {};
    delete snapshot.flags[MODULE_ID].stolen;
    delete snapshot.flags[MODULE_ID].purchasedFromMerchant;
    snapshot.flags[MODULE_ID].downtimeCraft = {
      operationId: options.operationId,
      recipeId: work.config.output,
    };
    work.delivery = {
      itemId: snapshot._id,
      snapshot,
      quantity: work.outputQuantity,
    };
  }
  delete work.problems;
  delete work.ok;
  return work;
}

function requirementsPresent(actor, work) {
  if (
    work.config.output === "learn-spell" &&
    learningProblems(actor, work.config.learning).length
  )
    return false;
  if (
    !(work.materialRequirements ?? []).every(
      (requirement) =>
        matchMaterial(
          actor,
          requirement.name,
          new Set(requirement.excludedItemIds ?? []),
        ).reduce((total, item) => total + quantityOf(item), 0) >=
        requirement.quantity,
    )
  )
    return false;
  if (work.source) {
    const item = findActorItem(actor, work.source.itemId);
    if (
      !item ||
      identity(item) !== work.source.identity ||
      scrollSourceLevel(item) === null ||
      (work.config.output === "learn-spell" &&
        (!Number.isInteger(quantityOf(item)) || quantityOf(item) < 1))
    )
      return false;
  }
  if (
    !work.tools.every((tool) => {
      const item = findActorItem(actor, tool.itemId);
      return (
        item &&
        Number.isInteger(quantityOf(item)) &&
        quantityOf(item) >= 1 &&
        identity(item) === tool.identity
      );
    })
  )
    return false;
  const ammo = AMMUNITION_RECIPES[work.config.output];
  return (
    Boolean(work.config.requiredTools?.length) ||
    !ammo ||
    actorHasAnyTool(actor, ammo.toolKeys)
  );
}

function componentStates(actor, operation) {
  const work = operation.work;
  if (!work || !Array.isArray(work.materials) || !Array.isArray(work.tools))
    return ["drift"];
  const wallet = readWalletStrict(actor.system?.currency);
  const state = (before, after) =>
    before && after ? "same" : before ? "before" : after ? "after" : "drift";
  const states = [
    state(
      wallet.ok && walletsEqual(wallet.wallet, operation.walletBefore),
      wallet.ok && walletsEqual(wallet.wallet, operation.walletAfter),
    ),
  ];
  for (const material of work.materials) {
    const item = findActorItem(actor, material.itemId);
    const matches = item && identity(item) === material.identity;
    states.push(
      state(
        matches && quantityOf(item) === material.before,
        matches && quantityOf(item) === material.after,
      ),
    );
  }
  if (work.delivery) {
    const item = findActorItem(actor, work.delivery.itemId);
    const expected = work.delivery.snapshot;
    // Check the saved item data as well as provenance: hooks must not change
    // the spell, charges, or other useful properties while creating a result.
    const matches =
      item &&
      item.name === expected.name &&
      item.type === expected.type &&
      identity(item) === identity(expected) &&
      sourceOf(item).flags?.[MODULE_ID]?.downtimeCraft?.operationId ===
        operation.operationId &&
      (expected.type === "spell" ||
        quantityOf(item) === work.delivery.quantity);
    states.push(state(!item, matches));
  }
  return states;
}

export function inspectGuidedWork(actor, operation) {
  const states = componentStates(actor, operation);
  if (states.some((state) => state === "drift")) return "uncertain";
  if (states.every((state) => state === "after" || state === "same"))
    return "applied";
  if (states.every((state) => state === "before" || state === "same"))
    return "unapplied";
  return "uncertain";
}

export function verifyGuidedWorkBefore(actor, operation) {
  return (
    requirementsPresent(actor, operation.work) &&
    componentStates(actor, operation).every(
      (state) => state === "before" || state === "same",
    )
  );
}

/** Restore only exact known before/after states. Never overwrite inventory drift. */
export async function recoverGuidedWork(
  actor,
  operation,
  { authorizeWrite } = {},
) {
  const states = componentStates(actor, operation);
  if (states.includes("drift") || !authorizeWrite?.()) return false;
  if (inspectGuidedWork(actor, operation) !== "uncertain") return true;
  // A crash can leave only a prefix of this ordered transaction applied.
  let beforeSeen = false;
  for (const state of states) {
    if (state === "before") beforeSeen = true;
    if (state === "after" && beforeSeen) return false;
  }
  const work = operation.work;
  if (work.delivery && states.at(-1) === "after") {
    const removed = await deleteActorItemVerified(actor, work.delivery.itemId, {
      authorizeWrite,
    });
    if (!removed.ok || !authorizeWrite()) return false;
  }
  for (let i = work.materials.length - 1; i >= 0; i--) {
    if (states[i + 1] !== "after") continue;
    const material = work.materials[i];
    if (
      !authorizeWrite() ||
      componentStates(actor, operation).includes("drift")
    )
      return false;
    await updateActorItemQuantityVerified(
      actor,
      material.itemId,
      material.before,
      { authorizeWrite },
    );
    if (
      !authorizeWrite() ||
      quantityOf(findActorItem(actor, material.itemId)) !== material.before
    )
      return false;
  }
  if (states[0] === "after") {
    if (
      !authorizeWrite() ||
      componentStates(actor, operation).includes("drift")
    )
      return false;
    await updateCurrencyVerified(actor, operation.walletBefore, {
      authorizeWrite,
    });
  }
  return (
    authorizeWrite() &&
    componentStates(actor, operation).every(
      (state) => state === "before" || state === "same",
    )
  );
}

export async function applyGuidedWork(
  actor,
  operation,
  { authorizeWrite } = {},
) {
  if (!authorizeWrite?.())
    return { ok: false, reason: "authority-lost", provenUnapplied: true };
  if (!verifyGuidedWorkBefore(actor, operation))
    return {
      ok: false,
      reason: "crafting-inventory-drift",
      provenUnapplied: false,
    };
  const failed = async (reason) => {
    if (!authorizeWrite())
      return { ok: false, reason: "authority-lost", provenUnapplied: false };
    // A lost reply after the final write still has an exact canonical receipt.
    if (inspectGuidedWork(actor, operation) === "applied") return { ok: true };
    await recoverGuidedWork(actor, operation, { authorizeWrite });
    return {
      ok: false,
      reason,
      provenUnapplied: inspectGuidedWork(actor, operation) === "unapplied",
    };
  };
  if (!walletsEqual(operation.walletBefore, operation.walletAfter)) {
    const result = await updateCurrencyVerified(actor, operation.walletAfter, {
      authorizeWrite,
    });
    if (!result.ok) return failed(result.reason);
  }
  for (const material of operation.work.materials) {
    if (
      !authorizeWrite() ||
      componentStates(actor, operation).includes("drift")
    )
      return failed("crafting-inventory-drift");
    const result = await updateActorItemQuantityVerified(
      actor,
      material.itemId,
      material.after,
      { authorizeWrite },
    );
    if (!result.ok) return failed(result.reason);
  }
  if (operation.work.delivery) {
    if (
      !authorizeWrite() ||
      componentStates(actor, operation).includes("drift")
    )
      return failed("crafting-inventory-drift");
    const result = await createActorItemVerified(
      actor,
      operation.work.delivery.snapshot,
      { authorizeWrite },
    );
    if (!result.ok) return failed(result.reason);
  }
  return authorizeWrite() && inspectGuidedWork(actor, operation) === "applied"
    ? { ok: true }
    : failed("crafting-write-unconfirmed");
}
