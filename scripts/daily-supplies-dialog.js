import { confirmInfinityDialog } from "./dialog-contract.js";
import {
  buildDailySupplyPreview,
  dailySupplyContextFingerprint,
} from "./resource/daily-preview.js";

/** Per-run choices; never modify the campaign's saved resource rules. */
export function dailySupplyChoices(config = {}) {
  return (config.resources ?? []).filter(
    (resource) =>
      resource.perDay > 0 &&
      (config.waterEnabled !== false ||
        (resource.id !== "water" && resource.forageYields !== "water")),
  );
}

/** False means an explicit skip; null means closed/unavailable and can be retried. */
export async function promptDailySupplies({
  config,
  days = 1,
  rollover = false,
  readContext = null,
}) {
  const renderer = globalThis.foundry?.applications?.handlebars?.renderTemplate;
  if (typeof renderer !== "function") return null;
  try {
    const context =
      typeof readContext === "function"
        ? readContext()
        : { config, roster: [] };
    config = context.config;
    const fingerprint = dailySupplyContextFingerprint(context);
    const preview = await buildDailySupplyPreview({ ...context, days });
    const resources = dailySupplyChoices(config);
    const content = await renderer(
      "modules/infinity-dnd5e/templates/daily-supplies-dialog.hbs",
      {
        resources: resources.map((r) => ({
          ...r,
          isParty: r.scope === "party",
          ...preview.resources.find((entry) => entry.id === r.id),
        })),
        consumerCount: preview.consumerCount,
        days,
        rollover,
        hasResources: resources.length > 0,
      },
    );
    return await confirmInfinityDialog(
      {
        window: { title: "Use daily supplies?", icon: "fa-solid fa-utensils" },
        content,
        modal: rollover,
        yes: {
          label: "Use selected supplies",
          default: false,
          callback: (_event, button) => {
            if (
              typeof readContext === "function" &&
              dailySupplyContextFingerprint(readContext()) !== fingerprint
            ) {
              globalThis.ui?.notifications?.warn?.(
                "Supplies or rules changed while this preview was open. Reopen Use Daily Supplies to review the new amounts. Nothing changed.",
              );
              return null;
            }
            const form = button?.form;
            if (!form?.querySelectorAll) return null;
            const checked = new Set(
              [
                ...form.querySelectorAll('input[name="dailyResource"]:checked'),
              ].map((input) => input.value),
            );
            const resourceIds = resources
              .filter((r) => checked.has(r.id))
              .map((r) => r.id);
            if (!resourceIds.length) {
              globalThis.ui?.notifications?.warn?.(
                "Select at least one supply, or choose Skip supplies. Nothing changed.",
              );
              return null;
            }
            return { resourceIds };
          },
        },
        no: { label: "Skip supplies", default: true, callback: () => false },
        rejectClose: false,
      },
      { cancelValue: null },
    );
  } catch (error) {
    console.warn("infinity-dnd5e | daily supplies dialog failed", error);
    return null;
  }
}
