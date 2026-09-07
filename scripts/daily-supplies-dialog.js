import { confirmInfinityDialog } from "./dialog-contract.js";

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
}) {
  const resources = dailySupplyChoices(config);
  const renderer = globalThis.foundry?.applications?.handlebars?.renderTemplate;
  if (typeof renderer !== "function") return null;
  try {
    const content = await renderer(
      "modules/infinity-dnd5e/templates/daily-supplies-dialog.hbs",
      {
        resources: resources.map((r) => ({
          ...r,
          isParty: r.scope === "party",
        })),
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
