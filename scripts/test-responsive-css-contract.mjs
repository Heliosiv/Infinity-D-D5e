import assert from "node:assert/strict";

import { chromium } from "playwright";

import { buildUiHarnessDocument } from "./ui-harness.mjs";

const FEATURE_CONTAINERS = Object.freeze({
  "critical-injury": "critical-injury",
  "downtime-activities-available": "downtime-player",
  "downtime-workspace-empty": "downtime-workspace",
  "reputation-workspace": "reputation-workspace",
});

const browser = await chromium.launch({ headless: true });

try {
  const fineContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const finePage = await fineContext.newPage();
  await finePage.setContent(buildUiHarnessDocument(), { waitUntil: "load" });
  await applyScenario(finePage, { width: 380, density: "compact" });

  for (const [fixture, expectedName] of Object.entries(FEATURE_CONTAINERS)) {
    const names = (await containerName(finePage, fixture)).split(/\s+/);
    assert.ok(
      names.includes(expectedName),
      `${fixture} keeps its feature container name`,
    );
  }
  assert.equal(
    await controlSize(finePage, "merchant-workspace"),
    "32px",
    "fine-pointer compact density remains compact",
  );
  assert.equal(
    await horizontalOverflow(finePage, "dashboard", ".id-home-content"),
    false,
    "narrow player launcher has no horizontal overflow",
  );

  await applyScenario(finePage, { width: 380, density: "comfortable" });
  const inventoryButtonWidths = await finePage
    .locator(
      '[data-harness-window="merchant-workspace"] .mw-inv__row > .mw-btn--icon',
    )
    .evaluateAll((buttons) =>
      buttons.map((button) => button.getBoundingClientRect().width),
    );
  assert.ok(
    inventoryButtonWidths.length > 0,
    "inventory fixture has icon actions",
  );
  assert.ok(
    inventoryButtonWidths.every((width) => width >= 44),
    "narrow comfortable inventory icon actions remain at least 44px wide",
  );

  await applyScenario(finePage, { width: 720, density: "comfortable" });
  for (const [fixture, selector] of [
    ["merchant-workspace", ".mw-section-nav"],
    ["merchant-workspace", ".mw-editor-status"],
    ["reputation-workspace", ".rw-section-nav"],
    ["reputation-workspace", ".rw-form__foot"],
  ]) {
    assert.equal(
      await computedProperty(finePage, fixture, selector, "position"),
      "static",
      `${fixture} lets ${selector} scroll in the stacked layout`,
    );
  }
  await fineContext.close();

  const coarseContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    hasTouch: true,
    isMobile: true,
  });
  const coarsePage = await coarseContext.newPage();
  await coarsePage.setContent(buildUiHarnessDocument(), { waitUntil: "load" });
  await applyScenario(coarsePage, { width: 380, density: "compact" });
  assert.equal(
    await controlSize(coarsePage, "merchant-workspace"),
    "44px",
    "coarse pointers restore compact density to 44px controls",
  );
  await coarseContext.close();
} finally {
  await browser.close();
}

process.stdout.write("responsive CSS cascade validation passed\n");

async function applyScenario(page, { width, density }) {
  await page.evaluate(
    ({ width, density }) => {
      for (const root of document.querySelectorAll("[data-harness-window]")) {
        root.style.setProperty("--harness-width", `${width}px`);
        root.dataset.infinityDensity = density;
        root.classList.toggle(
          "infinity-density--comfortable",
          density === "comfortable",
        );
        root.classList.toggle(
          "infinity-density--compact",
          density === "compact",
        );
      }
    },
    { width, density },
  );
}

async function containerName(page, fixture) {
  return page
    .locator(`[data-harness-window="${fixture}"]`)
    .evaluate((root) => getComputedStyle(root).containerName);
}

async function controlSize(page, fixture) {
  return page
    .locator(`[data-harness-window="${fixture}"]`)
    .evaluate((root) =>
      getComputedStyle(root).getPropertyValue("--lf-control-size").trim(),
    );
}

async function computedProperty(page, fixture, selector, property) {
  return page
    .locator(`[data-harness-window="${fixture}"] ${selector}`)
    .evaluate(
      (element, propertyName) => getComputedStyle(element)[propertyName],
      property,
    );
}

async function horizontalOverflow(page, fixture, selector) {
  return page
    .locator(`[data-harness-window="${fixture}"] ${selector}`)
    .evaluate((element) => element.scrollWidth > element.clientWidth + 2);
}
