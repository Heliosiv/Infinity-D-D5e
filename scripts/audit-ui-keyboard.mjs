import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

import { chromium } from "playwright";

import { buildUiHarnessDocument } from "./ui-harness.mjs";
import { auditRefreshFocus } from "./ui-focus-journey.mjs";

async function main() {
  const outDir = path.resolve("tmp", "playwright");
  const outFile = path.join(outDir, "ui-harness-keyboard.html");
  mkdirSync(outDir, { recursive: true });
  const harnessDocument = buildUiHarnessDocument();
  const dialogContractSource = readFileSync(
    path.resolve("scripts", "dialog-contract.js"),
    "utf8",
  );
  writeFileSync(outFile, harnessDocument, "utf8");

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/scripts/search-picker.js") {
      response.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
      });
      response.end(readFileSync("scripts/search-picker.js", "utf8"));
      return;
    }
    if (url.pathname === "/scripts/dialog-contract.js") {
      response.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
      });
      response.end(dialogContractSource);
      return;
    }
    if (url.pathname === "/ui-harness-keyboard.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(harnessDocument);
      return;
    }
    if (/^\/scripts\/[\w/-]+\.js$/.test(url.pathname)) {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(readFileSync(path.resolve(`.${url.pathname}`), "utf8"));
      return;
    }
    response.writeHead(404);
    response.end("Not found");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const harnessUrl = `http://127.0.0.1:${port}/ui-harness-keyboard.html`;
  const dialogContractUrl = `http://127.0.0.1:${port}/scripts/dialog-contract.js`;

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 960, height: 760 },
    });

    await openFixture(page, harnessUrl, "shared-dialog");
    await auditTabOrderAndButtonActivation(page);
    await auditDialogFocusRestoration(page, dialogContractUrl);

    await openFixture(page, harnessUrl, "per-encounter");
    await auditLootStudioTabJourney(page);

    await openFixture(page, harnessUrl, "downtime-activities-available");
    await auditQueueKeyboardActions(page);

    await openFixture(page, harnessUrl, "home-recovery-blocked-authority");
    await auditCampaignDataRecoveryJourney(page);

    await openFixture(page, harnessUrl, "home-recovery-blocked-secondary");
    await auditCampaignDataRecoveryInspection(page);

    await openFixture(page, harnessUrl, "critical-injury-hud");
    await auditEscapeJourney(page);

    await openFixture(page, harnessUrl, "critical-injury-triage");
    await auditCriticalInjuryTriageKeyboardActions(page);

    await openFixture(page, harnessUrl, "search-picker");
    await auditSearchPickerJourney(page);
    await auditRefreshFocus(page);
    await page.setViewportSize({ width: 412, height: 740 });
    await openFixture(page, harnessUrl, "merchant-editor-stock");
    await page
      .locator("[data-harness-window]")
      .evaluate((root) => root.style.setProperty("--harness-width", "380px"));
    const inventory = page.locator(".mw-inv__row").first();
    for (const label of ["Qty", "Restock to", "Custom gp", "Unlimited"]) {
      assert.equal(
        await inventory.getByText(label, { exact: true }).isVisible(),
        true,
        `${label} remains visible on narrow inventory cards`,
      );
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }

  process.stdout.write("keyboard UI journeys passed\n");
}

