/** Real Workbench/Merchant controllers and templates with in-memory campaign storage. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import Handlebars from "handlebars";
import { chromium } from "playwright";
import { auditPlayerRequests } from "./workbench-player-journey.mjs";

const root = path.resolve(".");
const outputRoot = path.resolve("output/playwright");
mkdirSync(outputRoot, { recursive: true });
const out = mkdtempSync(path.join(outputRoot, "workbench-journey-"));
const manifest = JSON.parse(readFileSync("module.json", "utf8"));
const renderMerchant = Handlebars.compile(
  readFileSync("templates/gm-workbench-nav.hbs", "utf8") +
    readFileSync("templates/merchant-workspace.hbs", "utf8"),
);
const renderPlayers = Object.fromEntries(
  ["shop-picker", "resource-overview"].map((surface) => [
    `/render/${surface}`,
    Handlebars.compile(readFileSync(`templates/${surface}.hbs`, "utf8")),
  ]),
);
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    if (pathname === "/") {
      response.setHeader("content-type", "text/html");
      response.end(
        `<!doctype html><html lang="en"><head><title>Workbench functional gauntlet</title>${manifest.styles.map((file) => `<link rel="stylesheet" href="/${file}">`).join("")}<style>body{margin:0;padding:16px;background:#171a1c;color:#eee;font-family:Arial}#app{height:860px;margin:auto;position:relative;max-width:1040px}.application-content{height:100%;display:flex;flex-direction:column;overflow:hidden}button,input,select,textarea{font:inherit}#notices{position:fixed;right:8px;bottom:8px;max-width:340px;padding:8px;background:#171a1c;z-index:10;pointer-events:none}button{cursor:pointer}</style></head><body><div id="notices" role="status"></div><section id="app" class="infinity-dnd5e infinity-merchant-workspace infinity-gm-workbench"><div class="application-content"></div></section></body></html>`,
      );
    } else if (
      (pathname === "/render" || renderPlayers[pathname]) &&
      request.method === "POST"
    ) {
      let body = "";
      for await (const chunk of request) body += chunk;
      response.end(
        (renderPlayers[pathname] ?? renderMerchant)(JSON.parse(body)),
      );
    } else if (/^\/(?:scripts|styles|assets)\/[\w/.-]+$/.test(pathname)) {
      const filename = path.resolve(root, `.${pathname}`);
      if (!filename.startsWith(`${root}${path.sep}`))
        throw new Error("Invalid path");
      const type = {
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".webp": "image/webp",
      }[path.extname(filename)];
      if (!type) throw new Error("Unsupported asset");
      response.setHeader("content-type", type);
      response.end(readFileSync(filename));
    } else if (pathname.startsWith("/icons/")) {
      response.setHeader("content-type", "image/svg+xml");
      response.end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#847048"/></svg>',
      );
    } else {
      response.writeHead(404);
      response.end();
    }
  } catch (error) {
    response.writeHead(500);
    response.end(error.message);
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1040, 720, 380]) {
    const page = await browser.newPage({
      viewport: { width: width + 32, height: 980 },
    });
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(async () => {
      const state = {
        failSave: false,
        writes: 0,
        actions: [],
        routeOpens: [],
        failRoute: true,
      };
      const settings = new Map([["soundsEnabled", false]]);
      const gm = { id: "gm", name: "GM", isGM: true, role: 4, active: true };
      const users = [gm];
      users.activeGM = gm;
      users.get = (id) => users.find((user) => user.id === id);
      globalThis.CONST = { USER_ROLES: { GAMEMASTER: 4 } };
      globalThis.foundry = {
        utils: { deepClone: (value) => structuredClone(value) },
        applications: {
          api: {
            ApplicationV2: class {},
            HandlebarsApplicationMixin: (Base) => class extends Base {},
            DialogV2: {
              confirm: async () => {
                state.confirmPending = true;
                return new Promise((resolve) => {
                  state.confirm = resolve;
                });
              },
            },
          },
        },
      };
      globalThis.ui = {
        notifications: Object.fromEntries(
          ["info", "warn", "error"].map((type) => [
            type,
            (message) => {
              document.getElementById("notices").textContent = message;
            },
          ]),
        ),
      };
      globalThis.game = {
        ready: false,
        user: gm,
        users,
        actors: [],
        socket: { emit() {} },
        settings: {
          get: (_module, key) => settings.get(key),
          set: async (_module, key, value) => {
            if (key === "merchants") {
              if (state.failSave)
                throw new Error("Injected storage interruption");
              if (state.holdSave) {
                state.savePending = true;
                await new Promise((resolve) => {
                  state.releaseSave = resolve;
                });
                state.holdSave = false;
              }
              state.writes++;
            }
            settings.set(key, structuredClone(value));
            return value;
          },
        },
      };
      const { MerchantWorkspaceApp } =
        await import("/scripts/merchant-workspace.js");
      const {
        GmWorkbenchApp,
        configureGmWorkbench,
        getActiveGmWorkbenchApplication,
      } = await import("/scripts/gm-workbench.js");
      const { normalizeMerchant, findMerchant } =
        await import("/scripts/merchant/store.js");
      settings.set(
        "merchants",
        ["a", "b"].map((id) =>
          normalizeMerchant({
            id,
            name: `Merchant ${id}`,
            pool: { lootTypes: ["loot.weapon.mundane"], rarities: ["common"] },
            buyFilter: { lootTypes: ["loot.armor.mundane"] },
            items: [{ uuid: `Item.${id}`, qty: 1, startingQty: 5 }],
          }),
        ),
      );
      const app = Object.create(MerchantWorkspaceApp.prototype);
      Object.assign(app, {
        element: document.getElementById("app"),
        _selectedId: "a",
        rendered: true,
        _reviewIdentities: new Map(),
        _itemCache: new Map(
          ["a", "b"].map((id) => [
            `Item.${id}`,
            {
              name: `Sword ${id}`,
              system: { price: { value: 5, denomination: "gp" } },
            },
          ]),
        ),
        _saveStatus: "All changes saved",
        _gmWorkbenchSwitching: false,
        close() {
          this.rendered = false;
          this.element.hidden = true;
          this._onClose({});
          return Promise.resolve();
        },
      });
      const actions = {
        ...GmWorkbenchApp.DEFAULT_OPTIONS.actions,
        ...MerchantWorkspaceApp.DEFAULT_OPTIONS.actions,
      };
      app.render = () => {
        app.rendering = (app.rendering ?? Promise.resolve()).then(async () => {
          const context = await app._prepareContext();
          const response = await fetch("/render", {
            method: "POST",
            body: JSON.stringify(context),
          });
          app.element.querySelector(".application-content").innerHTML =
            await response.text();
          app._onRender(context, {});
        });
        return app.rendering;
      };
      app.element.addEventListener("click", async (event) => {
        const button = event.target.closest("[data-action]");
        if (!button || button.disabled) return;
        try {
          await actions[button.dataset.action].call(app, event, button);
          state.actions.push(button.dataset.action);
        } catch (error) {
          state.actionError = error.message;
        }
      });
      configureGmWorkbench(
        Object.fromEntries(
          ["merchants", "downtime", "injuries"].map((route) => [
            route,
            {
              open(options) {
                if (state.failRoute) return null;
                state.routeOpens.push(route);
                return {
                  rendered: true,
                  setWorkbenchTarget(target) {
                    this.target = target;
                  },
                  captureWorkbenchTarget() {
                    return this.target;
                  },
                  render() {},
                  bringToFront() {},
                };
              },
            },
          ]),
        ),
      );
      globalThis.journey = {
        state,
        app,
        settings,
        findMerchant,
        getActiveGmWorkbenchApplication,
      };
      await app.render();
    });
    const clickAction = async (action) => {
      const count = await page.evaluate(() => journey.state.actions.length);
      await page.locator(`[data-action="${action}"]`).first().click();
      await page.waitForFunction(
        (before) =>
          journey.state.actions.length > before || journey.state.actionError,
        count,
      );
      assert.equal(
        await page.evaluate(() => journey.state.actionError ?? ""),
        "",
      );
      await page.evaluate(() => journey.app.rendering);
    };

    // Failed writes must leave the user's form and stored filter intact.
    await page.evaluate(() => {
      journey.state.failSave = true;
    });
    await page.locator('input[name="name"]').fill("Draft merchant name");
    await clickAction("copyStockToBuyFilter");
    assert.equal(
      await page.locator('input[name="name"]').inputValue(),
      "Draft merchant name",
    );
    assert.equal(await page.evaluate(() => journey.state.writes), 0);
    assert.deepEqual(
      await page.evaluate(() => journey.findMerchant("a").buyFilter.lootTypes),
      ["loot.armor.mundane"],
    );
    assert.match(await page.locator("#notices").textContent(), /Save now/);
    const selectionsBefore = await page.evaluate(
      () =>
        journey.state.actions.filter((action) => action === "selectMerchant")
          .length,
    );
    await page
      .locator('[data-action="selectMerchant"][data-merchant-id="b"]')
      .click();
    await page.waitForFunction(
      (before) =>
        journey.state.actions.filter((action) => action === "selectMerchant")
          .length > before,
      selectionsBefore,
    );
    assert.equal(await page.evaluate(() => journey.app._selectedId), "a");
    assert.equal(
      await page.locator('input[name="name"]').inputValue(),
      "Draft merchant name",
    );
    await page.locator('[data-workbench-route="downtime"]').click();
    await page.waitForFunction(() => !journey.app._gmWorkbenchNavigating);
    assert.equal(await page.evaluate(() => journey.app.rendered), true);
    assert.equal(
      await page.locator('input[name="name"]').inputValue(),
      "Draft merchant name",
    );

    // Retry saves the actual edited fields, then copies the chosen stock filter.
    await page.evaluate(() => {
      journey.state.failSave = false;
    });
    await clickAction("save");
    await clickAction("copyStockToBuyFilter");
    assert.equal(
      await page.evaluate(() => journey.findMerchant("a").name),
      "Draft merchant name",
    );
    assert.deepEqual(
      await page.evaluate(() => journey.findMerchant("a").buyFilter.lootTypes),
      ["loot.weapon.mundane"],
    );
    for (const id of ["b", "a"]) {
      await page
        .locator(`[data-action="selectMerchant"][data-merchant-id="${id}"]`)
        .click();
      await page.waitForFunction(
        (id) =>
          journey.app._selectedId === id && !journey.app._merchantSelecting,
        id,
      );
      await page.evaluate(() => journey.app.rendering);
    }

    // A confirmation can outlive its selected merchant; never retarget it.
    const beforePrompt = await page.evaluate(() =>
      JSON.stringify(journey.settings.get("merchants")),
    );
    await page.locator('[data-action="clearInventory"]').click();
    await page.waitForFunction(() => journey.state.confirmPending);
    await page.evaluate(() => {
      journey.app._selectedId = "b";
      journey.state.confirm(true);
    });
    await page.waitForFunction(() =>
      journey.state.actions.includes("clearInventory"),
    );
    assert.equal(
      await page.evaluate(() =>
        JSON.stringify(journey.settings.get("merchants")),
      ),
      beforePrompt,
    );
    await page.evaluate(async () => {
      journey.app._selectedId = "a";
      await journey.app.render();
    });

    // A failed route leaves the current workspace usable, including its draft.
    await page.locator('[data-workbench-route="injuries"]').click();
    await page.waitForFunction(() => !journey.app._gmWorkbenchNavigating);
    assert.equal(await page.evaluate(() => journey.app.rendered), true);
    assert.match(await page.locator("#notices").textContent(), /did not open/);
    await page
      .locator("#app")
      .screenshot({ path: path.join(out, `merchant-recovered-${width}.png`) });

    // Two route clicks during one delayed save open only the first destination.
    await page.evaluate(() => {
      journey.state.failRoute = false;
      journey.state.holdSave = true;
    });
    await page.locator('[data-workbench-route="downtime"]').click();
    await page.waitForFunction(() => journey.state.savePending);
    await page.locator('[data-workbench-route="injuries"]').click();
    await page.evaluate(() => journey.state.releaseSave());
    await page.waitForFunction(() => !journey.app._gmWorkbenchNavigating);
    assert.deepEqual(await page.evaluate(() => journey.state.routeOpens), [
      "downtime",
    ]);
    assert.equal(
      await page.evaluate(
        () =>
          journey.getActiveGmWorkbenchApplication().captureWorkbenchTarget()
            .route,
      ),
      "downtime",
    );
    assert.deepEqual(errors, []);
    assert.equal(
      await page.evaluate(() => journey.state.actionError ?? ""),
      "",
    );
    await auditPlayerRequests(page, width, out);
    assert.deepEqual(errors, []);
    await page.close();
    console.log(
      `Workbench functional journey passed at ${width}px: failed save, draft recovery, filter retry, stale confirmation, failed route, repeated navigation.`,
    );
  }
  console.log(`Workbench journey evidence: ${out}`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
