import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { buildUiHarnessDocument } from "./ui-harness.mjs";
import {
  MERCHANT_EDITOR_TABS,
  merchantTabContext,
} from "./merchant/editor-tabs.js";

const gm = { id: "gm", role: 4, isGM: true, active: true };
const users = [gm];
users.activeGM = gm;
users.get = (id) => users.find((user) => user.id === id);
const settings = new Map([["soundsEnabled", false]]);
globalThis.CONST = { USER_ROLES: { GAMEMASTER: 4 } };
globalThis.game = {
  ready: false,
  user: gm,
  users,
  actors: [],
  settings: {
    get: (_module, key) => settings.get(key),
    set: async (_module, key, value) => settings.set(key, value),
  },
};
globalThis.ui = { notifications: { warn() {}, info() {}, error() {} } };
globalThis.foundry = {
  applications: {
    api: {
      ApplicationV2: class {
        constructor(options) {
          this.options = options;
        }
        render() {
          this.rendered = true;
          this.renders = (this.renders ?? 0) + 1;
          return this;
        }
        bringToFront() {
          this.focused = true;
        }
        async close() {
          this.rendered = false;
          this._onClose?.({});
        }
      },
      HandlebarsApplicationMixin: (Base) =>
        class extends Base {
          _configureRenderParts() {
            return this.constructor.PARTS;
          }
        },
    },
  },
  utils: { deepClone: structuredClone },
};
const { MerchantWorkspaceApp } = await import("./merchant-workspace.js");
const { normalizeMerchant } = await import("./merchant/store.js");
settings.set("merchants", [
  normalizeMerchant({ id: "a", name: "Alchemist" }),
  normalizeMerchant({ id: "b", name: "Blacksmith" }),
]);

const directory = MerchantWorkspaceApp.open();
const first = await MerchantWorkspaceApp._onSelectMerchant.call(
  directory,
  null,
  {
    dataset: { merchantId: "a" },
  },
);
const second = MerchantWorkspaceApp.openMerchant("b");
assert.deepEqual(
  Object.keys(first._configureRenderParts({})),
  ["body"],
  "focused windows never render an empty Workbench template part",
);
assert.deepEqual(
  Object.keys(directory._configureRenderParts({})),
  ["workbench", "body"],
  "editor part filtering does not mutate the directory parts",
);
assert.notEqual(first, second, "merchants have independent windows");
assert.equal(
  first._standaloneWindow,
  true,
  "editor does not become the active Workbench route",
);
first._activeMerchantTab = "stock";
assert.equal(MerchantWorkspaceApp.openMerchant("a"), first);
assert.equal(first.renders, 1, "reopening focuses without discarding the form");
assert.equal(first._activeMerchantTab, "stock");
const context = await first._prepareContext();
assert.equal(context.workbench, null);
assert.equal(context.selected.id, "a");
assert.equal(context.merchantPanels.stock.active, true);
settings.set("merchants", [normalizeMerchant({ id: "b", name: "Blacksmith" })]);
assert.equal(
  (await first._prepareContext()).selected,
  null,
  "deleted merchants never fall through to another record",
);
assert.equal(first._selectedId, "a");
await first.close();
assert.equal(MerchantWorkspaceApp._editors.has("a"), false);
assert.equal(
  MerchantWorkspaceApp._instance,
  directory,
  "closing an editor preserves the directory singleton",
);
gm.role = 3;
assert.equal(
  MerchantWorkspaceApp.openMerchant("b"),
  null,
  "Assistant GMs cannot open private editors",
);
gm.role = 4;
await second.close();
await directory.close();

