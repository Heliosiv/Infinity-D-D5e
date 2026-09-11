/** Native ApplicationV2 gauntlet restricted to the disposable localhost world. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

if (!process.argv.includes("--test-world=downtime-gauntlet"))
  throw new Error("Explicit --test-world=downtime-gauntlet is required.");
const output = path.resolve("output/playwright/native-ui");
mkdirSync(output, { recursive: true });
const version = JSON.parse(readFileSync("module.json", "utf8")).version;
const report = { version, scenarios: [] };
const browser = await chromium.launch({ headless: true });
let page;
async function join(name) {
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
  });
  const tab = await context.newPage();
  tab.setDefaultTimeout(20_000);
  await tab.goto("http://127.0.0.1:32173/join");
  await tab.locator('[name="userid"]').selectOption({ label: name });
  await tab.locator('[name="join"]').click();
  await tab.waitForFunction(() => globalThis.game?.ready);
  assert.deepEqual(
    await tab.evaluate(() => [
      game.world.id,
      game.modules.get("infinity-dnd5e").version,
    ]),
    ["downtime-gauntlet", version],
  );
  if (!(await tab.evaluate(() => game.settings.get("core", "noCanvas")))) {
    await tab.evaluate(async () => {
      await game.settings.set("core", "noCanvas", true);
    });
    await tab.reload();
    await tab.waitForFunction(() => globalThis.game?.ready);
  }
  return tab;
}
async function closeWindows(tab) {
  await tab.evaluate(async () => {
    for (const app of [...foundry.applications.instances.values()])
      if (app.element?.classList.contains("infinity-dnd5e")) await app.close();
  });
}
async function open(tab, method) {
  console.log(`Opening ${method}`);
  await closeWindows(tab);
  await tab.evaluate(async (method) => {
    const app = await game.modules.get("infinity-dnd5e").api[method]();
    if (!app?.render) throw Error(`${method} did not return an application`);
    globalThis.nativeUiApp = app;
  }, method);
  await tab.waitForFunction(() => globalThis.nativeUiApp?.element?.isConnected);
  return tab.evaluate(() => nativeUiApp.element.id);
}
async function sweep(tab, methods, role) {
  for (const viewport of [
    { width: 1920, height: 1080 },
    { width: 1366, height: 768 },
    { width: 1024, height: 600 },
    { width: 412, height: 740 },
  ]) {
    await tab.setViewportSize(viewport);
    for (const method of methods) {
      const id = await open(tab, method);
      await tab.locator(`[id="${id}"]`).waitFor();
      const geometry = await tab.evaluate(() => {
        const root = nativeUiApp.element;
        const box = root.getBoundingClientRect();
        return {
          left: box.left,
          top: box.top,
          right: box.right,
          bottom: box.bottom,
          width: root.clientWidth,
          contentWidth: root.scrollWidth,
          viewport: [innerWidth, innerHeight],
        };
      });
      assert.ok(
        geometry.left >= -1 &&
          geometry.top >= -1 &&
          geometry.right <= viewport.width + 1 &&
          geometry.bottom <= viewport.height + 1,
        `${role} ${method} window fits ${viewport.width}x${viewport.height}: ${JSON.stringify(geometry)}`,
      );
      assert.ok(
        geometry.contentWidth <= geometry.width + 1,
        `${method} has no root overflow`,
      );
      await tab.evaluate(async () => {
        await nativeUiApp.render(false);
      });
      assert.equal(
        await tab.locator(`[id="${id}"]`).count(),
        1,
        "refresh keeps one window",
      );
      if (viewport.width === 412)
        await tab
          .locator(`[id="${id}"]`)
          .screenshot({ path: path.join(output, `${role}-${method}.png`) });
      report.scenarios.push(
        `${role}: ${method} ${viewport.width}x${viewport.height}`,
      );
    }
  }
}
try {
  page = await join("Gamemaster");
  report.runtime = await page.evaluate(() => ({
    foundry: game.version,
    system: game.system.version,
    world: game.world.id,
    canvasDisabled: game.settings.get("core", "noCanvas"),
    activeModules: game.modules
      .filter((m) => m.active)
      .map((m) => ({ id: m.id, version: m.version })),
  }));
  await page.waitForFunction(
    () =>
      game.modules.get("infinity-dnd5e").api.getPrivateStateStatus().state ===
      "ready",
  );
  if (!process.argv.includes("--interactions-only"))
    await sweep(
      page,
      [
        "openHub",
        "openSettings",
        "openPerEncounterLoot",
        "openHoardLoot",
        "openPerCreatureLoot",
        "openMerchantWorkspace",
        "openMerchantPricing",
        "openResourceManager",
        "openDowntimeWorkspace",
        "openCriticalInjuryTriage",
        "openReputation",
      ],
      "gm",
    );
  await open(page, "openSettings");
  const number = page
    .locator('.infinity-settings input[type="number"]')
    .first();
  await number.fill("7");
  const settingsScroll = await page
    .locator(".infinity-settings .ix-settings")
    .evaluate((el) => el.scrollTop);
  await page.evaluate(async () => {
    await nativeUiApp.render(false);
  });
  assert.equal(
    await number.inputValue(),
    "7",
    "settings refresh preserves unsaved input",
  );
  assert.equal(
    await number.evaluate((el) => el === document.activeElement),
    true,
    "settings refresh preserves the focused control",
  );
  await page
    .locator('.infinity-settings [data-action="resetQuickStarts"]')
    .click();
  await page.waitForFunction(() =>
    document
      .querySelector("[data-settings-status]")
      ?.textContent.includes("Quick-start"),
  );
  assert.equal(
    await number.inputValue(),
    "7",
    "Restore guides preserves unsaved settings",
  );
  assert.equal(
    await page.locator('.infinity-settings [data-action="save"]').isEnabled(),
    true,
  );
  report.scenarios.push(
    "settings: refresh and Restore guides preserve unsaved input",
  );
  await closeWindows(page);
  await page.evaluate(async () => {
    const { SearchPickerApp } =
      await import("/modules/infinity-dnd5e/scripts/search-picker.js");
    globalThis.nativeUiApp = new SearchPickerApp({
      multiple: true,
      options: Array.from({ length: 80 }, (_, i) => ({
        id: `choice-${i}`,
        label: `Test choice ${i}`,
      })),
    });
    await nativeUiApp.render(true);
  });
  const option = page.locator('[data-option-id="choice-60"]');
  await option.focus();
  const before = await page
    .locator("[data-search-picker-list]")
    .evaluate((el) => el.scrollTop);
  for (let i = 0; i < 3; i++) await option.press("Enter");
  assert.equal(await option.getAttribute("aria-selected"), "true");
  assert.equal(
    await option.evaluate((el) => el === document.activeElement),
    true,
  );
  assert.equal(
    await page
      .locator("[data-search-picker-list]")
      .evaluate((el) => el.scrollTop),
    before,
  );
  report.scenarios.push(
    "native long picker: repeated selection preserves focus and scroll",
  );
  const player = await join("Gauntlet Player");
  if (!process.argv.includes("--interactions-only"))
    await sweep(
      player,
      [
        "openHub",
        "openSettings",
        "openShops",
        "openPartySupplies",
        "openDowntimeActivities",
        "openCriticalInjuries",
        "openReputationView",
      ],
      "player",
    );
  await player.reload();
  await player.waitForFunction(() => globalThis.game?.ready);
  await open(player, "openPartySupplies");
  report.scenarios.push("player reconnect: Party Supplies reopens");
  report.passed = true;
  console.log(`Native UI passed ${report.scenarios.length} scenarios.`);
} catch (error) {
  report.failure = error.stack;
  await page
    ?.screenshot({ path: path.join(output, "failure.png"), fullPage: true })
    .catch(() => {});
  throw error;
} finally {
  writeFileSync(
    path.join(output, "results.json"),
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
