/**
 * Infinity D&D5e — Loot Distribution
 *
 * Helpers for moving rolled loot from the Loot Forge result list onto
 * player-character actors.
 *
 * Entry points:
 * - {@link beginDragFromResult} wires a `dragstart` payload that
 *   Foundry's stock drop handlers (character sheet, sidebar actor,
 *   canvas token) all understand. Drag-drop is the lowest-friction
 *   path; everything else is a fallback.
 * - {@link promptDistributeItems} opens a small actor-picker dialog and
 *   deposits the chosen items — plus an optional coin pile — onto one
 *   character. Used by every loot tool's Deposit / Send button.
 * - {@link depositToActor} is the centralized pipeline: items (with
 *   quantities) and/or currency onto one actor, surfacing a single
 *   combined notification. Macro / API callers that already know the
 *   actor can call it — or the thinner {@link distributeItemsToActor},
 *   which returns just the created-item count — directly.
 *
 * All Foundry globals are referenced lazily so this file can be
 * imported in node tests without crashing — the helpers throw
 * `NotInFoundry` if called outside a Foundry runtime.
 */

import {
  currencyAddFromBreakdown,
  formatCoinBreakdown,
} from "./hoard-budget.js";
import { DEFAULT_ITEM_PACK_ID, loadCompendiumItems } from "./pack.js";
import { isBareSpellLootItem } from "./tag-vocabulary.js";

const MODULE_ID = "infinity-dnd5e";
const SPELL_SCROLL_SCHEMA = "infinity-dnd5e-spell-scroll-v1";
let spellScrollIndexPromise = null;

/* ------------------------------------------------------------------ *
 * Drag-and-drop
 * ------------------------------------------------------------------ */

/**
 * Stamp the dataTransfer payload Foundry expects when an Item is
 * being dragged. Setting both `text/plain` and `application/json`
 * keeps us compatible with V12 (text/plain canonical) and any V13+
 * sheet that prefers structured JSON.
 *
 * Returns true when a payload was written so the caller can choose
 * to call `event.preventDefault()` / set a drag image. Returns false
 * when the source element has no usable uuid (no-op drag).
 */
