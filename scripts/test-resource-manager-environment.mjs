import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import Handlebars from "handlebars";

const savedFoundry = globalThis.foundry;
const savedGame = globalThis.game;
const savedConst = globalThis.CONST;
const savedFromUuid = globalThis.fromUuid;
const savedUi = globalThis.ui;

const gm = { id: "gm", isGM: true, role: 4, active: true };
const otherGm = { id: "other-gm", isGM: true, role: 4, active: true };
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
let confirmationResult = true;
let confirmationCount = 0;
let lastConfirmation = null;
let pendingConfirmation = null;
let pendingResourceConfigWrite = null;
let failNextResourceConfigWrite = false;
let failNextRunStateWrite = false;
const notifications = [];

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
        DialogV2: {
          async confirm(options) {
            confirmationCount += 1;
            lastConfirmation = options;
            if (pendingConfirmation) {
              const pending = pendingConfirmation;
              pendingConfirmation = null;
              pending.markOpened();
              return await pending.result;
            }
            return confirmationResult;
          },
        },
      },
    },
    utils: {
      deepClone(value) {
        return structuredClone(value);
      },
    },
  };
  globalThis.fromUuid = async () => null;
  globalThis.ui = {
    notifications: {
      info(message) {
        notifications.push({ level: "info", message });
      },
      warn(message) {
        notifications.push({ level: "warn", message });
      },
      error(message) {
        notifications.push({ level: "error", message });
      },
    },
  };
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
        if (key === "resourceConfig" && failNextResourceConfigWrite) {
          failNextResourceConfigWrite = false;
          throw new Error("simulated resource config write failure");
        }
        if (key === "resourceRunState" && failNextRunStateWrite) {
          failNextRunStateWrite = false;
          throw new Error("simulated run-state write failure");
        }
        if (key === "resourceConfig" && pendingResourceConfigWrite) {
          const pending = pendingResourceConfigWrite;
          pendingResourceConfigWrite = null;
          pending.markStarted();
          await pending.release;
        }
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
  let environmentAtLastRender = null;
  let focusedSelector = null;
  const fakeApp = {
    element: {
      querySelector(selector) {
        return {
          focus() {
            focusedSelector = selector;
          },
        };
      },
    },
    render() {
      renderCount += 1;
      environmentAtLastRender =
        settingValues.get("resourceRunState")?.currentEnvironmentId ?? null;
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
  assert.match(
    focusedSelector ?? "",
    /data-environment-field="label"/,
    "copy moves focus to the new custom region name",
  );

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

  const waterDcInput = environmentInput(copied.id, "waterDc", "19");
  await ResourceManagerApp.prototype._onEnvironmentInput.call(
    fakeApp,
    waterDcInput,
  );
  savedCustom = store
    .normalizeResourceConfig(settingValues.get("resourceConfig"))
    .environments.find((environment) => environment.id === copied.id);
  assert.equal(savedCustom.foodDc, 15);
  assert.equal(savedCustom.waterDc, 19);
  assert.equal(savedCustom.dc, 19, "compatibility DC follows the harder check");

  let context =
    await ResourceManagerApp.prototype._prepareContext.call(fakeApp);
  assert.equal(context.currentEnvironment.isCustom, true);
  assert.equal(context.currentEnvLabel, "Ashen March");
  assert.equal(context.currentEnvFoodDc, 15);
  assert.equal(context.currentEnvWaterDc, 19);
  assert.equal(context.currentEnvDcsDiffer, true);
  assert.equal(context.canRunForageDrive, true);
  assert.equal(context.canCreateEnvironment, true);
  assert.equal(context.canMoveEnvironmentEarlier, false);
  assert.equal(context.canMoveEnvironmentLater, false);
  assert.equal(context.canRemoveEnvironment, true);
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
  let html = template(context);
  assert.match(html, /data-action="createEnvironment"/);
  assert.match(html, /data-action="copyEnvironment"/);
  assert.match(html, /data-action="moveEnvironment"/);
  assert.match(html, /data-action="removeEnvironment"/);
  assert.match(html, /aria-label="Edit current custom environment"/);
  assert.match(html, /data-environment-field="foodDc"/);
  assert.match(html, /data-environment-field="waterDc"/);
  assert.match(html, /data-environment-field="yieldWater"/);
  assert.match(html, /Food DC 15/);
  assert.match(html, /Water DC 19/);
  assert.match(html, /Ashen March/);

  const builtInIds = copiedConfig.environments
    .filter((environment) => environment.builtIn === true)
    .map((environment) => environment.id);
  const writeStarted = deferred();
  const releaseWrite = deferred();
  pendingResourceConfigWrite = {
    markStarted: writeStarted.resolve,
    release: releaseWrite.promise,
  };
  const queuedFieldSave = ResourceManagerApp.prototype._onEnvironmentInput.call(
    fakeApp,
    environmentInput(copied.id, "yieldWater", "1d8"),
  );
  await writeStarted.promise;
  let selectionFinished = false;
  const queuedSelection = ResourceManagerApp.prototype._onEnvironmentSelection
    .call(fakeApp, {
      value: "limited",
      dataset: { role: "environment" },
    })
    .then(() => {
      selectionFinished = true;
    });
  let createFinished = false;
  const queuedCreate =
    ResourceManagerApp.DEFAULT_OPTIONS.actions.createEnvironment
      .call(fakeApp)
      .then(() => {
        createFinished = true;
      });
  await Promise.resolve();
  assert.equal(
    createFinished,
    false,
    "catalog actions wait for an in-flight custom-region field save",
  );
  assert.equal(
    selectionFinished,
    false,
    "environment selection waits for an in-flight custom-region field save",
  );
  releaseWrite.resolve();
  await Promise.all([queuedFieldSave, queuedSelection, queuedCreate]);
  let catalog = store.normalizeResourceConfig(
    settingValues.get("resourceConfig"),
  ).environments;
  const createdId = settingValues.get("resourceRunState")?.currentEnvironmentId;
  const created = catalog.find((environment) => environment.id === createdId);
  assert.ok(created, "new action persists and activates a custom region");
  assert.equal(created.builtIn, false);
  assert.notEqual(created.id, copied.id);
  assert.equal(
    catalog.find((environment) => environment.id === copied.id)?.yieldWater,
    "1d8",
    "the queued create preserves the field save that completed first",
  );
  assert.match(
    focusedSelector ?? "",
    /data-environment-field="label"/,
    "new custom moves focus to its name field",
  );
  assert.deepEqual(
    catalog
      .filter((environment) => environment.builtIn === true)
      .map((environment) => environment.id),
    builtInIds,
    "creating a custom region leaves built-in presets unchanged",
  );

  context = await ResourceManagerApp.prototype._prepareContext.call(fakeApp);
  assert.equal(context.currentEnvironment.id, created.id);
  assert.equal(context.canMoveEnvironmentEarlier, true);
  assert.equal(context.canMoveEnvironmentLater, false);
  assert.equal(context.canRemoveEnvironment, true);
  html = template(context);
  const earlierButton = actionButton(html, "moveEnvironment", "earlier");
  const laterButton = actionButton(html, "moveEnvironment", "later");
  assert.ok(earlierButton, "the earlier action renders for a custom region");
  assert.ok(laterButton, "the later action renders for a custom region");
  assert.doesNotMatch(earlierButton, /\sdisabled(?:\s|=|>)/);
  assert.match(laterButton, /\sdisabled(?:\s|=|>)/);

  await ResourceManagerApp.DEFAULT_OPTIONS.actions.moveEnvironment.call(
    fakeApp,
    null,
    {
      dataset: { environmentId: created.id, direction: "earlier" },
    },
  );
  catalog = store.normalizeResourceConfig(
    settingValues.get("resourceConfig"),
  ).environments;
  assert.deepEqual(
    customEnvironmentIds(catalog),
    [created.id, copied.id],
    "move earlier reorders only the saved custom regions",
  );
  assert.equal(
    settingValues.get("resourceRunState")?.currentEnvironmentId,
    created.id,
    "reordering keeps the moved region active",
  );
  assert.equal(
    focusedSelector,
    "[data-role='environment']",
    "reordering restores focus to the environment selector",
  );

  context = await ResourceManagerApp.prototype._prepareContext.call(fakeApp);
  assert.equal(context.canMoveEnvironmentEarlier, false);
  assert.equal(context.canMoveEnvironmentLater, true);
  await ResourceManagerApp.DEFAULT_OPTIONS.actions.moveEnvironment.call(
    fakeApp,
    null,
    { dataset: { environmentId: created.id, direction: "later" } },
  );
  catalog = store.normalizeResourceConfig(
    settingValues.get("resourceConfig"),
  ).environments;
  assert.deepEqual(customEnvironmentIds(catalog), [copied.id, created.id]);

  users.activeGM = otherGm;
  context = await ResourceManagerApp.prototype._prepareContext.call(fakeApp);
  assert.equal(context.canCreateEnvironment, false);
  assert.equal(context.canRemoveEnvironment, false);
  assert.equal(
    context.canMoveEnvironmentEarlier,
    false,
    "a non-authoritative full GM inspects saved config without reordering it",
  );
  html = template(context);
  assert.match(
    html,
    /class="rm-setup__content" aria-disabled="true"/,
    "the setup panel exposes its read-only state to assistive technology",
  );
  const followerConfig = structuredClone(settingValues.get("resourceConfig"));
  const followerConfirmations = confirmationCount;
  await ResourceManagerApp.DEFAULT_OPTIONS.actions.removeResource.call(
    fakeApp,
    null,
    { dataset: { resourceId: "food" } },
  );
  await ResourceManagerApp.prototype._onDropItem.call(
    fakeApp,
    { preventDefault() {} },
    "food",
  );
  assert.equal(
    confirmationCount,
    followerConfirmations,
    "a follower action does not open a destructive dialog",
  );
  assert.deepEqual(
    settingValues.get("resourceConfig"),
    followerConfig,
    "a follower action or drop performs no setup write",
  );
  await ResourceManagerApp.DEFAULT_OPTIONS.actions.moveEnvironment.call(
    fakeApp,
    null,
    { dataset: { environmentId: created.id, direction: "earlier" } },
  );
  catalog = store.normalizeResourceConfig(
    settingValues.get("resourceConfig"),
  ).environments;
  assert.deepEqual(
    customEnvironmentIds(catalog),
    [copied.id, created.id],
    "a secondary GM cannot reorder the catalog",
  );
  await ResourceManagerApp.DEFAULT_OPTIONS.actions.moveEnvironment.call(
    fakeApp,
    null,
    { dataset: { environmentId: created.id, direction: "later" } },
  );
  users.activeGM = gm;
  catalog = store.normalizeResourceConfig(
    settingValues.get("resourceConfig"),
  ).environments;
  assert.deepEqual(customEnvironmentIds(catalog), [copied.id, created.id]);

  confirmationResult = false;
  await ResourceManagerApp.DEFAULT_OPTIONS.actions.removeEnvironment.call(
    fakeApp,
    null,
    { dataset: { environmentId: created.id } },
  );
  catalog = store.normalizeResourceConfig(
    settingValues.get("resourceConfig"),
  ).environments;
  assert.ok(
    catalog.some((environment) => environment.id === created.id),
    "cancelling the destructive confirmation keeps the custom region",
  );
  assert.match(lastConfirmation?.content ?? "", /Built-in regions are kept/);
  assert.match(lastConfirmation?.content ?? "", /Ashen March/);

  confirmationResult = true;
  const confirmationOpened = deferred();
  const resolveStaleConfirmation = deferred();
  pendingConfirmation = {
    markOpened: confirmationOpened.resolve,
    result: resolveStaleConfirmation.promise,
  };
  const staleRemoval =
    ResourceManagerApp.DEFAULT_OPTIONS.actions.removeEnvironment.call(
      fakeApp,
      null,
      { dataset: { environmentId: created.id } },
    );
  await confirmationOpened.promise;
  const changedRunState = structuredClone(
    settingValues.get("resourceRunState"),
  );
  changedRunState.currentEnvironmentId = copied.id;
  settingValues.set("resourceRunState", changedRunState);
  resolveStaleConfirmation.resolve(true);
  await staleRemoval;
  catalog = store.normalizeResourceConfig(
    settingValues.get("resourceConfig"),
  ).environments;
  assert.ok(
    catalog.some((environment) => environment.id === created.id),
    "removal aborts when the active region changes during confirmation",
  );
  assert.equal(
    settingValues.get("resourceRunState")?.currentEnvironmentId,
    copied.id,
  );

  changedRunState.currentEnvironmentId = created.id;
  settingValues.set("resourceRunState", structuredClone(changedRunState));

  failNextRunStateWrite = true;
  await ResourceManagerApp.DEFAULT_OPTIONS.actions.removeEnvironment.call(
    fakeApp,
    null,
    { dataset: { environmentId: created.id } },
  );
  catalog = store.normalizeResourceConfig(
    settingValues.get("resourceConfig"),
  ).environments;
  assert.ok(
    catalog.some((environment) => environment.id === created.id),
    "a failed fallback write keeps the custom region",
  );
  assert.equal(
    settingValues.get("resourceRunState")?.currentEnvironmentId,
    created.id,
  );
  assert.match(
    notifications.at(-1)?.message ?? "",
    /could not confirm the fallback environment/i,
  );

  failNextResourceConfigWrite = true;
  await ResourceManagerApp.DEFAULT_OPTIONS.actions.removeEnvironment.call(
    fakeApp,
    null,
    { dataset: { environmentId: created.id } },
  );
  catalog = store.normalizeResourceConfig(
    settingValues.get("resourceConfig"),
  ).environments;
  assert.ok(
    catalog.some((environment) => environment.id === created.id),
    "an unconfirmed catalog deletion leaves a reviewable saved region in this failure model",
  );
  assert.equal(
    settingValues.get("resourceRunState")?.currentEnvironmentId,
    copied.id,
    "the safe fallback remains active when deletion cannot be confirmed",
  );
  assert.match(
    notifications.at(-1)?.message ?? "",
    /switched to .* but could not confirm removal/i,
  );

  changedRunState.currentEnvironmentId = created.id;
  settingValues.set("resourceRunState", structuredClone(changedRunState));

  await ResourceManagerApp.DEFAULT_OPTIONS.actions.removeEnvironment.call(
    fakeApp,
    null,
    { dataset: { environmentId: created.id } },
  );
  catalog = store.normalizeResourceConfig(
    settingValues.get("resourceConfig"),
  ).environments;
  assert.ok(
    !catalog.some((environment) => environment.id === created.id),
    "confirmed removal deletes the selected custom region",
  );
  assert.equal(
    settingValues.get("resourceRunState")?.currentEnvironmentId,
    copied.id,
    "removal activates the deterministic nearest fallback",
  );
  assert.equal(
    environmentAtLastRender,
    copied.id,
    "the fallback is active before Quartermaster refreshes",
  );
  assert.equal(
    focusedSelector,
    "[data-role='environment']",
    "removal restores focus to the environment selector",
  );

  const confirmationsBeforeBuiltInAttempt = confirmationCount;
  await ResourceManagerApp.DEFAULT_OPTIONS.actions.removeEnvironment.call(
    fakeApp,
    null,
    { dataset: { environmentId: "limited" } },
  );
  assert.equal(
    confirmationCount,
    confirmationsBeforeBuiltInAttempt,
    "a built-in preset never reaches the removal confirmation",
  );
  assert.ok(
    store
      .normalizeResourceConfig(settingValues.get("resourceConfig"))
      .environments.some((environment) => environment.id === "limited"),
    "the remove action protects built-in presets",
  );

  users.activeGM = otherGm;
  const customCountBeforeGuard = customEnvironmentIds(catalog).length;
  await ResourceManagerApp.DEFAULT_OPTIONS.actions.createEnvironment.call(
    fakeApp,
  );
  assert.equal(
    customEnvironmentIds(
      store.normalizeResourceConfig(settingValues.get("resourceConfig"))
        .environments,
    ).length,
    customCountBeforeGuard,
    "a non-authoritative GM cannot create custom regions",
  );
  users.activeGM = gm;

  const customCountBeforeFailedSave = customEnvironmentIds(catalog).length;
  failNextResourceConfigWrite = true;
  await ResourceManagerApp.DEFAULT_OPTIONS.actions.createEnvironment.call(
    fakeApp,
  );
  catalog = store.normalizeResourceConfig(
    settingValues.get("resourceConfig"),
  ).environments;
  assert.equal(
    customEnvironmentIds(catalog).length,
    customCountBeforeFailedSave,
    "an unconfirmed initial create save does not activate a new region",
  );
  assert.match(
    notifications.at(-1)?.message ?? "",
    /could not confirm that the new custom region was saved/i,
  );

  const activeBeforeFailedActivation =
    settingValues.get("resourceRunState")?.currentEnvironmentId;
  failNextRunStateWrite = true;
  await ResourceManagerApp.DEFAULT_OPTIONS.actions.createEnvironment.call(
    fakeApp,
  );
  catalog = store.normalizeResourceConfig(
    settingValues.get("resourceConfig"),
  ).environments;
  assert.equal(
    customEnvironmentIds(catalog).length,
    customCountBeforeFailedSave + 1,
    "a custom region saved before an activation failure remains available",
  );
  assert.equal(
    settingValues.get("resourceRunState")?.currentEnvironmentId,
    activeBeforeFailedActivation,
    "failed activation leaves the previous environment active",
  );
  assert.match(
    notifications.at(-1)?.message ?? "",
    /saved custom region .* but could not confirm it became active/i,
  );
} finally {
  if (savedFoundry === undefined) delete globalThis.foundry;
  else globalThis.foundry = savedFoundry;
  if (savedGame === undefined) delete globalThis.game;
  else globalThis.game = savedGame;
  if (savedConst === undefined) delete globalThis.CONST;
  else globalThis.CONST = savedConst;
  if (savedFromUuid === undefined) delete globalThis.fromUuid;
  else globalThis.fromUuid = savedFromUuid;
  if (savedUi === undefined) delete globalThis.ui;
  else globalThis.ui = savedUi;
}

function customEnvironmentIds(catalog) {
  return catalog
    .filter((environment) => environment.builtIn === false)
    .map((environment) => environment.id);
}

function actionButton(html, action, direction) {
  return html.match(
    new RegExp(
      `<button\\b[^>]*data-action="${action}"[^>]*data-direction="${direction}"[^>]*>`,
    ),
  )?.[0];
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
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
