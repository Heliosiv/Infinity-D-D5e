/**
 * Infinity D&D5e - template-backed Forage Drive setup dialog.
 *
 * This surface only collects the active GM's choices. The authoritative
 * resource service validates the selected actors, targets, environment, and
 * inventory again before any roll prompt or write is attempted.
 */

import { promptInfinityDialog } from "./dialog-contract.js";
import { FORAGE_TARGETS, normalizeForageTarget } from "./resource/forage.js";

const MODULE_ID = "infinity-dnd5e";
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/forage-drive-dialog.hbs`;

const TARGET_OPTIONS = Object.freeze([
  Object.freeze({
    value: FORAGE_TARGETS.BOTH,
    label: "Food & water",
  }),
  Object.freeze({ value: FORAGE_TARGETS.FOOD, label: "Food only" }),
  Object.freeze({ value: FORAGE_TARGETS.WATER, label: "Water only" }),
]);

function boundedDc(value, fallback = 15) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed)
    ? Math.max(0, Math.min(100, parsed))
    : fallback;
}

/** Build a strict, Handlebars-ready projection for the setup dialog. */
export function buildForageDriveDialogContext(input = {}) {
  const canForageFood = input.canForageFood !== false;
  const canForageWater = input.canForageWater !== false;
  const defaultTarget =
    canForageFood && canForageWater
      ? FORAGE_TARGETS.BOTH
      : canForageFood
        ? FORAGE_TARGETS.FOOD
        : FORAGE_TARGETS.WATER;
  const foodDc = boundedDc(input.defaultFoodDc, boundedDc(input.defaultDc, 15));
  const waterDc = boundedDc(
    input.defaultWaterDc,
    boundedDc(input.defaultDc, 15),
  );
  const candidates = (Array.isArray(input.candidates) ? input.candidates : [])
    .filter((candidate) => String(candidate?.actorId ?? "").trim())
    .map((candidate) => ({
      actorId: String(candidate.actorId).trim(),
      name: String(candidate.name ?? "Character").trim() || "Character",
      online: candidate.online === true,
      statusLabel: candidate.online === true ? "Player rolls" : "GM rolls",
      targetOptions: TARGET_OPTIONS.map((option) => ({
        ...option,
        selected: option.value === defaultTarget,
        disabled:
          (option.value === FORAGE_TARGETS.BOTH &&
            !(canForageFood && canForageWater)) ||
          (option.value === FORAGE_TARGETS.FOOD && !canForageFood) ||
          (option.value === FORAGE_TARGETS.WATER && !canForageWater),
      })),
    }));

  return {
    environmentLabel:
      String(input.environmentLabel ?? "Current environment").trim() ||
      "Current environment",
    canForageFood,
    canForageWater,
    foodDc,
    waterDc,
    dcsDiffer: canForageFood && canForageWater && foodDc !== waterDc,
    destinationLabel: input.stashName
      ? `${String(input.stashName).trim()}'s party stash`
      : "Each forager's configured draw source",
    candidates,
    hasCandidates: candidates.length > 0,
    allOffline:
      candidates.length > 0 &&
      candidates.every((candidate) => !candidate.online),
  };
}

/** Read only checked, allowlisted per-forager choices from the native dialog form. */
export function readForageDriveDialogSubmission(form) {
  if (!form || typeof form.querySelectorAll !== "function") return null;
  const foragers = [];
  const seen = new Set();
  for (const checkbox of form.querySelectorAll(
    'input[name="forager"]:checked',
  )) {
    const actorId = String(checkbox?.value ?? "").trim();
    if (!actorId || seen.has(actorId)) continue;
    const row = checkbox.closest?.("[data-forager-row]");
    const rawTarget = row?.querySelector?.("[data-forage-target]")?.value;
    const forageTarget = normalizeForageTarget(rawTarget);
    seen.add(actorId);
    foragers.push({ actorId, forageTarget });
  }
  return {
    foodDc: boundedDc(form.elements?.foodDc?.value, 15),
    waterDc: boundedDc(form.elements?.waterDc?.value, 15),
    foragers,
  };
}

/** Render and open the setup dialog. Cancellation or unavailable UI -> null. */
export async function promptForageDriveDialog(input = {}) {
  const renderer =
    globalThis.foundry?.applications?.handlebars?.renderTemplate ?? null;
  if (typeof renderer !== "function") {
    globalThis.ui?.notifications?.warn?.(
      "Forage Drive could not open on this client. Nothing changed; reload Foundry and try again.",
    );
    return null;
  }

  const context = buildForageDriveDialogContext(input);
  let content;
  try {
    content = await renderer(TEMPLATE_PATH, context);
  } catch (error) {
    console.warn(`${MODULE_ID} | could not render Forage Drive setup`, error);
    globalThis.ui?.notifications?.warn?.(
      "Forage Drive could not open on this client. Nothing changed; reload Foundry and try again.",
    );
    return null;
  }

  return await promptInfinityDialog({
    window: {
      title: "Forage Drive",
      icon: "fa-solid fa-wheat-awn",
    },
    classes: ["infinity-forage-drive-dialog"],
    position: { width: 660 },
    content,
    ok: {
      label: "Start forage drive",
      icon: "fa-solid fa-paper-plane",
      callback: (_event, button) =>
        readForageDriveDialogSubmission(button?.form),
    },
    rejectClose: false,
  });
}