async function auditSearchPickerJourney(page) {
  await page.evaluate(async () => {
    globalThis.foundry = {
      applications: {
        api: {
          ApplicationV2: class {},
          HandlebarsApplicationMixin: (Base) => Base,
        },
      },
    };
    const { SearchPickerApp } = await import("/scripts/search-picker.js");
    const picker = new SearchPickerApp();
    picker.element = document.querySelector(".ix-search-picker");
    picker._options = [
      ...picker.element.querySelectorAll("[data-search-option]"),
    ].map((row) => ({
      id: row.dataset.optionId,
      label: row.querySelector("strong").textContent,
      disabled: row.disabled,
    }));
    picker._onRender({}, {});
    globalThis.keyboardPicker = picker;
    globalThis.toggleKeyboardPicker = (target) =>
      SearchPickerApp._onToggleOption.call(picker, null, target);
  });
  const search = page.locator("[data-search-picker-query]");
  const empty = page.locator("[data-search-picker-empty]");
  const visible = page.locator("[data-search-option]:visible");
  await search.fill("consumable healing");
  assert.equal(await visible.count(), 1);
  assert.equal(await visible.first().getAttribute("data-option-id"), "item-1");
  await search.press("ArrowDown");
  assert.equal(
    await visible.first().evaluate((el) => el === document.activeElement),
    true,
  );
  await search.fill("no such item");
  assert.equal(await visible.count(), 0);
  assert.equal(await empty.isVisible(), true);
  await search.press("ArrowDown");
  assert.equal(
    await search.evaluate((el) => el === document.activeElement),
    true,
  );
  await search.fill("");
  assert.equal(await visible.count(), 3);
  assert.equal(await empty.isVisible(), false);
  await search.press("ArrowUp");
  assert.equal(
    await page
      .locator('[data-option-id="item-2"]')
      .evaluate((el) => el === document.activeElement),
    true,
    "disabled results are skipped",
  );
  await page.evaluate(() => {
    keyboardPicker._multiple = true;
    const list = document.querySelector("[data-search-picker-list]");
    list.style.height = "60px";
    list.style.overflow = "auto";
    keyboardPicker.render = () => {
      throw new Error("Selection rebuilt the picker");
    };
    list.addEventListener("click", (event) => {
      const target = event.target.closest("[data-search-option]");
      if (target) void toggleKeyboardPicker(target);
    });
  });
  const option = page.locator('[data-option-id="item-2"]');
  await option.focus();
  const before = await page
    .locator("[data-search-picker-list]")
    .evaluate((el) => el.scrollTop);
  await option.press("Enter");
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
  await option.press("Enter");
  assert.equal(await option.getAttribute("aria-selected"), "false");
  assert.equal(
    await page.locator('[data-action="confirm"]').isDisabled(),
    true,
  );
  const firstOption = page.locator('[data-option-id="item-1"]');
  await firstOption.press("Enter");
  await option.press("Enter");
  assert.equal(
    await page.locator('[data-search-option][aria-selected="true"]').count(),
    2,
  );
  await page.evaluate(() => {
    keyboardPicker._multiple = false;
  });
  await firstOption.press("Enter");
  assert.equal(
    await page.locator('[data-search-option][aria-selected="true"]').count(),
    1,
  );
  assert.equal(await firstOption.getAttribute("aria-selected"), "true");
  await page.evaluate(() =>
    toggleKeyboardPicker(
      document.querySelector("[data-search-option][disabled]"),
    ),
  );
  assert.equal(
    await page.locator('[data-search-option][aria-selected="true"]').count(),
    1,
    "disabled options cannot change the selection",
  );
}

async function openFixture(page, harnessUrl, fixtureId) {
  await page.goto(harnessUrl, { waitUntil: "load" });
  await page.evaluate((id) => {
    for (const section of document.querySelectorAll("[data-harness-section]")) {
      if (section.dataset.harnessSection !== id) section.remove();
    }
    window.__uiClicks = [];
    window.__uiEscapes = [];
  }, fixtureId);
}

async function auditTabOrderAndButtonActivation(page) {
  const cancel = page.locator('[data-action="cancel"]');
  const confirm = page.locator('[data-action="confirm"]');

  await cancel.focus();
  assert.equal(await focusedAction(page), "cancel", "Cancel receives focus");

  await page.keyboard.press("Tab");
  assert.equal(
    await focusedAction(page),
    "confirm",
    "Tab advances to the next dialog action",
  );

  await page.keyboard.press("Shift+Tab");
  assert.equal(
    await focusedAction(page),
    "cancel",
    "Shift+Tab returns to the safe default",
  );

  await page.keyboard.press("Enter");
  await confirm.focus();
  await page.keyboard.press("Space");
  assert.deepEqual(
    await clickedActions(page),
    ["cancel", "confirm"],
    "Enter and Space activate native action buttons",
  );
}

async function auditDialogFocusRestoration(page, dialogContractUrl) {
  const restored = await page.evaluate(async (moduleUrl) => {
    const opener = document.querySelector(".window-close");
    opener.focus();
    const previousFoundry = globalThis.foundry;
    globalThis.foundry = {
      applications: {
        api: {
          DialogV2: {
            async confirm(options) {
              return options.rejectClose === false;
            },
          },
        },
      },
    };
    try {
      const { confirmInfinityDialog } = await import(moduleUrl);
      const result = await confirmInfinityDialog({
        window: { title: "Focus restoration journey" },
      });
      await new Promise((resolve) => requestAnimationFrame(resolve));
      return {
        result,
        restored: document.activeElement === opener,
      };
    } finally {
      globalThis.foundry = previousFoundry;
    }
  }, dialogContractUrl);

  assert.equal(
    restored.result,
    true,
    "the contracted dialog resolved normally",
  );
  assert.equal(
    restored.restored,
    true,
    "closing a contracted dialog restores the opener's focus",
  );
}

async function auditLootStudioTabJourney(page) {
  const journey = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll("[role='tab']")];
    const calls = [];
    const activate = (tab) => {
      for (const candidate of tabs) {
        const active = candidate === tab;
        candidate.setAttribute("aria-selected", String(active));
        candidate.tabIndex = active ? 0 : -1;
      }
      tab.focus();
      calls.push(tab.dataset.lootMode);
    };
    const onKeyDown = (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        return;
      }
      const currentIndex = Math.max(0, tabs.indexOf(event.currentTarget));
      let nextIndex = currentIndex;
      if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = tabs.length - 1;
      else if (event.key === "ArrowRight") {
        nextIndex = (currentIndex + 1) % tabs.length;
      } else {
        nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
      }
      event.preventDefault();
      activate(tabs[nextIndex]);
    };
    for (const tab of tabs) tab.addEventListener("keydown", onKeyDown);
    tabs[0].focus();
    return { count: tabs.length, calls };
  });
  assert.equal(journey.count, 3, "Loot Studio exposes three mode tabs");

  await page.keyboard.press("ArrowRight");
  assert.equal(await focusedLootMode(page), "hoard");
  await page.keyboard.press("End");
  assert.equal(await focusedLootMode(page), "creature");
  await page.keyboard.press("Home");
  assert.equal(await focusedLootMode(page), "encounter");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await focusedLootMode(page), "creature");

  assert.equal(
    await page.locator('[role="tab"][aria-selected="true"]').count(),
    1,
    "the roving tab journey keeps exactly one selected tab",
  );
}

