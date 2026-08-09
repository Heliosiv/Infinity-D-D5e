import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import Handlebars from "handlebars";

const savedFoundry = globalThis.foundry;
const savedGame = globalThis.game;
const savedConst = globalThis.CONST;
const savedFromUuid = globalThis.fromUuid;

const gm = {
  id: "gm",
  isGM: true,
  role: 4,
  active: true,
};
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
const stash = {
  id: "N",
  name: "Pack Mule",
  type: "npc",
  hasPlayerOwner: false,
  ownership: {},
  system: { attributes: { exhaustion: 0 } },
  items: { contents: [] },
};
const actors = [hero, stash];
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
        DialogV2: {
          async confirm() {
            return true;
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

  const [{ ResourceManagerApp }, store, { getPartyRoster }] = await Promise.all(
    [
      import("./resource-manager.js"),
      import("./resource/store.js"),
      import("./resource/calendar-watcher.js"),
    ],
  );

  function setConfig({ partyStashId = "N" } = {}) {
    const config = store.createDefaultResourceConfig();
    config.roster = [
      {
        actorId: "A",
        isStash: false,
        consumes: true,
        drawFrom: "self",
      },
      {
        actorId: "N",
        isStash: false,
        consumes: false,
        drawFrom: "self",
      },
    ];
    config.partyStashId = partyStashId;
    settingValues.set("resourceConfig", structuredClone(config));
  }

  const fakeApp = {
    _setupExpanded: false,
    element: {
      querySelector(selector) {
        return selector === "[data-role='add-roster']" ? { value: "N" } : null;
      },
    },
    render() {},
    async _renderPreservingFocus() {},
  };

  /* Setup stays session-local across ordinary context rerenders, and a
     blocking resource-rule conflict opens it so the correction is visible. */
  {
    setConfig();
    fakeApp._setupExpanded = true;
    let context =
      await ResourceManagerApp.prototype._prepareContext.call(fakeApp);
    assert.equal(
      context.setupExpanded,
      true,
      "an expanded setup disclosure survives a context rerender",
    );

    const config = settingValues.get("resourceConfig");
    config.resources.push({
      ...structuredClone(config.resources[0]),
      id: "duplicate-food",
      label: "Duplicate Food",
    });
    settingValues.set("resourceConfig", config);
    fakeApp._setupExpanded = false;
    context = await ResourceManagerApp.prototype._prepareContext.call(fakeApp);
    assert.equal(context.hasBlockingResourceConflicts, true);
    assert.equal(
      context.setupExpanded,
      true,
      "a blocking resource-rule conflict automatically opens setup",
    );
    assert.equal(fakeApp._setupExpanded, true);
  }

  /* Removing the selected party stash clears its global routing reference.
     Re-adding the same actor must not silently restore the old selection. */
  {
    setConfig();
    await ResourceManagerApp.DEFAULT_OPTIONS.actions.removeRosterMember.call(
      fakeApp,
      null,
      { dataset: { actorId: "N" } },
    );
    let saved = settingValues.get("resourceConfig");
    assert.equal(
      saved.partyStashId,
      "",
      "removing the selected stash clears partyStashId",
    );

    await ResourceManagerApp.DEFAULT_OPTIONS.actions.addRosterMember.call(
      fakeApp,
      null,
      null,
    );
    saved = settingValues.get("resourceConfig");
    const resolved = getPartyRoster(store.normalizeResourceConfig(saved));
    assert.equal(
      saved.partyStashId,
      "",
      "re-adding a former stash does not resurrect stale routing",
    );
    assert.equal(
      resolved.find((entry) => entry.actor.id === "A")?.drawFromId,
      "A",
      "the consumer still draws from its configured source",
    );
  }

  const template = Handlebars.compile(
    readFileSync(
      new URL("../templates/resource-manager.hbs", import.meta.url),
      "utf8",
    ),
  );

  /* The selected party stash is either protected from an ineffective row
     toggle, or toggling that row off clears the global party-stash selection. */
  {
    setConfig();
    const input = {
      type: "checkbox",
      checked: false,
      dataset: { configPath: "roster:N:isStash" },
    };
    await ResourceManagerApp.prototype._onConfigInput.call(fakeApp, input);
    const actionClearedPartyStash =
      settingValues.get("resourceConfig")?.partyStashId !== "N";

    const context =
      await ResourceManagerApp.prototype._prepareContext.call(fakeApp);
    const html = template(context);
    const stashCheckbox = html.match(
      /<input\b[^>]*data-config-path="roster:N:isStash"[^>]*>/,
    )?.[0];
    assert.ok(stashCheckbox, "selected stash row renders its Stash control");
    const checkboxDisabled = /\sdisabled(?:\s|=|>)/.test(stashCheckbox);
    assert.ok(
      actionClearedPartyStash || checkboxDisabled,
      "the selected party-stash checkbox cannot silently revert after use",
    );
  }

  /* Product language and runtime share one contract: the party stash is the
     draw source for all per-character resources, not only food and water. */
  {
    setConfig();
    const context =
      await ResourceManagerApp.prototype._prepareContext.call(fakeApp);
    const html = template(context);
    const control = html.match(
      /<div class="rm-stash-pick">[\s\S]*?<\/div>/,
    )?.[0];
    assert.ok(control, "party-stash control renders");
    const plainText = control
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
    assert.match(
      plainText,
      /per-character/i,
      "the control explains that custom per-character supplies use this stash",
    );
    assert.doesNotMatch(
      plainText,
      /food\s*&\s*water stash/i,
      "the label must not promise a narrower food/water-only scope",
    );
  }
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

process.stdout.write("resource manager roster validation passed\n");
