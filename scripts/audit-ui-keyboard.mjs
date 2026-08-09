import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

import { chromium } from "playwright";

import { buildUiHarnessDocument } from "./ui-harness.mjs";

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

    await openFixture(page, harnessUrl, "critical-injury-hud");
    await auditEscapeJourney(page);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }

  process.stdout.write("keyboard UI journeys passed\n");
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