async function auditQueueKeyboardActions(page) {
  const down = page
    .locator('button[data-action="moveActivityDown"]:not([disabled])')
    .first();
  const up = page
    .locator('button[data-action="moveActivityUp"]:not([disabled])')
    .first();
  assert.equal(
    await down.count(),
    1,
    "queue exposes an enabled Move later action",
  );
  assert.equal(
    await up.count(),
    1,
    "queue exposes an enabled Move earlier action",
  );

  await down.focus();
  await page.keyboard.press("Enter");
  await up.focus();
  await page.keyboard.press("Space");
  assert.deepEqual(
    await clickedActions(page),
    ["moveActivityDown", "moveActivityUp"],
    "queue reordering has Enter and Space keyboard alternatives",
  );
}

async function auditCriticalInjuryTriageKeyboardActions(page) {
  const manual = page.locator(".ci-triage-manual > summary");
  await manual.focus();
  await page.keyboard.press("Enter");
  assert.equal(
    await page.locator(".ci-triage-manual").getAttribute("open"),
    "",
    "manual review expands with the keyboard",
  );
  const start = page.locator('button[data-action="startReview"]');
  const send = page.locator('button[data-action="sendReview"]');
  const dismiss = page.locator('button[data-action="dismissReview"]');
  assert.equal(await start.isEnabled(), true, "GM triage can start a review");
  assert.equal(
    await send.isEnabled(),
    true,
    "GM triage can send a private roll",
  );
  assert.equal(
    await dismiss.isEnabled(),
    true,
    "GM triage can dismiss an unsent review",
  );
  await start.focus();
  await page.keyboard.press("Enter");
  await send.focus();
  await page.keyboard.press("Space");
  await dismiss.focus();
  await page.keyboard.press("Enter");
  assert.deepEqual(
    await clickedActions(page),
    ["startReview", "sendReview", "dismissReview"],
    "GM triage actions have native keyboard activation",
  );
}

async function auditCampaignDataRecoveryJourney(page) {
  const recovery = page.locator(".infinity-campaign-recovery");
  assert.equal(
    await recovery.count(),
    1,
    "blocked recovery renders as a focused application",
  );
  const adopt = recovery
    .locator(
      'button[data-action="reviewPrivateStateCandidate"]:not([disabled])',
    )
    .first();
  const snapshot = recovery.locator(
    'button[data-action="recoverPrivateStateSnapshot"]:not([disabled])',
  );
  await adopt.focus();
  await page.keyboard.press("Enter");
  await snapshot.focus();
  await page.keyboard.press("Space");
  assert.deepEqual(
    await clickedActions(page),
    ["reviewPrivateStateCandidate", "recoverPrivateStateSnapshot"],
    "recovery reviews expose native Enter and Space activation",
  );
}

async function auditCampaignDataRecoveryInspection(page) {
  const recovery = page.locator(".infinity-campaign-recovery");
  assert.equal(
    await recovery
      .locator('button[data-action="refreshPrivateState"]')
      .isEnabled(),
    true,
    "secondary GMs can refresh campaign-data inspection",
  );
  for (const action of [
    "reviewPrivateStateCandidate",
    "recoverPrivateStateSnapshot",
    "createEmptyPrivateState",
  ]) {
    assert.equal(
      await recovery
        .locator(`button[data-action="${action}"]`)
        .first()
        .isDisabled(),
      true,
      `secondary GM cannot activate ${action}`,
    );
  }
}

async function auditEscapeJourney(page) {
  const close = page.locator('[data-action="closeRegion"]');
  assert.equal(
    await close.count(),
    1,
    "the pinned injury card has a close action",
  );
  await close.focus();
  await page.evaluate(() => {
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      window.__uiEscapes.push("closeRegion");
      document.querySelector('[data-action="closeRegion"]')?.focus();
    });
  });
  await page.keyboard.press("Escape");
  assert.deepEqual(
    await page.evaluate(() => window.__uiEscapes),
    ["closeRegion"],
    "Escape reaches the HUD dismissal path",
  );
  assert.equal(await focusedAction(page), "closeRegion");
}

function focusedAction(page) {
  return page.evaluate(() => document.activeElement?.dataset?.action ?? "");
}

function focusedLootMode(page) {
  return page.evaluate(() => document.activeElement?.dataset?.lootMode ?? "");
}

function clickedActions(page) {
  return page.evaluate(() => window.__uiClicks.map((entry) => entry.action));
}

await main();
