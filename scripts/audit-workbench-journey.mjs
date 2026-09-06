/** Real Workbench/Merchant controllers and templates with in-memory campaign storage. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import Handlebars from "handlebars";
import { chromium } from "playwright";
import { auditPlayerRequests } from "./workbench-player-journey.mjs";
import { auditFactionNavigation } from "./workbench-faction-journey.mjs";

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
renderPlayers["/render/factions"] = Handlebars.compile(
  readFileSync("templates/gm-workbench-nav.hbs", "utf8") +
    readFileSync("templates/reputation-workspace.hbs", "utf8"),
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
            ApplicationV2: class {
              constructor(options) {
                this.options = options;
                this.element = document.createElement("section");
                this.element.id = options.id;
                this.element.className =
                  "infinity-dnd5e infinity-merchant-workspace";
                this.element.style.cssText =
                  "height:760px;max-width:820px;margin:16px auto";
                this.element.innerHTML =
                  '<div class="application-content"></div>';
                document.body.append(this.element);
                this.element.addEventListener("click", async (event) => {
                  const target = event.target.closest("[data-action]");
                  if (!target || target.disabled) return;
                  try {
                    await this.constructor.DEFAULT_OPTIONS.actions[
                      target.dataset.action
                    ].call(this, event, target);
                    state.actions.push(target.dataset.action);
                  } catch (error) {
                    state.actionError = error.message;
                  }
                });
              }
              render() {
                this.rendered = true;
                return globalThis.renderMerchantApp(this);
              }
              bringToFront() {
                this.element.scrollIntoView();
              }
              async close() {
                this.rendered = false;
                this.element.hidden = true;
                this._onClose({});
              }
            },
            HandlebarsApplicationMixin: (Base) => class extends Base {},
            DialogV2: {
              confirm: async () => {
                state.confirmationCount = (state.confirmationCount ?? 0) + 1;
                if (state.autoConfirm) return true;
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
        packs: {
          get: () => ({
            getDocuments: async () =>
              ["loot.equipment", "loot.weapon.mundane", "loot.reagent"].map(
                (lootType, index) => ({
                  _id: `stock-${index}`,
                  name: `Shop stock ${index}`,
                  type: "loot",
                  system: {
                    rarity: "common",
                    quantity: 1,
                    price: { value: 5, denomination: "gp" },
                  },
                  flags: { "infinity-dnd5e": { lootType } },
                }),
              ),
          }),
        },
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
        _merchantSearch: "",
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
      globalThis.renderMerchantApp = (app) => {
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
      app.render = () => renderMerchantApp(app);
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
        MerchantWorkspaceApp,
      };
      await app.render();
    });
    const directory = page.locator("#app");
    assert.equal(await directory.locator('input[name="name"]').count(), 0);
    await directory
      .locator('[data-action="selectMerchant"][data-merchant-id="a"]')
      .click();
    await page.waitForSelector('#infinity-merchant-a input[name="name"]');
    const editor = page.locator("#infinity-merchant-a");
    const selectTab = async (key) => {
      await editor.locator(`[data-merchant-tab="${key}"]`).click();
    };
    const clickAction = async (action) => {
      const count = await page.evaluate(() => journey.state.actions.length);
      if (
        action === "copyStockToBuyFilter" &&
        !(await editor.locator(`[data-action="${action}"]`).isVisible())
      ) {
        await editor
          .getByText("What this merchant buys", { exact: true })
          .click();
      }
      await editor.locator(`[data-action="${action}"]`).first().click();
      await page.waitForFunction(
        (before) =>
          journey.state.actions.length > before || journey.state.actionError,
        count,
      );
      assert.equal(
        await page.evaluate(() => journey.state.actionError ?? ""),
        "",
      );
      await page.evaluate(
        () => journey.MerchantWorkspaceApp._editors.get("a").rendering,
      );
    };
    await page.evaluate(() => {
      journey.state.failSave = true;
    });
    await editor.locator('input[name="name"]').fill("Draft merchant name");
    await selectTab("advanced");
    await clickAction("copyStockToBuyFilter");
    assert.equal(
      await editor.locator('input[name="name"]').inputValue(),
      "Draft merchant name",
    );
    assert.equal(await page.evaluate(() => journey.state.writes), 0);
    assert.deepEqual(
      await page.evaluate(() => journey.findMerchant("a").buyFilter.lootTypes),
      ["loot.armor.mundane"],
    );
    assert.match(await page.locator("#notices").textContent(), /Save now/);
    await directory
      .locator('[data-action="selectMerchant"][data-merchant-id="b"]')
      .click();
    await page.waitForSelector('#infinity-merchant-b input[name="name"]');
    assert.equal(
      await editor.locator('input[name="name"]').inputValue(),
      "Draft merchant name",
    );
    assert.equal(
      await page
        .locator('#infinity-merchant-b input[name="name"]')
        .inputValue(),
      "Merchant b",
    );
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

    // Auto-saving a stock-generation number must not rebuild the editor that
    // initiated the write. Rebuilding collapses the disclosure, drops focus,
    // and forces the GM to find their place after every spinner/key change.
    await selectTab("advanced");
    const stockGeneration = editor
      .locator("details")
      .filter({ hasText: "Stock generation settings" });
    await stockGeneration.locator("summary").click();
    const balanceInput = stockGeneration.locator(
      '[name="poolRarityWeight.common"]',
    );
    await balanceInput.scrollIntoViewIfNeeded();
    const scrollBeforeBalanceEdit = await editor
      .locator(".mw-tab-content")
      .evaluate((element) => element.scrollTop);
    const writesBeforeBalanceEdit = await page.evaluate(
      () => journey.state.writes,
    );
    await balanceInput.focus();
    await balanceInput.press("ArrowUp");
    await page.waitForFunction(
      (before) => journey.state.writes > before,
      writesBeforeBalanceEdit,
    );
    await page.evaluate(
      () => journey.MerchantWorkspaceApp._editors.get("a").rendering,
    );
    assert.equal(
      await stockGeneration.getAttribute("open"),
      "",
      "stock-generation settings stay expanded after their autosave",
    );
    assert.equal(
      await balanceInput.evaluate(
        (element) => document.activeElement === element,
      ),
      true,
      "the edited stock-generation number keeps focus after autosave",
    );
    assert.equal(
      await editor
        .locator(".mw-tab-content")
        .evaluate(
          (element, expected) => Math.abs(element.scrollTop - expected) <= 1,
          scrollBeforeBalanceEdit,
        ),
      true,
      "stock-generation autosave preserves the editor viewpoint",
    );
    const beforePrompt = await page.evaluate(() =>
      JSON.stringify(journey.settings.get("merchants")),
    );
    await selectTab("stock");
    await editor.locator('[data-action="clearInventory"]').click();
    await page.waitForFunction(() => journey.state.confirmPending);
    await page.evaluate(async () => {
      await journey.MerchantWorkspaceApp._editors.get("a").close();
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

    // The real location-first controllers: create pre-stocked shops, keep two
    // locations open, then reset stock and purses through the main page.
    await page.evaluate(() => {
      journey.state.autoConfirm = true;
    });
    const directoryAction = async (selector) => {
      const before = await page.evaluate(() => journey.state.actions.length);
      await directory.locator(selector).click();
      await page.waitForFunction(
        (count) =>
          journey.state.actions.length > count || journey.state.actionError,
        before,
      );
      await page.evaluate(() => journey.app.rendering);
      assert.equal(
        await page.evaluate(() => journey.state.actionError ?? ""),
        "",
      );
    };
    const createLocation = async (name) => {
      await directory.locator(".mw-location-create > summary").click();
      await directory.locator('[name="locationName"]').fill(name);
      await directory
        .locator('[name="locationTemplate"]')
        .selectOption("village");
      await directoryAction('[data-action="createLocation"]');
      assert.equal(
        await directory.locator(".mw-location-heading h3").textContent(),
        name,
      );
      assert.equal(await directory.locator(".mw-list__row").count(), 3);
      return page.evaluate(() => journey.app._selectedLocationId);
    };
    const harbor = await createLocation("Harbor");
    const beforeOpenConfirms = await page.evaluate(
      () => journey.state.confirmationCount,
    );
    await directoryAction('[data-operation="open"]');
    assert.equal(
      await page.evaluate(() => journey.state.confirmationCount),
      beforeOpenConfirms,
      "Open All has no approval step",
    );
    const river = await createLocation("River village");
    await directoryAction('[data-operation="open"]');
    const openIn = (id) =>
      page.evaluate(
        (locationId) =>
          journey.settings
            .get("merchants")
            .filter((row) => row.shop?.locationId === locationId)
            .every((row) => row.shop.open),
        id,
      );
    assert.equal(await openIn(harbor), true);
    assert.equal(await openIn(river), true);
    await directoryAction('[data-operation="close"]');
    assert.equal(
      await openIn(harbor),
      true,
      "closing River village leaves Harbor open",
    );
    assert.equal(await openIn(river), false);
    await directoryAction(
      `[data-action="selectLocation"][data-location-id="${harbor}"]`,
    );
    await page.evaluate(async (locationId) => {
      const { commitMerchantWrite } =
        await import("/scripts/merchant/socket.js");
      const merchant = journey.settings
        .get("merchants")
        .find((row) => row.shop?.locationId === locationId);
      await commitMerchantWrite(merchant.id, (fresh) => ({
        ...fresh,
        goldOnHand: 1,
        items: fresh.items.map((item) => ({ ...item, qty: 0 })),
      }));
    }, harbor);
    await directoryAction('[data-operation="restock"]');
    assert.equal(
      await page.evaluate(
        (locationId) =>
          journey.settings
            .get("merchants")
            .filter((row) => row.shop?.locationId === locationId)
            .every(
              (row) =>
                row.goldOnHand === 250 &&
                row.items.every((item) => item.qty === item.startingQty),
            ),
        harbor,
      ),
      true,
    );
    await directoryAction('[data-operation="clear"]');
    assert.equal(
      await page.evaluate(
        (locationId) =>
          journey.settings
            .get("merchants")
            .filter((row) => row.shop?.locationId === locationId)
            .every((row) => row.items.length === 0 && row.goldOnHand === 250),
        harbor,
      ),
      true,
    );
    await directoryAction('[data-operation="generate"]');
    assert.equal(
      await page.evaluate(
        (locationId) =>
          journey.settings
            .get("merchants")
            .filter((row) => row.shop?.locationId === locationId)
            .every((row) => row.items.length > 0 && row.goldOnHand === 250),
        harbor,
      ),
      true,
    );
    assert.equal(await openIn(river), false);
    await directory.locator('[data-workbench-route="injuries"]').click();
    await page.waitForFunction(() => !journey.app._gmWorkbenchNavigating);
    assert.equal(await directory.isVisible(), true);
    assert.match(await page.locator("#notices").textContent(), /did not open/);
    await directory.screenshot({
      path: path.join(out, `merchant-directory-${width}.png`),
    });
    await page.evaluate(() => {
      journey.state.failRoute = false;
    });
    await directory.locator('[data-workbench-route="downtime"]').click();
    await page.waitForFunction(() => !journey.app._gmWorkbenchNavigating);
    assert.deepEqual(await page.evaluate(() => journey.state.routeOpens), [
      "downtime",
    ]);
    assert.equal(
      await page.locator("#infinity-merchant-b").isVisible(),
      true,
      "focused editor survives Workbench navigation",
    );
    await page.evaluate(async () => {
      game.user = { id: "secondary-gm", isGM: true, role: 4, active: true };
      journey.state.failSave = true;
      journey.state.writes = 0;
      journey.state.routeOpens = [];
      journey.app.rendered = true;
      journey.app._gmWorkbenchSwitching = false;
      journey.app.element.hidden = false;
      document.getElementById("notices").textContent = "";
      await journey.app.render();
      await journey.MerchantWorkspaceApp._editors.get("b").render();
    });
    assert.equal(
      await page
        .locator('#infinity-merchant-b input[name="name"]')
        .isDisabled(),
      true,
    );
    await directory.locator('[data-workbench-route="injuries"]').click();
    await page.waitForFunction(() => !journey.app._gmWorkbenchNavigating);
    assert.deepEqual(await page.evaluate(() => journey.state.routeOpens), [
      "injuries",
    ]);
    assert.equal(await page.evaluate(() => journey.state.writes), 0);
    assert.deepEqual(errors, []);
    assert.equal(
      await page.evaluate(() => journey.state.actionError ?? ""),
      "",
    );
    await page.evaluate(async () => {
      for (const editor of journey.MerchantWorkspaceApp._editors.values())
        await editor.close();
    });
    await auditFactionNavigation(page);
    await auditPlayerRequests(page, width, out);
    assert.deepEqual(errors, []);
    await page.close();
    console.log(
      `Workbench functional journey passed at ${width}px: independent editors, failed save, draft recovery, filter retry, closed confirmation, failed route, persistent editor, read-only navigation, unchanged factions, faction draft retry.`,
    );
  }
  console.log(`Workbench journey evidence: ${out}`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
