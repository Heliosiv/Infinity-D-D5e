import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import Handlebars from "handlebars";

const savedFoundry = globalThis.foundry;
const savedGame = globalThis.game;
const savedConst = globalThis.CONST;
const savedFromUuid = globalThis.fromUuid;

const gm = { id: "gm", isGM: true, role: 4, active: true };
const users = [gm];
users.activeGM = gm;
users.get = (id) => users.find((user) => user.id === id) ?? null;

const hero = {
  id: "A",
  name: "Aria",
  type: "character",
  hasPlayerOwner: true,
  ownership: { player: 3 },
  system: { attributes: { exhaustion: 0 } },
  items: { contents: [] },
};
const actors = [hero];
actors.get = (id) => actors.find((actor) => actor.id === id) ?? null;

const settingValues = new Map();

try {
  globalThis.CONST = {
    USER_ROLES: { GAMEMASTER: 4 },
    DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 3 },
    AUDIO_CHANNELS: { INTERFACE: "interface" },
  };
  globalThis.foundry = {
    applications: {
      api: {
        ApplicationV2: class {},
        HandlebarsApplicationMixin: (Base) => class extends Base {},
      },
    },
    utils: {
      deepClone(value) {
        return structuredClone(value);
      },
    },
  };
  globalThis.fromUuid = async () => null;
  globalThis.game = {
    ready: false,
    user: gm,
    users,
    actors,
    settings: {
      get(moduleId, key) {
        if (moduleId !== "infinity-dnd5e") return undefined;
        return settingValues.get(key);
      },
      async set(moduleId, key, value) {
        assert.equal(moduleId, "infinity-dnd5e");
        settingValues.set(key, structuredClone(value));
        return value;
      },
    },
  };

  const [{ ResourceManagerApp }, store] = await Promise.all([
    import("./resource-manager.js"),
    import("./resource/store.js"),
  ]);
  settingValues.set("resourceConfig", store.createDefaultResourceConfig());
  settingValues.set("resourceRunState", {
    lastSeenDay: null,
    currentEnvironmentId: "limited",
    lastUpkeepResult: null,
  });

  let renderCount = 0;
  const fakeApp = {
    render() {
      renderCount += 1;
    },
    async _renderPreservingFocus() {
      renderCount += 1;
    },
  };

  await ResourceManagerApp.DEFAULT_OPTIONS.actions.copyEnvironment.call(
    fakeApp,
  );
  const copiedConfig = store.normalizeResourceConfig(
    settingValues.get("resourceConfig"),
  );
  const copiedId = settingValues.get("resourceRunState")?.currentEnvironmentId;
  const copied = copiedConfig.environments.find(
    (environment) => environment.id === copiedId,
  );
  assert.ok(copied, "copy action persists and activates a custom environment");
  assert.notEqual(
    copied.id,
    "limited",
    "the built-in preset remains immutable",
  );
  assert.equal(copied.dc, 15, "the custom copy retains preset rules");
  assert.ok(renderCount > 0, "copy action refreshes Quartermaster");

  const labelInput = environmentInput(copied.id, "label", "Ashen March");
  await ResourceManagerApp.prototype._onEnvironmentInput.call(
    fakeApp,
    labelInput,
  );
  let savedCustom = store
    .normalizeResourceConfig(settingValues.get("resourceConfig"))
    .environments.find((environment) => environment.id === copied.id);
  assert.equal(savedCustom.label, "Ashen March");
  assert.equal(labelInput.validationMessage, "");

  const invalidYield = environmentInput(
    copied.id,
    "yieldFood",
    "1d6 + @abilities.wis.mod",
  );
  await ResourceManagerApp.prototype._onEnvironmentInput.call(
    fakeApp,
    invalidYield,
  );
  savedCustom = store
    .normalizeResourceConfig(settingValues.get("resourceConfig"))
    .environments.find((environment) => environment.id === copied.id);
  assert.equal(
    savedCustom.yieldFood,
    copied.yieldFood,
    "invalid formula never reaches persisted configuration",
  );
  assert.ok(invalidYield.validationMessage, "invalid formula is shown inline");
  assert.equal(
    invalidYield.reported,
    true,
    "the invalid input reports validity",
  );

  const validYield = environmentInput(copied.id, "yieldFood", "2D4 + 1");
  await ResourceManagerApp.prototype._onEnvironmentInput.call(
    fakeApp,
    validYield,
  );
  savedCustom = store
    .normalizeResourceConfig(settingValues.get("resourceConfig"))
    .environments.find((environment) => environment.id === copied.id);
  assert.equal(
    savedCustom.yieldFood,
    "2d4+1",
    "valid formula is canonicalized",
  );

  const context =
    await ResourceManagerApp.prototype._prepareContext.call(fakeApp);
  assert.equal(context.currentEnvironment.isCustom, true);
  assert.equal(context.currentEnvLabel, "Ashen March");
  assert.equal(
    context.environments.find((environment) => environment.id === copied.id)
      ?.optionLabel,
    "Ashen March",
    "custom labels are visible instead of a title-cased internal id",
  );

  const template = Handlebars.compile(
    readFileSync(
      new URL("../templates/resource-manager.hbs", import.meta.url),
      "utf8",
    ),
  );
  const html = template(context);
  assert.match(html, /data-action="copyEnvironment"/);
  assert.match(html, /aria-label="Edit current custom environment"/);
  assert.match(html, /data-environment-field="yieldWater"/);
  assert.match(html, /Ashen March/);
} finally {
  if (savedFoundry === undefined) delete globalThis.foundry;
  else globalThis.foundry = savedFoundry;
  if (savedGame === undefined) delete globalThis.game;
  else globalThis.game = savedGame;
  if (savedConst === undefined) delete globalThis.CONST;
  else globalThis.CONST = savedConst;
  if (savedFromUuid === undefined) delete globalThis.fromUuid;
  else globalThis.fromUuid = savedFromUuid;
}

function environmentInput(environmentId, field, value) {
  return {
    type: "text",
    value,
    dataset: { environmentId, environmentField: field },
    validationMessage: "",
    reported: false,
    setCustomValidity(message) {
      this.validationMessage = message;
    },
    reportValidity() {
      this.reported = true;
      return !this.validationMessage;
    },
  };
}

process.stdout.write("resource manager environment validation passed\n");
