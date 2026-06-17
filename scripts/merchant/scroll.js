/**
 * Infinity D&D5e — Merchant scroll preservation
 *
 * ApplicationV2 replaces the window DOM on every render, so any action
 * that calls `render()` (select merchant, buy, bargain, toggle a row…)
 * snaps scrollable panes back to the top. This helper mirrors the loot
 * app's approach: continuously track each scroll pane's position, then
 * restore it right after the next render.
 *
 * Usage in an app:
 *   const TARGETS = [{ key: "rows", selector: ".ms-rows" }];
 *   // in _onRender(), after super:
 *   bindScrollTracking(root, TARGETS, () => { this._scroll = captureScroll(root, TARGETS); });
 *   restoreScroll(root, TARGETS, this._scroll);
 */

/** Snapshot scrollTop/scrollLeft for each present target. Null if none. */
export function captureScroll(root, targets) {
  if (!root || !Array.isArray(targets)) return null;
  const entries = [];
  for (const { key, selector } of targets) {
    const el = root.querySelector?.(selector);
    if (el) entries.push({ key, top: el.scrollTop, left: el.scrollLeft });
  }
  return entries.length ? { entries } : null;
}

/**
 * Restore a previously captured scroll state onto the (freshly rendered)
 * DOM. Runs immediately plus a couple of rAF retries because the pane's
 * scrollHeight may not be final until layout settles.
 *
 * `options.settleMs` adds one more delayed retry (default off) for panes
 * whose final height arrives after layout — the loot windows lean on it.
 */
export function restoreScroll(root, targets, state, options = {}) {
  if (!root || !state || !Array.isArray(targets)) return;
  const selectorByKey = new Map(targets.map((t) => [t.key, t.selector]));
  const apply = () => {
    for (const entry of state.entries ?? []) {
      const selector = selectorByKey.get(entry.key);
      const el = selector && root.querySelector?.(selector);
      if (!el) continue;
      const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
      const maxLeft = Math.max(0, el.scrollWidth - el.clientWidth);
      el.scrollTop = Math.min(entry.top, maxTop);
      el.scrollLeft = Math.min(entry.left, maxLeft);
    }
  };
  apply();
  if (typeof globalThis.requestAnimationFrame === "function") {
    globalThis.requestAnimationFrame(apply);
    globalThis.requestAnimationFrame(() =>
      globalThis.requestAnimationFrame(apply),
    );
  } else {
    apply();
  }
  if (Number.isFinite(options.settleMs) && options.settleMs > 0) {
    globalThis.setTimeout?.(apply, options.settleMs);
  }
}

/**
 * Attach a passive scroll listener to each target so the supplied
 * callback can capture the live position. Guards against double-binding
 * within the same DOM via a data flag (cleared automatically when the
 * element is replaced on the next render).
 *
 * `options.flag` names the dataset guard key so multiple consumers can
 * share this engine without colliding (defaults to the merchant flag).
 */
export function bindScrollTracking(root, targets, onScroll, options = {}) {
  if (!root || !Array.isArray(targets) || typeof onScroll !== "function") {
    return;
  }
  const flag = options.flag || "msScrollTracked";
  for (const { selector } of targets) {
    const el = root.querySelector?.(selector);
    if (!el || el.dataset?.[flag] === "true") continue;
    if (el.dataset) el.dataset[flag] = "true";
    el.addEventListener("scroll", onScroll, { passive: true });
  }
}
