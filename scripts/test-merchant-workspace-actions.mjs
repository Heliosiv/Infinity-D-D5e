import assert from "node:assert/strict";

const gm = { id: "gm", role: 4, isGM: true, active: true };
const users = [gm];
users.activeGM = gm;
users.get = (id) => users.find((user) => user.id === id);
const settings = new Map([["soundsEnabled", false]]);
const notifications = [];
let writes = 0;
let packReads = 0;
let confirm = async () => true;
let pickerOptions;
let onPickerRender = () => {};
globalThis.CONST = { USER_ROLES: { GAMEMASTER: 4 } };
globalThis.foundry = {
  applications: {
    api: {
      ApplicationV2: class {
        render() {
          onPickerRender(this);
        }
      },
      HandlebarsApplicationMixin: (Base) => class extends Base {},
      DialogV2: { confirm: (options) => confirm(options) },
    },
    apps: {
      FilePicker: {
        implementation: class {
          constructor(options) {
            pickerOptions = options;
          }
          render() {}
        },
      },
    },
  },
  utils: { deepClone: (value) => structuredClone(value) },
};
globalThis.ui = {
  notifications: Object.fromEntries(
    ["info", "warn", "error"].map((type) => [
      type,
      (message) => notifications.push({ type, message }),
    ]),
  ),
};
globalThis.game = {
  ready: false,
  user: gm,
  users,
  actors: [],
  settings: {
    get: (_module, key) => settings.get(key),
    set: async (_module, key, value) => {
      writes++;
      settings.set(key, structuredClone(value));
      return value;
    },
  },
  packs: {
    get: () => {
      packReads++;
      return null;
    },
  },
  socket: { emit() {} },
};
const { MerchantWorkspaceApp } = await import("./merchant-workspace.js");
const { normalizeMerchant, findMerchant } = await import("./merchant/store.js");

function fixture() {
  settings.set(
    "merchants",
    ["a", "b"].map((id) =>
      normalizeMerchant({
        id,
        name: `Merchant ${id}`,
        pool: {
          lootTypes: ["loot.weapon.mundane"],
          rarities: ["common"],
          count: 2,
        },
        buyFilter: {
          lootTypes: ["loot.armor.mundane"],
          rarities: ["uncommon"],
        },
        items: [
          { uuid: `Item.${id}`, qty: 1, startingQty: 5, unlimited: false },
        ],
      }),
    ),
  );
  writes = 0;
  packReads = 0;
  notifications.length = 0;
  const app = Object.create(MerchantWorkspaceApp.prototype);
  Object.assign(app, {
    _selectedId: "a",
    _itemCache: new Map(),
    rendered: true,
    renders: 0,
    render() {
      this.renders++;
    },
    _saveFromForm: async () => {
      throw new Error("Interrupted form save");
    },
  });
  return app;
}

const failures = [];
async function check(label, run) {
  try {
    await run();
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
  }
}

for (const replace of [false, true]) {
  await check(
    `stock save failure (${replace ? "replace" : "append"})`,
    async () => {
      const app = fixture();
      await app._generateStock({ replace });
      assert.equal(
        packReads,
        0,
        "a failed form save must stop before reading or rolling stock",
      );
      assert.equal(writes, 0);
      assert.equal(app.renders, 0, "the failed draft must remain visible");
      assert.match(notifications.at(-1)?.message ?? "", /save|saved/i);
    },
  );
}
await check("copy filter save failure", async () => {
  const app = fixture();
  await MerchantWorkspaceApp.DEFAULT_OPTIONS.actions.copyStockToBuyFilter.call(
    app,
  );
  assert.equal(writes, 0, "failed form save must not copy old filters");
  assert.equal(app.renders, 0);
});
await check("market preset save failure", async () => {
  const app = fixture();
  const inputs = { poolMinGp: { value: "1" }, poolMaxGp: { value: "50" } };
  app.element = {
    querySelector: () => ({
      querySelector: (selector) => inputs[selector.match(/name="([^"]+)"/)[1]],
    }),
  };
  await MerchantWorkspaceApp.DEFAULT_OPTIONS.actions.marketTier.call(
    app,
    null,
    { dataset: { min: "100", max: "500" } },
  );
  assert.equal(inputs.poolMinGp.value, "100");
  assert.equal(
    app.renders,
    0,
    "failed preset edits must remain available for retry",
  );
});
await check("art save failure", async () => {
  const app = fixture();
  const input = { value: "old.webp" };
  app.element = { querySelector: () => input };
  await MerchantWorkspaceApp.DEFAULT_OPTIONS.actions.pickArt.call(app);
  await pickerOptions.callback("new.webp");
  assert.equal(input.value, "new.webp");
  assert.equal(
    app.renders,
    0,
    "failed art selection must not discard the chosen path",
  );
});

