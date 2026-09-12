import assert from "node:assert/strict";
import { promptDailySupplies } from "./daily-supplies-dialog.js";
import { buildDailySupplyPreview } from "./resource/daily-preview.js";
const original = { foundry: globalThis.foundry, ui: globalThis.ui };
try {
  let mutate = () => {};
  let checked = ["food"];
  let mode = "yes";
  let rendered;
  const context = {
    config: {
      resources: [
        {
          id: "food",
          label: "Rations",
          scope: "per-character",
          perDay: 1,
          forageYields: "food",
          matching: { nameKeywords: ["Rations"] },
        },
      ],
      halfRations: true,
    },
    roster: [
      {
        actorId: "hero",
        name: "Hero",
        consumes: true,
        items: [{ id: "ration", name: "Rations", quantity: 3 }],
      },
    ],
  };
  const warnings = [];
  globalThis.ui = {
    notifications: { warn: (message) => warnings.push(message) },
  };
  globalThis.foundry = {
    applications: {
      handlebars: {
        renderTemplate: async (_path, data) => {
          rendered = data;
          return "preview";
        },
      },
      api: {
        DialogV2: {
          confirm: async (options) => {
            mutate();
            return options[mode].callback(null, {
              form: {
                querySelectorAll: () => checked.map((value) => ({ value })),
              },
            });
          },
        },
      },
    },
  };
  const open = () =>
    promptDailySupplies({
      config: context.config,
      days: 3,
      readContext: () => structuredClone(context),
    });
  assert.deepEqual(await open(), { resourceIds: ["food"] });
  assert.equal(rendered.resources[0].required, 2);
  assert.equal(rendered.consumerCount, 1);
  mutate = () => {
    context.roster[0].items[0].quantity--;
  };
  assert.equal(
    await open(),
    null,
    "changed inventory invalidates confirmation",
  );
  assert.match(warnings.at(-1), /changed/);
  mutate = () => {
    context.config.halfRations = !context.config.halfRations;
  };
  assert.equal(await open(), null, "changed rules invalidate confirmation");
  mutate = () => {};
  checked = [];
  assert.equal(await open(), null, "empty selection is not an implicit skip");
  mode = "no";
  assert.equal(await open(), false, "explicit skip remains distinct");
  const empty = await buildDailySupplyPreview({
    config: context.config,
    roster: [],
    days: 3,
  });
  assert.equal(empty.consumerCount, 0);
  assert.equal(empty.resources[0].required, 0);
  console.log(
    "Daily preview: exact charge, stale inventory/rules, empty roster and skip semantics passed",
  );
} finally {
  Object.assign(globalThis, original);
}