export function beginDragFromResult(event, entry = null) {
  const sourceEl = event?.currentTarget ?? event?.target;
  const uuid = entry?.item?.uuid ?? sourceEl?.dataset?.uuid;
  const quantity = Math.max(1, Math.floor(Number(entry?.quantity) || 1));

  // Generated art variants always ship their own snapshot because the
  // specific name, condition, and provenance only exist in `entry.itemData`.
  let itemData = cloneItemData(entry?.itemData);

  // Multi-quantity normal items need a snapshot too. Foundry's stock drop
  // handler resolves a bare `uuid` payload by fetching the compendium
  // document and copying it AS-IS — with the source's quantity, which is
  // almost always 1. Without baking the rolled quantity into a snapshot,
  // dragging a "Healing Potion ×4" tile lands as one potion. Builds the
  // snapshot from `entry.item` (already a plain object loaded by pack.js)
  // synchronously — no `fromUuid` round-trip during dragstart.
  if (!itemData && quantity > 1 && entry?.item) {
    const snapshot = cloneItemData(entry.item);
    if (snapshot) {
      delete snapshot._id;
      delete snapshot.id;
      delete snapshot.uuid;
      setItemQuantity(snapshot, quantity);
      itemData = snapshot;
    }
  }

  if (!uuid && !itemData) return false;
  const payload = JSON.stringify(
    itemData ? { type: "Item", data: itemData } : { type: "Item", uuid },
  );
  try {
    event.dataTransfer?.setData("text/plain", payload);
    event.dataTransfer?.setData("application/json", payload);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
  } catch (error) {
    console.warn(`${MODULE_ID} | dragstart failed`, { uuid, error });
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * Picker + transfer
 * ------------------------------------------------------------------ */

/**
 * Open a small picker, ask the GM which actor to send items to,
 * then copy the items onto the actor.
 *
 * @param {Array<string|object>} items - compendium UUIDs or generated item data wrappers.
 * @param {object} [opts]
 * @param {string} [opts.title] - dialog title. Defaults based on count.
 * @param {string} [opts.hint]  - body text above the dropdown.
 * @returns {Promise<{ actorId: string, created: number } | null>}
 *          null when the user cancels.
 */
export async function promptDistributeItems(items, opts = {}) {
  ensureFoundry();
  const cleaned = normalizeDistributableItems(items);
  const currency = opts.currency
    ? currencyAddFromBreakdown(opts.currency)
    : null;
  const hasCurrency = Boolean(
    currency &&
    (currency.pp || currency.gp || currency.ep || currency.sp || currency.cp),
  );
  if (cleaned.length === 0 && !hasCurrency) {
    ui.notifications?.warn(`${MODULE_ID}: nothing to distribute.`);
    return null;
  }

  const candidates = listDistributableActors();
  if (candidates.length === 0) {
    ui.notifications?.warn(`${MODULE_ID}: no character-type actors available.`);
    return null;
  }

  const coinLabel =
    opts.coinLabel || (currency ? formatCoinBreakdown(currency) : "");
  const title =
    opts.title ??
    (cleaned.length === 0
      ? "Deposit Coins to Actor"
      : cleaned.length === 1 && !hasCurrency
        ? "Send Item to Actor"
        : `Send ${cleaned.length} Items to Actor`);
  const hint = opts.hint ?? defaultDistributeHint(cleaned.length, coinLabel);

  const options = candidates
    .map(
      (actor) =>
        `<option value="${escapeAttr(actor.id)}">${escapeText(actor.name)}</option>`,
    )
    .join("");

  const coinNote =
    hasCurrency && coinLabel
      ? `<p style="opacity:0.8;">Plus the coin pile: <strong>${escapeText(coinLabel)}</strong>.</p>`
      : "";

  const content = `
    <div class="infinity-dnd5e-distribute">
      <p>${escapeText(hint)}</p>
      ${coinNote}
      <label style="display:grid;gap:4px;">
        <span>Actor</span>
        <select name="actorId">${options}</select>
      </label>
    </div>
  `;

  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (!DialogV2) {
    ui.notifications?.error(
      `${MODULE_ID}: DialogV2 unavailable (Foundry V12+ required).`,
    );
    return null;
  }

  let chosenActorId = null;
  try {
    chosenActorId = await DialogV2.prompt({
      window: { title, icon: "fa-solid fa-share-from-square" },
      content,
      ok: {
        label: "Send",
        icon: "fa-solid fa-paper-plane",
        callback: (_event, button) =>
          button?.form?.elements?.actorId?.value ?? null,
      },
      rejectClose: false,
    });
  } catch (error) {
    // DialogV2.prompt throws on close-without-submit in some versions.
    console.debug(`${MODULE_ID} | distribute dialog dismissed`, error);
    return null;
  }

  if (!chosenActorId) return null;
  const res = await depositToActor(chosenActorId, {
    items: cleaned,
    currency: opts.currency ?? null,
  });
  return {
    actorId: chosenActorId,
    created: res.created,
    currencyAdded: res.currencyAdded,
  };
}

/* ------------------------------------------------------------------ *
 * Multi-actor split distribution
 * ------------------------------------------------------------------ */

/**
 * Distribute items round-robin across actors (no coin handling). Pure —
 * exported for unit testing. Returns one assignment per actor id.
 *
 * @param {Array<object>} items - normalized distributable entries
 * @param {string[]} actorIds
 * @returns {Array<{actorId: string, items: object[]}>}
 */
export function planRoundRobin(items, actorIds) {
  const ids = (Array.isArray(actorIds) ? actorIds : []).filter(Boolean);
  const assignments = ids.map((actorId) => ({ actorId, items: [] }));
  if (assignments.length === 0) return [];
  (Array.isArray(items) ? items : []).forEach((item, index) => {
    assignments[index % assignments.length].items.push(item);
  });
  return assignments;
}

/** Split a coin breakdown as evenly as possible; remainder to the first. */
function splitCurrencyEven(currency, count) {
  const out = Array.from({ length: count }, () => ({
    pp: 0,
    gp: 0,
    ep: 0,
    sp: 0,
    cp: 0,
  }));
  if (count <= 0 || !currency) return out;
  for (const denom of ["pp", "gp", "ep", "sp", "cp"]) {
    const total = Math.floor(Number(currency[denom]) || 0);
    const base = Math.floor(total / count);
    let remainder = total - base * count;
    for (let i = 0; i < count; i += 1) {
      out[i][denom] = base + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder -= 1;
    }
  }
  return out;
}

/**
 * Round-robin the items AND divide the coin pile evenly across actors.
 * Pure — exported for unit testing.
 *
 * @param {Array<object>} items
 * @param {object|null} currency - a {pp,gp,sp,cp}-ish coin breakdown
 * @param {string[]} actorIds
 * @returns {Array<{actorId: string, items: object[], currency: object}>}
 */
export function planEvenSplit(items, currency, actorIds) {
  const assignments = planRoundRobin(items, actorIds);
  if (assignments.length === 0) return [];
  const split = splitCurrencyEven(currency, assignments.length);
  assignments.forEach((assignment, index) => {
    assignment.currency = split[index];
  });
  return assignments;
}

/**
 * Deposit a set of per-actor assignments. Loops the single-actor
 * {@link depositToActor} and surfaces one combined notification.
 *
 * @param {Array<{actorId: string, items?: object[], currency?: object}>} assignments
 * @param {object} [opts]
 * @param {boolean} [opts.notify=true]
 * @returns {Promise<{created: number, recipients: string[]}>}
 */
export async function depositToActors(assignments, { notify = true } = {}) {
  ensureFoundry();
  let created = 0;
  const recipients = [];
  for (const assignment of assignments ?? []) {
    if (!assignment?.actorId) continue;
    const res = await depositToActor(assignment.actorId, {
      items: assignment.items ?? [],
      currency: assignment.currency ?? null,
      notify: false,
    });
    created += res.created;
    if (res.created > 0 || res.currencyAdded) {
      recipients.push(game.actors?.get?.(assignment.actorId)?.name ?? "actor");
    }
  }
  if (notify) {
    if (recipients.length > 0) {
      ui.notifications?.info(
        `${MODULE_ID}: split ${created} item(s) across ${recipients.length} character(s) — ${recipients.join(", ")}.`,
      );
    } else {
      ui.notifications?.warn(`${MODULE_ID}: nothing was distributed.`);
    }
  }
  return { created, recipients };
}

/**
 * Open a multi-actor picker (checkbox list + split mode) and distribute
 * the haul across the chosen characters.
 *
 * @param {Array<string|object>} items
 * @param {object} [opts]
 * @param {object} [opts.currency] - coin breakdown to divide
 * @param {string} [opts.title]
 * @param {string} [opts.hint]
 * @returns {Promise<{created:number, recipients:string[]} | null>}
 */
export async function promptDistributeSplit(items, opts = {}) {
  ensureFoundry();
  const cleaned = normalizeDistributableItems(items);
  const currency = opts.currency
    ? currencyAddFromBreakdown(opts.currency)
    : null;
  const hasCurrency = Boolean(
    currency &&
    (currency.pp || currency.gp || currency.ep || currency.sp || currency.cp),
  );
  if (cleaned.length === 0 && !hasCurrency) {
    ui.notifications?.warn(`${MODULE_ID}: nothing to distribute.`);
    return null;
  }
  const candidates = listDistributableActors();
  if (candidates.length === 0) {
    ui.notifications?.warn(`${MODULE_ID}: no character-type actors available.`);
    return null;
  }
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (!DialogV2) {
    ui.notifications?.error(
      `${MODULE_ID}: DialogV2 unavailable (Foundry V12+ required).`,
    );
    return null;
  }

  const checkboxes = candidates
    .map(
      (actor) =>
        `<label style="display:flex;gap:6px;align-items:center;"><input type="checkbox" name="actor" value="${escapeAttr(actor.id)}" checked /> <span>${escapeText(actor.name)}</span></label>`,
    )
    .join("");
  const content = `
    <div class="infinity-dnd5e-distribute">
      <p>${escapeText(opts.hint ?? "Choose characters and how to split the haul.")}</p>
      <label style="display:grid;gap:4px;">
        <span>Split mode</span>
        <select name="mode">
          <option value="even">Even split — round-robin items + divided coins</option>
          <option value="round-robin">Round-robin items — coins to the first</option>
        </select>
      </label>
      <fieldset style="margin-top:8px;display:grid;gap:4px;">
        <legend>Characters</legend>
        ${checkboxes}
      </fieldset>
    </div>`;

  let payload = null;
  try {
    payload = await DialogV2.prompt({
      window: {
        title: opts.title ?? "Split Across Party",
        icon: "fa-solid fa-users",
      },
      content,
      ok: {
        label: "Distribute",
        icon: "fa-solid fa-share-nodes",
        callback: (_event, button) => {
          const form = button?.form;
          if (!form) return null;
          const ids = [
            ...form.querySelectorAll("input[name='actor']:checked"),
          ].map((input) => input.value);
          return { ids, mode: form.elements.mode?.value ?? "even" };
        },
      },
      rejectClose: false,
    });
  } catch (error) {
    console.debug(`${MODULE_ID} | split dialog dismissed`, error);
    return null;
  }
  if (!payload?.ids?.length) return null;

  let assignments;
  if (payload.mode === "round-robin") {
    assignments = planRoundRobin(cleaned, payload.ids);
    if (opts.currency && assignments[0]) {
      assignments[0].currency = currencyAddFromBreakdown(opts.currency);
    }
  } else {
    assignments = planEvenSplit(cleaned, opts.currency ?? null, payload.ids);
  }
  return depositToActors(assignments, { notify: true });
}

/**
 * Copy each item (UUID resolved via `fromUuid`, or an inline generated
 * `itemData` snapshot) onto the actor. Thin wrapper over
 * {@link depositItemsCore} that preserves the original
 * "returns the created count" contract for existing callers — the module
 * API `distributeBundle` alias and the drag-drop fallbacks.
 *
 * @param {string} actorId
 * @param {Array<string|object>} items
 * @returns {Promise<number>} number of items actually created.
 */
export async function distributeItemsToActor(actorId, items) {
  ensureFoundry();
  const actor = game.actors?.get?.(actorId);
  if (!actor) {
    ui.notifications?.error(`${MODULE_ID}: actor ${actorId} not found.`);
    return 0;
  }
  const { created, failures } = await depositItemsCore(actor, items);
  if (created === 0) {
    ui.notifications?.warn(
      `${MODULE_ID}: none of the item(s) could be added to ${actor.name}.`,
    );
    return 0;
  }
  notifyDeposit(actor, created, failures, null);
  return created;
}

/**
 * Deposit a full haul — items and/or a coin pile — onto a single actor.
 *
 * Items ({@link depositItemsCore}) and currency (a read-and-add update of
 * `system.currency`) are two independent writes with no shared
 * transaction; each is guarded so a failure in one still reports what the
 * other landed. A single combined notification summarizes the result.
 *
 * @param {string} actorId
 * @param {object} [haul]
 * @param {Array<string|object>} [haul.items]  items to create (quantities honored)
 * @param {object} [haul.currency]   a {pp,gp,ep,sp,cp}-ish coin breakdown
 * @param {boolean} [haul.notify=true]  surface the result toast
 * @returns {Promise<{created:number, failures:string[], currencyAdded:object|null}>}
 */
export async function depositToActor(
  actorId,
  { items = [], currency = null, notify = true } = {},
) {
  ensureFoundry();
  const actor = game.actors?.get?.(actorId);
  if (!actor) {
    ui.notifications?.error(`${MODULE_ID}: actor ${actorId} not found.`);
    return { created: 0, failures: [], currencyAdded: null };
  }

  const { created, failures } = await depositItemsCore(actor, items);

  let currencyAdded = null;
  const add = currency ? currencyAddFromBreakdown(currency) : null;
  if (add && (add.pp || add.gp || add.ep || add.sp || add.cp)) {
    // Read current values and ADD — dotted keys so we never clobber a
    // denomination we aren't touching (electrum in particular).
    const cur = actor.system?.currency ?? {};
    try {
      await actor.update({
        "system.currency.pp": (cur.pp ?? 0) + add.pp,
        "system.currency.gp": (cur.gp ?? 0) + add.gp,
        "system.currency.ep": (cur.ep ?? 0) + add.ep,
        "system.currency.sp": (cur.sp ?? 0) + add.sp,
        "system.currency.cp": (cur.cp ?? 0) + add.cp,
      });
      currencyAdded = add;
    } catch (error) {
      console.error(`${MODULE_ID} | currency update failed`, error);
      ui.notifications?.error(
        `${MODULE_ID}: could not add coins to ${actor.name}. See console.`,
      );
    }
  }

  if (notify) notifyDeposit(actor, created, failures, currencyAdded);
  return { created, failures, currencyAdded };
}

/**
 * Resolve refs and create the embedded items on an actor. Returns the
 * real created-document count plus a by-name list of refs that could not
 * be resolved. Does NOT notify — callers compose the message so a
 * combined items+currency toast reads as one action.
 *
 * @param {Actor} actor
 * @param {Array<string|object>} items
 * @returns {Promise<{created:number, failures:string[]}>}
 */
async function depositItemsCore(actor, items) {
  const refs = normalizeDistributableItems(items);
  const itemData = [];
  const failures = [];
  for (const ref of refs) {
    try {
      if (ref.itemData) {
        const source = cloneItemData(ref.itemData);
        const obj = await prepareCreatableItemData(source, {
          sourceUuid: ref.uuid,
        });
        if (!obj) {
          failures.push(spellScrollFailureName(ref, source));
          continue;
        }
        setItemQuantity(obj, ref.quantity);
        itemData.push(obj);
        continue;
      }
      const doc = await fromUuid(ref.uuid);
      if (!doc) {
        failures.push(ref.name ?? ref.uuid);
        continue;
      }
      const source = doc.toObject();
      const obj = await prepareCreatableItemData(source, {
        sourceUuid: doc.uuid ?? ref.uuid,
      });
      if (!obj) {
        failures.push(spellScrollFailureName(ref, source));
        continue;
      }
      setItemQuantity(obj, ref.quantity);
      itemData.push(obj);
    } catch (error) {
      console.warn(`${MODULE_ID} | failed to resolve`, { ref, error });
      failures.push(ref.name ?? ref.uuid ?? "generated item");
    }
  }

  if (itemData.length === 0) return { created: 0, failures };

  let createdDocs = [];
  try {
    createdDocs = await actor.createEmbeddedDocuments("Item", itemData);
  } catch (error) {
    console.error(`${MODULE_ID} | createEmbeddedDocuments failed`, error);
    ui.notifications?.error(
      `${MODULE_ID}: could not add items to ${actor.name}. See console.`,
    );
    return { created: 0, failures };
  }

  const created = Array.isArray(createdDocs)
    ? createdDocs.length
    : itemData.length;
  return { created, failures };
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

async function prepareCreatableItemData(source, { sourceUuid = "" } = {}) {
  if (!source) return null;
  const obj = isBareSpellLootItem(source)
    ? await findSpellScrollForSpell(source, sourceUuid)
    : cloneItemData(source);
  if (!obj) return null;
  // Strip source identity so Foundry assigns a fresh embedded item id.
  delete obj._id;
  delete obj.id;
  delete obj.uuid;
  return obj;
}

async function findSpellScrollForSpell(spellData, sourceUuid = "") {
  const index = await getSpellScrollIndex();
  for (const key of spellLookupKeys(spellData, sourceUuid)) {
    const scroll = index.get(key);
    if (scroll) return cloneItemData(scroll);
  }
  return null;
}

async function getSpellScrollIndex() {
  if (!spellScrollIndexPromise) {
    spellScrollIndexPromise = loadCompendiumItems({
      packId: DEFAULT_ITEM_PACK_ID,
    }).then(buildSpellScrollIndex);
  }
  return spellScrollIndexPromise;
}

function buildSpellScrollIndex(items) {
  const index = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!isGeneratedSpellScroll(item)) continue;
    const native = item.flags?.[MODULE_ID]?.spellScroll ?? {};
    const source =
      item.flags?.[MODULE_ID]?.scrollSource ??
      item.flags?.["party-operations"]?.scrollSource ??
      {};
    addIndexKey(index, idKey(native.sourceSpellId), item);
    addIndexKey(index, idKey(source.spellId), item);
    addIndexKey(index, uuidKey(native.sourceSpellUuid), item);
    addIndexKey(index, uuidKey(source.sourceUuid), item);
    addIndexKey(
      index,
      spellNameKey(
        native.sourceSpellName ??
          source.spellName ??
          stripScrollPrefix(item.name),
        native.spellLevel ?? source.spellLevel,
      ),
      item,
    );
  }
  return index;
}

function isGeneratedSpellScroll(item) {
  const native = item?.flags?.[MODULE_ID]?.spellScroll;
  if (native?.schema === SPELL_SCROLL_SCHEMA) return true;
  const source =
    item?.flags?.[MODULE_ID]?.scrollSource ??
    item?.flags?.["party-operations"]?.scrollSource;
  return source?.schema === SPELL_SCROLL_SCHEMA;
}

function spellLookupKeys(spellData, sourceUuid) {
  return [
    idKey(spellData?._id),
    idKey(spellData?.id),
    uuidKey(sourceUuid),
    uuidKey(spellData?.uuid),
    uuidKey(spellData?.flags?.core?.sourceId),
    uuidKey(spellData?._stats?.compendiumSource),
    uuidKey(spellData?.flags?.[MODULE_ID]?.details?.coreSourceId),
    uuidKey(spellData?.flags?.["party-operations"]?.details?.coreSourceId),
    spellNameKey(spellData?.name, spellData?.system?.level),
  ].filter(Boolean);
}

function addIndexKey(index, key, item) {
  if (key && !index.has(key)) index.set(key, item);
}

function idKey(value) {
  const text = String(value ?? "").trim();
  return text ? `id:${text}` : "";
}

function uuidKey(value) {
  const text = String(value ?? "").trim();
  return text ? `uuid:${text}` : "";
}

function spellNameKey(name, level) {
  const cleanName = String(name ?? "")
    .trim()
    .toLowerCase();
  if (!cleanName) return "";
  return `name:${cleanName}:level:${normalizeSpellLevel(level)}`;
}

function stripScrollPrefix(name) {
  return String(name ?? "").replace(/^Spell Scroll:\s*/i, "");
}

function normalizeSpellLevel(level) {
  const value = Math.floor(Number(level));
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(9, value));
}

