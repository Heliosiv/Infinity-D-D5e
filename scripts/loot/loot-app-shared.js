/**
 * Infinity D&D5e — shared loot-app helpers.
 *
 * Pure, Foundry-light helpers shared by the three loot windows
 * (Per-Encounter, Hoard, Per-Creature). Everything here was previously
 * copy-pasted into all three apps; centralizing it keeps behavior
 * identical across the tools and halves the maintenance surface.
 *
 * Nothing here touches `foundry.applications.api`, so this module is
 * safe to import in node tests. The few helpers that read live game
 * state (`livePartySize`, `resolveChatRecipients`) reference
 * `globalThis.game` lazily and degrade to neutral values when it's
 * absent.
 */

import { formatGp } from "../ui-util.js";

export const MODULE_ID = "infinity-dnd5e";
export const FALLBACK_ITEM_IMAGE = "icons/svg/item-bag.svg";

/** Mint a stable, unique id for a result entry (per roll, not per item). */
export function mintEntryId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `e-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
  );
}

/**
 * Decorate a raw rolled entry (from rollLoot) with everything the result
 * templates and the item-level controls need: a stable `entryId`,
 * display name, image, rarity, lock flag, per-unit gp, and labels.
 * Shared by all three tools so result tiles render and behave identically.
 *
 * @param {object} entry - raw entry from rollLoot
 * @param {object} [meta]
 * @param {string} [meta.imageSrc] - precomputed image (else derived)
 * @param {string} [meta.rarity]   - normalized rarity (else "common")
 * @param {boolean} [meta.isAmmo]  - whether to show a ×N quantity label
 */
export function decorateEntry(entry, { imageSrc, rarity, isAmmo } = {}) {
  const quantity = Math.max(1, Math.floor(Number(entry.quantity) || 1));
  const gpTotal = Number(entry.gpTotal ?? 0);
  const entryId = entry.entryId ?? entry.variant?.id ?? mintEntryId();
  return {
    ...entry,
    entryId,
    // `resultId` kept as an alias so existing templates (data-result-id /
    // data-item-id) keep resolving during the entryId transition.
    resultId: entryId,
    displayName: entry.displayName || entry.item?.name || "",
    imageSrc: imageSrc ?? resultImageForEntry(entry),
    variantSummary: entry.variant?.summary ?? "",
    sourceLabel: entry.variant ? `Base: ${entry.variant.baseName}` : "",
    valueLabel: entry.valueLabel ?? "",
    locked: entry.locked ?? false,
    rarity: rarity ?? "common",
    quantity,
    gpUnit: quantity > 0 ? gpTotal / quantity : gpTotal,
    quantityLabel: quantity > 1 || isAmmo ? `×${quantity} · ` : "",
    gpTotalLabel: formatGp(gpTotal),
  };
}

/**
 * Resolve the best image src for a result entry, rewriting bundled
 * art-pack paths to their module-relative URL and falling back to the
 * stock bag icon when nothing usable is present.
 */
export function resultImageForEntry(entry) {
  const image = String(
    entry?.imageSrc ?? entry?.itemData?.img ?? entry?.item?.img ?? "",
  ).trim();
  if (!image) return FALLBACK_ITEM_IMAGE;
  if (image.startsWith("assets/item-art/")) {
    return `modules/${MODULE_ID}/${image}`;
  }
  return image;
}

/** `<img>` error handler — swap a broken result image for the fallback once. */
export function onResultImageError(event) {
  const image = event.currentTarget;
  if (!image || image.dataset.fallbackApplied === "true") return;
  const fallbackSrc = image.dataset.fallbackSrc || FALLBACK_ITEM_IMAGE;
  image.dataset.fallbackApplied = "true";
  image.classList.add("is-fallback");
  if (image.getAttribute("src") !== fallbackSrc) image.src = fallbackSrc;
}

/**
 * Run a render callback, swallowing/​logging any sync throw or async
 * rejection so a failed re-render never breaks an action handler.
 */
export function renderAfterAction(callback, action) {
  try {
    const result = callback();
    if (typeof result?.catch === "function") {
      result.catch((error) =>
        console.warn(`${MODULE_ID} | ${action} render failed`, error),
      );
    }
  } catch (error) {
    console.warn(`${MODULE_ID} | ${action} render failed`, error);
  }
}

/**
 * Resolve a Send-to-Chat mode string to a whisper recipient list.
 * Returns `null` for public mode (caller skips setting `whisper`).
 *
 * - "public"           → null (no whisper, message goes to everyone)
 * - "whisper-gm"       → user ids of all currently-active GMs
 * - "whisper-players"  → user ids of all currently-active non-GM users
 */
export function resolveChatRecipients(mode) {
  if (mode === "public") return null;
  const users = globalThis.game?.users;
  if (!users) return null;
  const list = users.values?.() ?? users;
  const out = [];
  for (const user of list) {
    if (!user?.active) continue;
    const isGM = user.isGM === true || user.role >= 4; // ROLE.GAMEMASTER === 4
    if (mode === "whisper-gm" && isGM) out.push(user.id);
    if (mode === "whisper-players" && !isGM) out.push(user.id);
  }
  return out;
}

/**
 * Read the live player-character count from Foundry. Returns 0 when the
 * game isn't initialized (e.g. in tests) so callers can fall back
 * gracefully. Kept here (not in pure ui-util.js) so ui-util stays free
 * of Foundry globals.
 */
export function livePartySize() {
  const users = globalThis.game?.users;
  if (!users) return 0;
  let count = 0;
  for (const user of users.values?.() ?? users) {
    if (user?.character && user?.active !== false) count += 1;
  }
  return count;
}

/** Set element.textContent if the element exists; no-op otherwise. */
export function setText(root, selector, text) {
  const el = root?.querySelector(selector);
  if (el) el.textContent = String(text ?? "");
}

/** Collect every checked input[name="<group>"] inside a form. */
export function readMultiCheckGroup(root, group) {
  if (!root) return [];
  return [
    ...root.querySelectorAll(`input[type='checkbox'][name='${group}']:checked`),
  ].map((el) => el.value);
}

/**
 * Map a rolled result entry to the distribute helper's accepted shape,
 * preserving the rolled stack quantity. Handles generated `itemData`
 * (art / gem variants) and plain UUID-bearing compendium entries.
 * `displayName` wins for the label so rolled art-variant names survive.
 */
export function toDistributableEntry(entry) {
  if (!entry) return null;
  const quantity = Math.max(1, Math.floor(Number(entry.quantity) || 1));
  if (entry.itemData) {
    return {
      itemData: entry.itemData,
      name: entry.displayName ?? entry.itemData.name ?? entry.item?.name ?? "",
      quantity,
    };
  }
  const uuid = entry.item?.uuid;
  return uuid
    ? { uuid, name: entry.displayName ?? entry.item?.name ?? "", quantity }
    : null;
}

const TIER_LABELS = Object.freeze({
  t1: "T1 — Lvl 1–4",
  t2: "T2 — Lvl 5–10",
  t3: "T3 — Lvl 11–16",
  t4: "T4 — Lvl 17–20",
  t5: "T5 — Epic",
});

/** Long tier label ("T2 — Lvl 5–10") for the segmented tier buttons. */
export function tierLabel(tier) {
  return TIER_LABELS[tier] ?? tier;
}

/**
 * Treat two arrays as unordered sets — order doesn't matter, duplicates
 * collapse. Used by the sticky-defaults logic in tier/scale handlers.
 */
export function sameSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const setA = new Set(a);
  if (setA.size !== new Set(b).size) return false;
  for (const item of b) if (!setA.has(item)) return false;
  return true;
}

/**
 * Convert a key like "coinHeavy" or "very-rare" into a human label with
 * spaces: "Coin Heavy", "Very Rare". Empty input → "".
 */
export function humanizeKey(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  return raw
    .replace(/[-_]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
