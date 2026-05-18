/**
 * Infinity D&D5e — Loot Distribution
 *
 * Helpers for moving rolled loot from the Loot Forge result list onto
 * player-character actors.
 *
 * Three entry points:
 * - {@link beginDragFromResult} wires a `dragstart` payload that
 *   Foundry's stock drop handlers (character sheet, sidebar actor,
 *   canvas token) all understand. Drag-drop is the lowest-friction
 *   path; everything else is a fallback.
 * - {@link promptDistributeItems} opens a small actor-picker dialog
 *   and copies the chosen items onto the chosen actor. Used by both
 *   the per-row "Send" button and the bundle-level "Distribute" one.
 * - {@link distributeItemsToActor} is the pure pipeline step in case
 *   a macro / API caller already knows the actor + uuids.
 *
 * All Foundry globals are referenced lazily so this file can be
 * imported in node tests without crashing — the helpers throw
 * `NotInFoundry` if called outside a Foundry runtime.
 */

const MODULE_ID = "infinity-dnd5e";

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
export function beginDragFromResult(event) {
  const sourceEl = event?.currentTarget ?? event?.target;
  const uuid = sourceEl?.dataset?.uuid;
  if (!uuid) return false;
  const payload = JSON.stringify({ type: "Item", uuid });
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
 * @param {string[]} uuids - compendium UUIDs to send.
 * @param {object} [opts]
 * @param {string} [opts.title] - dialog title. Defaults based on count.
 * @param {string} [opts.hint]  - body text above the dropdown.
 * @returns {Promise<{ actorId: string, created: number } | null>}
 *          null when the user cancels.
 */
export async function promptDistributeItems(uuids, opts = {}) {
  ensureFoundry();
  const cleaned = (Array.isArray(uuids) ? uuids : [])
    .map((u) => String(u ?? "").trim())
    .filter(Boolean);
  if (cleaned.length === 0) {
    ui.notifications?.warn(`${MODULE_ID}: no items to distribute.`);
    return null;
  }

  const candidates = listDistributableActors();
  if (candidates.length === 0) {
    ui.notifications?.warn(
      `${MODULE_ID}: no character-type actors available.`,
    );
    return null;
  }

  const title =
    opts.title ??
    (cleaned.length === 1
      ? "Send Item to Actor"
      : `Send ${cleaned.length} Items to Actor`);
  const hint =
    opts.hint ??
    `Choose a character. ${cleaned.length} item(s) will be added to their inventory.`;

  const options = candidates
    .map(
      (actor) =>
        `<option value="${escapeAttr(actor.id)}">${escapeText(actor.name)}</option>`,
    )
    .join("");

  const content = `
    <div class="infinity-dnd5e-distribute">
      <p>${escapeText(hint)}</p>
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
  const created = await distributeItemsToActor(chosenActorId, cleaned);
  return { actorId: chosenActorId, created };
}

/**
 * Copy each `uuid` (resolved via `fromUuid`) onto the actor.
 * Surfaces a single notification with the result.
 *
 * @param {string} actorId
 * @param {string[]} uuids
 * @returns {Promise<number>} number of items actually created.
 */
export async function distributeItemsToActor(actorId, uuids) {
  ensureFoundry();
  const actor = game.actors?.get?.(actorId);
  if (!actor) {
    ui.notifications?.error(`${MODULE_ID}: actor ${actorId} not found.`);
    return 0;
  }

  const itemData = [];
  const failures = [];
  for (const uuid of uuids) {
    try {
      const doc = await fromUuid(uuid);
      if (!doc) {
        failures.push(uuid);
        continue;
      }
      const obj = doc.toObject();
      // Strip the source `_id` so Foundry assigns a fresh one and we
      // never collide with an existing embedded item.
      delete obj._id;
      itemData.push(obj);
    } catch (error) {
      console.warn(`${MODULE_ID} | failed to resolve`, { uuid, error });
      failures.push(uuid);
    }
  }

  if (itemData.length === 0) {
    ui.notifications?.warn(
      `${MODULE_ID}: none of the ${uuids.length} item(s) resolved.`,
    );
    return 0;
  }

  try {
    await actor.createEmbeddedDocuments("Item", itemData);
  } catch (error) {
    console.error(`${MODULE_ID} | createEmbeddedDocuments failed`, error);
    ui.notifications?.error(
      `${MODULE_ID}: could not add items to ${actor.name}. See console.`,
    );
    return 0;
  }

  const failNote =
    failures.length > 0 ? ` (${failures.length} could not be resolved)` : "";
  ui.notifications?.info(
    `${MODULE_ID}: sent ${itemData.length} item(s) to ${actor.name}${failNote}.`,
  );
  return itemData.length;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

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

function escapeText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(value) {
  return escapeText(value).replace(/"/g, "&quot;");
}
