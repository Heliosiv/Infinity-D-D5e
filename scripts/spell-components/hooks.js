import { SETTING_KEYS, getSetting } from "../settings.js";
import { applySpellComponentConsumption } from "./service.js";

const HOOK_MARKER = "__infinityDnd5eSpellComponentHooksV1";

let pendingConsumption = new WeakMap();

/** Register the synchronous dnd5e activity-consumption guard exactly once. */
export function registerSpellComponentHooks({
  hooks = globalThis.Hooks,
  notifications = globalThis.ui?.notifications,
} = {}) {
  if (!hooks || typeof hooks.on !== "function") return false;
  if (hooks[HOOK_MARKER]) return false;

  hooks.on(
    "dnd5e.activityConsumption",
    (activity, usageConfig, _messageConfig, updates) => {
      if (getSetting(SETTING_KEYS.SPELL_COMPONENTS_ENABLED) !== true) {
        return true;
      }

      const result = applySpellComponentConsumption({
        activity,
        usageConfig,
        updates,
      });
      if (!result.applies) return true;
      if (!result.ok) {
        notifications?.warn?.(insufficientMessage(result));
        return false;
      }

      pendingConsumption.set(updates, result);
      return true;
    },
  );

  hooks.on(
    "dnd5e.postActivityConsumption",
    (_activity, _usageConfig, _messageConfig, updates) => {
      const result = pendingConsumption.get(updates);
      if (!result) return;
      pendingConsumption.delete(updates);
      notifications?.info?.(successMessage(result));
    },
  );

  Object.defineProperty(hooks, HOOK_MARKER, {
    value: true,
    configurable: true,
  });
  return true;
}

export function resetSpellComponentHooksForTests(hooks) {
  pendingConsumption = new WeakMap();
  if (hooks?.[HOOK_MARKER]) delete hooks[HOOK_MARKER];
}

function insufficientMessage(result) {
  const actorName = result.actor?.name ?? "This character";
  const spellName = result.item?.name ?? "that spell";
  const unit = result.cost === 1 ? "component" : "components";
  return `${actorName} cannot cast ${spellName}. A level ${result.cost} cast needs ${result.cost} spell ${unit}, but only ${result.available} remain. Nothing was consumed.`;
}

function successMessage(result) {
  const actorName = result.actor?.name ?? "Character";
  const spellName = result.item?.name ?? "Spell";
  const unit = result.cost === 1 ? "component" : "components";
  return `${actorName} cast ${spellName} at level ${result.castLevel}, spending ${result.cost} spell ${unit} (${result.remaining} remaining).`;
}