await check("art picker survives a workspace refresh", async () => {
  const app = fixture();
  const oldInput = { value: "old.webp" };
  let currentInput = oldInput;
  app.element = { querySelector: () => currentInput };
  app._saveFromForm = async () => {
    app.savedArt = currentInput.value;
  };
  await MerchantWorkspaceApp.DEFAULT_OPTIONS.actions.pickArt.call(app);
  currentInput = { value: "old.webp" };
  await pickerOptions.callback("selected.webp");
  assert.equal(
    app.savedArt,
    "selected.webp",
    "the picker must update the current form after a refresh",
  );
  assert.equal(oldInput.value, "old.webp");
});

await check("art picker selection change", async () => {
  const app = fixture();
  const input = { value: "old.webp" };
  app.element = { querySelector: () => input };
  let saves = 0;
  app._saveFromForm = async () => {
    saves++;
  };
  await MerchantWorkspaceApp.DEFAULT_OPTIONS.actions.pickArt.call(app);
  app._selectedId = "b";
  await pickerOptions.callback("selected.webp");
  assert.equal(saves, 0);
  assert.equal(input.value, "old.webp");
});

for (const action of ["deleteMerchant", "clearInventory", "restock"]) {
  await check(`${action} selection change`, async () => {
    const app = fixture();
    const before = structuredClone(settings.get("merchants"));
    confirm = async () => {
      app._selectedId = "b";
      return true;
    };
    await MerchantWorkspaceApp.DEFAULT_OPTIONS.actions[action].call(app);
    assert.deepEqual(
      settings.get("merchants"),
      before,
      "a prompt for A must never write to B after selection changes",
    );
    assert.equal(app._selectedId, "b");
    assert.equal(writes, 0);
  });
}
await check("successful copy retry", async () => {
  const app = fixture();
  app._saveFromForm = async () => {};
  await MerchantWorkspaceApp.DEFAULT_OPTIONS.actions.copyStockToBuyFilter.call(
    app,
  );
  assert.deepEqual(findMerchant("a").buyFilter, {
    lootTypes: ["loot.weapon.mundane"],
    rarities: ["common"],
  });
  assert.equal(writes, 1);
});
for (const action of ["clearInventory", "restock"]) {
  await check(`${action} confirmed success`, async () => {
    const app = fixture();
    confirm = async () => true;
    await MerchantWorkspaceApp.DEFAULT_OPTIONS.actions[action].call(app);
    assert.equal(findMerchant("b").items[0].qty, 1);
    assert.equal(
      action === "clearInventory"
        ? findMerchant("a").items.length
        : findMerchant("a").items[0].qty,
      action === "clearInventory" ? 0 : 5,
    );
    assert.equal(writes, 1);
  });
}
await check("merchant selection preserves a failed draft", async () => {
  const app = fixture();
  await MerchantWorkspaceApp.DEFAULT_OPTIONS.actions.selectMerchant.call(
    app,
    null,
    { dataset: { merchantId: "b" } },
  );
  assert.equal(
    app._selectedId,
    "a",
    "failed edits must not disappear when choosing another merchant",
  );
  assert.equal(app.renders, 0);
});
await check("merchant selection saves once before switching", async () => {
  const app = fixture();
  let saves = 0;
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  app._saveFromForm = async () => {
    saves++;
    await pending;
  };
  const action = () =>
    MerchantWorkspaceApp.DEFAULT_OPTIONS.actions.selectMerchant.call(
      app,
      null,
      { dataset: { merchantId: "b" } },
    );
  const first = action();
  const repeated = action();
  release();
  await Promise.all([first, repeated]);
  assert.equal(saves, 1);
  assert.equal(app._selectedId, "b");
  assert.equal(app.renders, 1);
});
await check(
  "merchant selection survives a save-triggered refresh",
  async () => {
    const app = fixture();
    app.constructor = { RENDER_STATES: { RENDERING: 1 } };
    app._saveFromForm = async () => {
      app.rendered = false;
      app.state = 1;
    };
    await MerchantWorkspaceApp.DEFAULT_OPTIONS.actions.selectMerchant.call(
      app,
      null,
      { dataset: { merchantId: "b" } },
    );
    assert.equal(app._selectedId, "b");
    assert.equal(app.renders, 1);
  },
);
await check(
  "closed merchant window cannot resume a pending selection",
  async () => {
    const app = fixture();
    app.constructor = { RENDER_STATES: { RENDERING: 1 } };
    app._saveFromForm = async () => {
      app.rendered = false;
      app.state = -1;
    };
    await MerchantWorkspaceApp.DEFAULT_OPTIONS.actions.selectMerchant.call(
      app,
      null,
      { dataset: { merchantId: "b" } },
    );
    assert.equal(app._selectedId, "a");
    assert.equal(app.renders, 0);
  },
);
await check("read-only merchant browsing does not save", async () => {
  const app = fixture();
  const savedUser = game.user;
  game.user = { id: "secondary", role: 4, isGM: true, active: true };
  try {
    await MerchantWorkspaceApp.DEFAULT_OPTIONS.actions.selectMerchant.call(
      app,
      null,
      { dataset: { merchantId: "b" } },
    );
    assert.equal(app._selectedId, "b");
    assert.equal(writes, 0);
  } finally {
    game.user = savedUser;
  }
});
await check("read-only Workbench navigation does not save", async () => {
  const app = fixture();
  const savedUser = game.user;
  game.user = { id: "secondary", role: 4, isGM: true, active: true };
  try {
    assert.equal(await app._beforeWorkbenchNavigate(), true);
    assert.equal(writes, 0);
    assert.deepEqual(notifications, []);
  } finally {
    game.user = savedUser;
  }
});
await check("same-GM follower can leave Merchants without saving", async () => {
  const app = fixture();
  globalThis.window = { document: {} };
  globalThis.JournalEntry = { create() {} };
  try {
    assert.equal(await app._beforeWorkbenchNavigate(), true);
    assert.equal(writes, 0);
    assert.deepEqual(notifications, []);
  } finally {
    delete globalThis.window;
    delete globalThis.JournalEntry;
  }
});
await check("writable Workbench preserves a failed draft", async () => {
  const app = fixture();
  await assert.rejects(app._beforeWorkbenchNavigate(), /Interrupted form save/);
  assert.equal(app._selectedId, "a");
  assert.equal(app.renders, 0);
});
await check("item lookup selection change", async () => {
  const app = fixture();
  app._resolveItem = async () => {
    app._selectedId = "b";
    return { name: "Sword", type: "weapon" };
  };
  await app._addUuidToInventory("Item.sword");
  assert.equal(
    writes,
    0,
    "a late item lookup must never stock a newly selected merchant",
  );
});
await check("missing item does not create broken stock", async () => {
  const app = fixture();
  app._resolveItem = async () => null;
  await app._addUuidToInventory("Item.missing");
  assert.equal(writes, 0);
  assert.match(notifications.at(-1)?.message ?? "", /item|load|available/i);
});
await check("resolved item stocks the intended merchant", async () => {
  const app = fixture();
  app._resolveItem = async () => ({ name: "Sword", type: "weapon" });
  await app._addUuidToInventory("Item.sword");
  assert.equal(
    findMerchant("a").items.some((row) => row.uuid === "Item.sword"),
    true,
  );
  assert.equal(findMerchant("b").items.length, 1);
});
await check("failed item lookup can recover on retry", async () => {
  const app = fixture();
  let available = false;
  globalThis.fromUuid = async () =>
    available ? { name: "Recovered sword", type: "weapon" } : null;
  try {
    assert.equal(await app._resolveItem("Item.recovered"), null);
    available = true;
    assert.equal(
      (await app._resolveItem("Item.recovered"))?.name,
      "Recovered sword",
      "a cached lookup failure must not permanently block retry",
    );
  } finally {
    delete globalThis.fromUuid;
  }
});
await check("library picker selection change", async () => {
  const app = fixture();
  game.packs.get = () => ({
    getDocuments: async () => [
      { _id: "1234567890123456", name: "Sword", type: "weapon" },
    ],
  });
  app._resolveItem = async () => ({ name: "Sword", type: "weapon" });
  onPickerRender = (picker) => {
    app._selectedId = "b";
    picker._settle(picker._options[0].id);
  };
  await MerchantWorkspaceApp.DEFAULT_OPTIONS.actions.addFromPack.call(app);
  assert.equal(
    writes,
    0,
    "a library choice is bound to the merchant that opened it",
  );
});
assert.deepEqual(failures, [], failures.join("\n"));
console.log(
  "Merchant workspace failure, retry, and delayed confirmation journeys passed",
);