function spellScrollFailureName(ref, source) {
  const name = ref?.name ?? source?.name ?? ref?.uuid ?? "spell";
  return `${name} (spell scroll not found)`;
}

/**
 * Return character-type actors visible to the current user, sorted by
 * name. Players' assigned PC bubbles to the top when one exists.
 */
export function listDistributableActors() {
  ensureFoundry();
  const all = game.actors?.filter?.((actor) => actor?.type === "character");
  if (!Array.isArray(all)) return [];
  const ownPc = game.user?.character;
  const sorted = all.slice().sort((a, b) => {
    const an = String(a?.name ?? "");
    const bn = String(b?.name ?? "");
    return an.localeCompare(bn);
  });
  if (ownPc && sorted.includes(ownPc)) {
    return [ownPc, ...sorted.filter((a) => a !== ownPc)];
  }
  return sorted;
}

function ensureFoundry() {
  if (typeof globalThis.game === "undefined") {
    throw new Error("NotInFoundry: distribute helpers require Foundry runtime");
  }
}

/**
 * Normalize a mixed list of distributable refs into one uniform shape:
 * `{ uuid?, itemData?, name?, quantity }`. Accepts bare UUID strings,
 * `{uuid}` / `{item:{uuid}}` wrappers, or `{itemData}` / `{data}`
 * generated snapshots. Every entry carries a `quantity` (floored, ≥ 1) so
 * the rolled stack size survives the trip to the actor. Pure — no Foundry
 * globals — so it is exported for unit testing.
 */
