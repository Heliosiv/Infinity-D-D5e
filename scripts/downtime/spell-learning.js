/** Wizard copying rules and source identity. No persistence or document writes. */
import { collectionValues, normalizeItemName } from "./items.js";

export const SPELLBOOK_MODULE_ID = "infinity-dnd5e";
const sourceOf = (item) => item?.toObject?.() ?? item;
export const spellName = (value) =>
  normalizeItemName(value).replace(/\s*\(legacy\)$/, "");
export function spellEdition(item) {
  const data = sourceOf(item);
  return String(
    data?.system?.source?.rules ??
      (data?.flags?.ddbimporter?.is2014 ? "2014" : "2024"),
  );
}
export function spellKey(item, uuid = "") {
  const data = sourceOf(item);
  const id = data?.flags?.ddbimporter?.definitionId;
  return `${spellEdition(data)}:${id ? `ddb:${id}` : uuid || `${spellName(data?.name)}:${data?.system?.level}`}`;
}
export function matchingLearnedSpell(actor, spell) {
  return collectionValues(actor?.items).filter((item) => {
    if (
      item.type !== "spell" ||
      Number(item.system?.level) !== Number(spell.system?.level)
    )
      return false;
    const a = item.flags?.ddbimporter?.definitionId;
    const b = spell.flags?.ddbimporter?.definitionId;
    return (
      spellEdition(item) === spellEdition(spell) &&
      ((a && b && String(a) === String(b)) ||
        spellName(item.name) === spellName(spell.name))
    );
  });
}
export function normalizeSpellLearning(raw) {
  if (!raw) return null;
  const result = {
    uuid: String(raw.uuid ?? "")
      .trim()
      .slice(0, 300),
    name: String(raw.name ?? "")
      .trim()
      .slice(0, 100),
    level: Number(raw.level),
    school: String(raw.school ?? "").slice(0, 30),
    edition: String(raw.edition ?? "2024"),
    sourceType: String(raw.sourceType ?? "notes"),
    sourceName: String(raw.sourceName ?? "")
      .trim()
      .slice(0, 100),
    bookName: String(raw.bookName ?? "Spellbook")
      .trim()
      .slice(0, 100),
  };
  if (
    !/^(Item\.[A-Za-z0-9]+|Compendium\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.Item\.[A-Za-z0-9]+)$/.test(
      result.uuid,
    ) ||
    !result.name ||
    !Number.isInteger(result.level) ||
    result.level < 1 ||
    result.level > 9 ||
    !["2014", "2024"].includes(result.edition) ||
    !["notes", "scroll"].includes(result.sourceType) ||
    !result.bookName ||
    (result.sourceType === "scroll" && !result.sourceName)
  ) {
    throw new Error(
      "Choose a level 1–9 Wizard spell, a source type, and a carried spellbook. Scroll sources also need their exact inventory name.",
    );
  }
  return result;
}
export function learningRates(actor, learning) {
  const schools = {
    abj: "abjuration",
    con: "conjuration",
    div: "divination",
    enc: "enchantment",
    evo: "evocation",
    ill: "illusion",
    nec: "necromancy",
    trs: "transmutation",
  };
  const savant =
    learning?.edition === "2014" &&
    collectionValues(actor?.items).some(
      (item) =>
        item.type === "feat" &&
        spellName(item.name) === `${schools[learning.school]} savant`,
    );
  return {
    hours: learning ? learning.level * (savant ? 1 : 2) : 2,
    gp: learning ? learning.level * (savant ? 25 : 50) : 50,
  };
}
export function learningProblems(actor, learning, { ignoreItemId = "" } = {}) {
  if (!learning)
    return [
      "The GM must choose the Wizard spell and study source in this activity first.",
    ];
  const items = collectionValues(actor?.items);
  const wizard = items.find(
    (item) =>
      item.type === "class" &&
      (item.system?.identifier === "wizard" ||
        spellName(item.name) === "wizard"),
  );
  const problems = [];
  const wizardLevel = Number(wizard?.system?.levels);
  if (
    !wizard ||
    !Number.isInteger(wizardLevel) ||
    wizardLevel < learning.level * 2 - 1
  )
    problems.push(
      "Your Wizard class level is too low to copy this spell (multiclass spell slots do not qualify).",
    );
  if (
    !items.some(
      (item) =>
        item.type !== "spell" &&
        spellName(item.name) === spellName(learning.bookName) &&
        Number(item.system?.quantity) >= 1,
    )
  )
    problems.push(`Carry ${learning.bookName} in your inventory; it is kept.`);
  const spell = {
    name: learning.name,
    system: { level: learning.level, source: { rules: learning.edition } },
  };
  if (
    matchingLearnedSpell(actor, spell).some(
      (item) => (item.id ?? item._id) !== ignoreItemId,
    )
  )
    problems.push(
      "This spell is already on your sheet. The GM can review class or edition conflicts in Wizard Notes; no duplicate is awarded.",
    );
  return problems;
}
export function prepareLearnedSpell(
  snapshot,
  { operationId, learning, actor, dateLabel = "", worldTime = 0 },
) {
  const data = structuredClone(snapshot);
  for (const key of ["_id", "id", "folder", "ownership", "sort", "_stats"])
    delete data[key];
  // Keep spell activities and automation, but never copy another character's instance IDs or uses.
  const [major, minor] = String(globalThis.game?.system?.version ?? "5.3")
    .split(".")
    .map(Number);
  if (major > 5 || (major === 5 && minor >= 3)) {
    data.system.sourceItem = "class:wizard";
    delete data.system.sourceClass;
  } else data.system.sourceClass = "wizard";
  data.system.method = "spell";
  data.system.prepared =
    globalThis.CONFIG?.DND5E?.spellPreparationStates?.unprepared?.value ?? 0;
  if (data.system.preparation)
    data.system.preparation = { mode: "prepared", prepared: false };
  delete data.system.quantity;
  delete data.system.container;
  if (data.system.uses) data.system.uses.spent = 0;
  data.flags ??= {};
  const definitionId = data.flags.ddbimporter?.definitionId;
  const is2014 = learning.edition === "2014";
  data.flags.ddbimporter = {
    ...(definitionId ? { definitionId } : {}),
    is2014,
    ignoreItemImport: true,
    ignoreItemUpdate: true,
  };
  data.flags[SPELLBOOK_MODULE_ID] = {
    downtimeCraft: { operationId, recipeId: "learn-spell" },
    learnedSpell: {
      operationId,
      key: spellKey(data, learning.uuid),
      sourceUuid: learning.uuid,
      sourceName: learning.sourceName || "GM-approved written notes",
      bookName: learning.bookName,
      edition: learning.edition,
      dateLabel,
      worldTime,
      ddbCharacterId: String(
        actor.flags?.ddbimporter?.dndbeyond?.characterId ?? "",
      ),
    },
  };
  return data;
}
