/** Isolated browser fixture using the real downtime service, adapters and UI. */
export async function mountHuntingJourney() {
  const clone = (v) => structuredClone(v);
  const settings = new Map();
  const gm = { id: "gm", name: "GM", isGM: true, role: 4, active: true };
  const player = {
    id: "player",
    name: "Player",
    isGM: false,
    role: 1,
    active: true,
  };
  const users = new Map([
    [gm.id, gm],
    [player.id, player],
  ]);
  users.activeGM = gm;
  globalThis.CONST = {
    DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, OWNER: 3 },
    USER_ROLES: { GAMEMASTER: 4 },
    ACTIVE_EFFECT_MODES: { ADD: 2 },
  };
  globalThis.foundry = {
    utils: {
      deepClone: clone,
      randomID: () => crypto.randomUUID().replaceAll("-", "").slice(0, 16),
    },
    applications: {
      api: {
        ApplicationV2: class {},
        HandlebarsApplicationMixin: (Base) => class extends Base {},
      },
    },
  };
  const actor = {
    id: "mira",
    name: "Mira",
    type: "character",
    img: "icons/svg/mystery-man.svg",
    ownership: { default: 0, player: 3 },
    system: { currency: { pp: 0, gp: 10, ep: 0, sp: 0, cp: 0 } },
    items: new Map(),
  };
  player.character = actor;
  function item(raw) {
    const value = {
      ...clone(raw),
      id: raw._id,
      parent: actor,
      toObject() {
        return clone({ ...raw, system: this.system, flags: this.flags });
      },
      async update(changes) {
        if ("system.quantity" in changes)
          this.system.quantity = changes["system.quantity"];
        return this;
      },
    };
    actor.items.set(value.id, value);
    return value;
  }
  actor.createEmbeddedDocuments = async (type, rows) => rows.map(item);
  actor.deleteEmbeddedDocuments = async (type, ids) =>
    ids.map((id) => {
      const i = actor.items.get(id);
      actor.items.delete(id);
      return i;
    });
  actor.update = async (changes) => {
    for (const [key, value] of Object.entries(changes)) {
      if (key.startsWith("system.currency."))
        actor.system.currency[key.split(".")[2]] = value;
    }
    return actor;
  };
  const bow = item({
    _id: "bow",
    type: "weapon",
    name: "Longbow",
    system: {
      quantity: 1,
      properties: ["amm"],
      ammunition: { type: "arrow" },
      activities: [
        {
          id: "shot",
          type: "attack",
          attack: { type: { value: "ranged", classification: "weapon" } },
        },
      ],
    },
  });
  Object.defineProperty(bow.system.activities[0], "getAttackData", {
    value: () => ({ parts: ["5"], data: {} }),
  });
  item({
    _id: "arrows",
    type: "consumable",
    name: "Arrows",
    system: { quantity: 5, type: { value: "ammo", subtype: "arrow" } },
  });
  globalThis.game = {
    ready: false,
    user: gm,
    users,
    world: { id: "hunting-browser" },
    actors: new Map([[actor.id, actor]]),
    settings: {
      get: (module, key) => clone(settings.get(key)),
      set: async (module, key, v) => {
        settings.set(key, clone(v));
        return v;
      },
    },
    socket: { emit() {} },
    time: { serverTime: 1000 },
  };
  globalThis.fromUuid = async () => ({
    toObject: () => ({
      _id: "rations",
      name: "Rations",
      type: "consumable",
      system: { quantity: 1, type: { value: "food" } },
      flags: {
        core: { sourceId: "Compendium.dnd5e.items.Item.f4w4GxBi0nYXmhX4" },
      },
    }),
  });
  const state = { survivalRolls: 0, attackRolls: 0 };
  globalThis.Roll = class {
    constructor() {
      this.total = 15;
      this.formula = "1d20+5";
      this.dice = [{ faces: 20, results: [{ result: 10, active: true }] }];
    }
    async evaluate() {
      state.attackRolls++;
      return this;
    }
    async toMessage() {}
  };
  const service = await import("./downtime/service.js");
  const store = await import("./downtime/store.js");
  const { DowntimeWorkspaceApp } = await import("./downtime-workspace.js");
  const { DowntimeActivitiesApp } = await import("./downtime-activities.js");
  const { createDowntimePlayerAdapter } =
    await import("./downtime/ui-adapter.js");
  const gmAdapter = service.downtimeWorkspaceAdapter;
  let playerAdapter;
  function playerSession() {
    playerAdapter = createDowntimePlayerAdapter({
      isAuthority: () => true,
      registerSocket: () => {},
      subscribeSocket: () => () => {},
      getCurrentUserId: () => player.id,
      getActor: () => actor,
      rollSkill: async () => {
        state.survivalRolls++;
        return { ok: true, total: 11, roll: { formula: "1d20+5" } };
      },
    });
    return playerAdapter;
  }
  playerSession();
  async function mount(name, { freshPlayer = false } = {}) {
    if (globalThis.journey?.app) {
      globalThis.journey.app.rendered = false;
      await globalThis.journey.app.rendering;
    }
    if (freshPlayer) playerSession();
    const Type =
      name === "workspace" ? DowntimeWorkspaceApp : DowntimeActivitiesApp;
    const app = Object.create(Type.prototype);
    Object.assign(app, {
      element: document.getElementById("app"),
      _adapter: name === "workspace" ? gmAdapter : playerAdapter,
      _view: "current",
      _actorId: actor.id,
      _busy: false,
      _guidedReportDrafts: new Map(),
      rendered: true,
      _statusMessage: "",
      _errorMessage: "",
      _selectedSettlementId: null,
      _creatingSettlement: false,
    });
    app.captureWorkbenchTarget = undefined;
    app.prepareWorkbenchContext = undefined;
    app.element.className = `infinity-dnd5e infinity-downtime-${name}`;
    app.render = () => {
      app.rendering = (app.rendering ?? Promise.resolve()).then(async () => {
        const context = await app._prepareContext();
        const response = await fetch("/render", {
          method: "POST",
          body: JSON.stringify({ name, context }),
        });
        app.element.innerHTML = await response.text();
        app._onRender(context, {});
        for (const button of app.element.querySelectorAll("[data-action]"))
          button.addEventListener("click", async (event) => {
            if (button.disabled) return;
            try {
              await Type.DEFAULT_OPTIONS.actions[button.dataset.action].call(
                app,
                event,
                button,
              );
            } catch (error) {
              state.error = error.message;
            }
          });
      });
      return app.rendering;
    };
    journey.app = app;
    await app.render();
  }
  globalThis.journey = { state, actor, mount, service, store };
  await mount("workspace");
}