export function normalizeDistributableItems(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      if (typeof item === "string") {
        const uuid = item.trim();
        return uuid ? { uuid, quantity: 1 } : null;
      }
      if (!item || typeof item !== "object") return null;
      const quantity = normalizeQty(item.quantity);
      const uuid = String(item.uuid ?? item.item?.uuid ?? "").trim();
      const itemData = cloneItemData(item.itemData ?? item.data);
      if (itemData) {
        return {
          itemData,
          name: item.name ?? itemData.name,
          quantity,
          ...(uuid ? { uuid } : {}),
        };
      }
      return uuid
        ? { uuid, name: item.name ?? item.item?.name, quantity }
        : null;
    })
    .filter(Boolean);
}

/** Coerce any quantity input to a positive integer; default 1. */
function normalizeQty(raw) {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/**
 * Stamp a rolled stack size onto a Foundry item snapshot. Only overrides
 * when the rolled quantity is > 1, so single-unit rolls leave the source
 * item's own quantity intact (e.g. a curated "20 arrows" item). Guarded
 * to physical item types (or any schema that already exposes a
 * `system.quantity`) so we never write a stray field onto, say, a spell.
 */
function setItemQuantity(obj, quantity) {
  const qty = Math.floor(Number(quantity) || 0);
  if (qty <= 1 || !obj) return;
  obj.system = obj.system ?? {};
  const PHYSICAL_TYPES = [
    "weapon",
    "equipment",
    "consumable",
    "tool",
    "loot",
    "container",
    "backpack",
  ];
  const hasQuantityField = Object.prototype.hasOwnProperty.call(
    obj.system,
    "quantity",
  );
  if (hasQuantityField || PHYSICAL_TYPES.includes(obj.type)) {
    obj.system.quantity = qty;
  }
}

/**
 * Compose and surface the single post-deposit notification. Reports only
 * what actually landed — items created and/or coins added — plus a named
 * count of any refs that failed to resolve.
 */
function notifyDeposit(actor, created, failures, currencyAdded) {
  const who = actor?.name ?? "the actor";
  const parts = [];
  if (created > 0) parts.push(`${created} item${created === 1 ? "" : "s"}`);
  if (currencyAdded) {
    const coinLabel = formatCoinBreakdown(currencyAdded);
    if (coinLabel) parts.push(coinLabel);
  }
  const failList = (failures ?? []).map((f) => String(f));
  const failNote =
    failList.length > 0
      ? ` (${failList.length} could not be resolved: ${failList
          .slice(0, 3)
          .join(", ")}${failList.length > 3 ? "…" : ""})`
      : "";
  if (parts.length === 0) {
    ui.notifications?.warn(
      `${MODULE_ID}: nothing was deposited to ${who}${failNote}.`,
    );
    return;
  }
  ui.notifications?.info(
    `${MODULE_ID}: sent ${parts.join(" + ")} to ${who}${failNote}.`,
  );
}

/** Default dialog hint based on what the haul contains. */
function defaultDistributeHint(itemCount, coinLabel) {
  if (itemCount > 0 && coinLabel) {
    return `Choose a character. ${itemCount} item(s) and the coin pile will be added to their sheet.`;
  }
  if (itemCount > 0) {
    return `Choose a character. ${itemCount} item(s) will be added to their inventory.`;
  }
  return "Choose a character. The coin pile will be added to their currency.";
}

function cloneItemData(itemData) {
  if (!itemData || typeof itemData !== "object") return null;
  if (typeof structuredClone === "function") return structuredClone(itemData);
  return JSON.parse(JSON.stringify(itemData));
}

function escapeText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(value) {
  return escapeText(value).replace(/"/g, "&quot;");
}
