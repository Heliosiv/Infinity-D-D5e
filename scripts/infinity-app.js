/**
 * Infinity D&D5e — shared ApplicationV2 window helpers
 *
 * Small, behavior-preserving helpers shared by the non-loot ApplicationV2
 * windows (dashboard, shop picker, merchant workspace, merchant session).
 * These factor out the genuinely-identical boilerplate WITHOUT forcing a
 * single instance model:
 *
 *  - `openSingleton` owns the "create once, then focus-or-render" dance for
 *    windows that keep a single `static _instance`.
 *  - `applyVisualPrefs` toggles the animation + rarity-glow opt-out classes,
 *    each window passing its OWN class prefix (e.g. "mw-") so the existing
 *    CSS hooks are preserved.
 *
 * The merchant session keys instances by sessionId in a Map rather than a
 * single static field, so it intentionally does NOT use `openSingleton`; it
 * still shares `applyVisualPrefs`.
 */

import { SETTING_KEYS, getSetting } from "./settings.js";
import { isFullGM } from "./permissions.js";

const MODULE_ID = "infinity-dnd5e";

/**
 * Open (or focus) a single-instance ApplicationV2 window.
 *
 * Lazily constructs the instance via `factory` on first call, stores it on
 * `Cls._instance`, and on subsequent calls focuses the existing window when
 * it's already rendered (otherwise renders it). Each window's own `_onClose`
 * is responsible for nulling `Cls._instance` again.
 *
 * @template {{ _instance: any }} T
 * @param {T} Cls   The ApplicationV2 subclass holding the `_instance` field.
 * @param {() => InstanceType<T>} factory  Builds a fresh instance on demand.
 * @returns {InstanceType<T>} The live (rendered or focused) instance.
 */
export function openSingleton(Cls, factory) {
  if (!Cls._instance) {
    Cls._instance = factory();
  }
  const app = Cls._instance;
  if (app.rendered) {
    app.bringToFront();
  } else {
    app.render(true);
  }
  return app;
}

/**
 * Close a privileged ApplicationV2 window if the current user stops being a
 * full GM. Foundry still reports Assistant GMs as `isGM`, so checking that
 * convenience flag alone leaves private editor contents visible after a role
 * demotion.
 *
 * Returns an idempotent unsubscribe function for the application's `_onClose`.
 */
export function bindFullGmWindowGuard(application) {
  const hooks = globalThis.Hooks;
  if (!application || typeof hooks?.on !== "function") return () => {};

  let bound = true;
  let closing = false;
  const eventName = "updateUser";
  const hookId = hooks.on(eventName, (user) => {
    const currentUserId = String(globalThis.game?.user?.id ?? "");
    if (
      !bound ||
      closing ||
      !currentUserId ||
      String(user?.id ?? "") !== currentUserId ||
      isFullGM(user)
    ) {
      return;
    }

    closing = true;
    try {
      const result = application.close?.();
      if (result && typeof result.catch === "function") {
        void result.catch((error) => {
          closing = false;
          console.warn(
            `${MODULE_ID} | could not close a privileged window after role demotion`,
            error,
          );
        });
      }
    } catch (error) {
      closing = false;
      console.warn(
        `${MODULE_ID} | could not close a privileged window after role demotion`,
        error,
      );
    }
  });

  return () => {
    if (!bound) return;
    bound = false;
    hooks.off?.(eventName, hookId);
  };
}

/**
 * Reflect the animation + rarity-glow client settings as opt-out classes on a
 * window root, so CSS can disable motion / glow. Each window passes its own
 * class prefix (e.g. "mw-", "lf-") to keep its existing CSS hooks.
 *
 * @param {HTMLElement | null | undefined} root  The window's root element.
 * @param {string} prefix  Class prefix, e.g. "mw-" → "mw-no-anim"/"mw-no-glow".
 */
export function applyVisualPrefs(root, prefix) {
  if (!root?.classList) return;
  root.classList.toggle(
    `${prefix}no-anim`,
    getSetting(SETTING_KEYS.ANIMATIONS) === false,
  );
  root.classList.toggle(
    `${prefix}no-glow`,
    getSetting(SETTING_KEYS.RARITY_GLOW) === false,
  );
}