const browser = await chromium.launch({ headless: true });
try {
  const browserContext = await browser.newContext({
    viewport: { width: 1100, height: 760 },
  });
  const page = await browserContext.newPage();
  await page.setContent(buildUiHarnessDocument());
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(readFileSync("scripts/merchant/editor-tabs.js", "utf8")).toString("base64")}`;
  await page.evaluate(
    async ({ moduleUrl, searchMethod }) => {
      const { selectMerchantTab, bindMerchantTabKeys } = await import(
        moduleUrl
      );
      for (const root of document.querySelectorAll("[data-harness-window]")) {
        const select = (key) => selectMerchantTab(root, key);
        root.addEventListener("click", (event) => {
          const tab = event.target.closest("[data-merchant-tab]");
          if (tab) select(tab.dataset.merchantTab);
        });
        bindMerchantTabKeys(root, select);
      }
      const root = document.querySelector(
        '[data-harness-window="merchant-workspace"]',
      );
      const wireSearch = new Function(
        `return ({${searchMethod}})._wireMerchantSearch`,
      )();
      wireSearch.call({ element: root, _merchantSearch: "" });
    },
    {
      moduleUrl,
      searchMethod:
        MerchantWorkspaceApp.prototype._wireMerchantSearch.toString(),
    },
  );
  const directoryRoot = page.locator(
    '[data-harness-window="merchant-workspace"]',
  );
  assert.equal(
    await directoryRoot.locator('[data-form="merchant-edit"]').count(),
    0,
  );
  await directoryRoot
    .locator("[data-merchant-search]")
    .fill("no such merchant");
  assert.equal(await directoryRoot.locator(".mw-list__row:visible").count(), 0);
  assert.equal(
    await directoryRoot.locator("[data-merchant-no-match]").isVisible(),
    true,
  );
  await directoryRoot.locator("[data-merchant-search]").fill("Yannick");
  assert.equal(await directoryRoot.locator(".mw-list__row:visible").count(), 1);

  const root = page.locator('[data-harness-window="merchant-editor-basics"]');
  assert.equal(await root.locator(".gmw-chrome").count(), 0);
  await root.locator('[name="name"]').fill("New name still in the form");
  const before = await root
    .locator("form")
    .evaluate((form) => [...new FormData(form)]);
  for (const width of [820, 720, 520, 380]) {
    await root.evaluate((element, width) => {
      element.style.setProperty("--harness-width", `${width}px`);
      element.style.setProperty("--harness-height", "560px");
    }, width);
    for (const [key] of MERCHANT_EDITOR_TABS) {
      await root.locator(`[data-merchant-tab="${key}"]`).click();
      assert.equal(await root.locator('[role="tabpanel"]:visible').count(), 1);
      assert.equal(
        await root.locator(`[data-merchant-panel="${key}"]`).isVisible(),
        true,
      );
      assert.equal(
        await root.evaluate(
          (element) => element.scrollWidth <= element.clientWidth + 1,
        ),
        true,
        `${key} fits ${width}px`,
      );
      if (width === 820) {
        const results = await new AxeBuilder({ page })
          .include('[data-harness-window="merchant-editor-basics"]')
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
          .analyze();
        assert.deepEqual(
          results.violations,
          [],
          `${key} passes accessibility checks`,
        );
      }
    }
  }
  assert.deepEqual(
    await root.locator("form").evaluate((form) => [...new FormData(form)]),
    before,
    "switching tabs preserves all controls, including hidden checkboxes and settings",
  );
  await root.locator('[data-merchant-tab="advanced"]').focus();
  await page.keyboard.press("Home");
  assert.equal(
    await root
      .locator('[data-merchant-tab="basics"]')
      .getAttribute("aria-selected"),
    "true",
  );
  await page.keyboard.press("ArrowRight");
  assert.equal(
    await root.locator('[data-merchant-panel="stock"]').isVisible(),
    true,
  );
  await page.keyboard.press("End");
  assert.equal(
    await root.locator('[data-merchant-panel="advanced"]').isVisible(),
    true,
  );
  const one = merchantTabContext("one"),
    two = merchantTabContext("two");
  assert.notEqual(one.merchantTabs[0].panelId, two.merchantTabs[0].panelId);
  mkdirSync("tmp/playwright", { recursive: true });
  await root.evaluate((element) =>
    element.style.setProperty("--harness-width", "820px"),
  );
  await root.locator('[data-merchant-tab="stock"]').click();
  await root.screenshot({
    path: "tmp/playwright/merchant-focused-inventory.png",
  });
  await directoryRoot.locator("[data-merchant-search]").fill("");
  await directoryRoot.screenshot({
    path: "tmp/playwright/merchant-directory.png",
  });
} finally {
  await browser.close();
}
console.log(
  "merchant directory, independent editor lifecycle, four tabs, keyboard, narrow layout, and form preservation passed",
);
