/** Browser gauntlet: real UI controllers and player adapter; isolated campaign doubles. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import Handlebars from "handlebars";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";

const root = path.resolve(".");
const out = path.resolve("output/playwright/hunting");
mkdirSync(out, { recursive: true });
const templates = Object.fromEntries(
  ["workspace", "activities"].map((name) => [
    name,
    Handlebars.compile(readFileSync(`templates/downtime-${name}.hbs`, "utf8")),
  ]),
);
const css = ["tokens", "ui-system", "downtime"]
  .map((name) => readFileSync(`styles/${name}.css`, "utf8"))
  .join("\n");
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  try {
    if (pathname === "/") {
      response.setHeader("content-type", "text/html");
      response.end(
        `<!doctype html><html lang="en"><head><title>Downtime gauntlet</title><style>${css}\nbody{margin:0;background:#182024;color:#eee;font-family:Arial}#app{height:900px;max-width:1040px;margin:auto}button,input,select,textarea{font:inherit}button{cursor:pointer}</style></head><body><div id="app"></div></body></html>`,
      );
    } else if (pathname === "/render" && request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const { name, context } = JSON.parse(body);
      response.end(templates[name](context));
    } else if (/^\/scripts\/[\w/-]+\.(?:js|mjs)$/.test(pathname)) {
      const filename = path.resolve(root, `.${pathname}`);
      if (!filename.startsWith(`${root}${path.sep}`))
        throw new Error("Invalid path");
      response.setHeader("content-type", "text/javascript");
      response.end(readFileSync(filename));
    } else {
      response.writeHead(404);
      response.end();
    }
  } catch (error) {
    response.writeHead(500);
    response.end(String(error.message));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1100, height: 1000 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);

  await page.evaluate(async () => {
    const fixture = await import("/scripts/ui-hunting-fixture.mjs");
    await fixture.mountHuntingJourney();
  });
  await page
    .getByLabel("Location preset", { exact: true })
    .selectOption("biome-forest");
  await page.evaluate(() => journey.app.rendering);
  await page
    .getByText("Hunting rules and custom area", { exact: true })
    .click();
  await page.getByLabel("Hunting area name", { exact: true }).fill("Old Marsh");
  await page.getByLabel("Base hunting Survival DC", { exact: true }).fill("10");
  await page
    .getByLabel("Hunting difficulty label", { exact: true })
    .fill("Easy game");
  await page
    .locator('[name="huntingActivityIds"][value="guided-research"]')
    .check();
  await page
    .getByRole("button", { name: "Save area and activities", exact: true })
    .click();
  await page.waitForFunction(() =>
    document
      .querySelector('[name="locationPresetId"]')
      .value.startsWith("custom-hunt-"),
  );
  assert.equal(
    await page
      .locator('[name="templateIds"][value="guided-research"]')
      .isEnabled(),
    true,
  );
  assert.equal(
    await page
      .getByLabel("Base hunting Survival DC", { exact: true })
      .inputValue(),
    "10",
  );
  for (const width of [1040, 720, 380]) {
    await page.setViewportSize({ width, height: 1000 });
    const details = page.getByText("Hunting rules and custom area", {
      exact: true,
    });
    if (!(await details.evaluate((e) => e.parentElement.open)))
      await details.click();
    await page.screenshot({
      path: path.join(out, "gm-hunting-" + width + ".png"),
      fullPage: true,
    });
    const a11y = await new AxeBuilder({ page })
      .include("#app")
      .disableRules(["color-contrast"])
      .analyze();
    assert.equal(
      a11y.violations.length,
      0,
      JSON.stringify(
        a11y.violations.map((v) => ({
          id: v.id,
          nodes: v.nodes.map((n) => n.target),
        })),
      ),
    );
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
      "GM hunting horizontal overflow",
    );
  }
  await page.setViewportSize({ width: 1040, height: 1000 });
  await page.locator('[name="hours"]').fill("8");
  for (const checkbox of await page
    .locator('[name="templateIds"]:enabled')
    .all())
    await checkbox.uncheck();
  await page.locator('[name="templateIds"][value="guided-hunting"]').check();
  await page.locator('[data-action="createBlock"]').click();
  await page.waitForFunction(() => journey.store.getActiveDowntimeBlock());
  await page.evaluate(() => journey.mount("activities"));
  const card = page.locator('[data-activity-id="guided-hunting"]');
  await card.locator('[name="hours"]').selectOption("8");
  assert.equal(await card.locator('[name="targetId"] option').count(), 1);
  await card
    .getByRole("button", { name: "Allocate Hunting", exact: true })
    .click();
  await page.evaluate(() => journey.app.rendering);
  await page.locator('[data-action="submitQueue"]').click();
  await page.waitForFunction(
    () =>
      journey.store.getActiveDowntimeBlock().participants[0].hunt?.stage ===
      "attack",
  );
  assert.equal(await page.evaluate(() => journey.state.survivalRolls), 1);
  await page.evaluate(() => journey.mount("activities", { freshPlayer: true }));
  assert.equal(
    await page
      .getByRole("button", { name: "Take hunting shot", exact: true })
      .isEnabled(),
    true,
  );
  assert.equal(
    await page.locator('[data-action="removeActivity"]').isEnabled(),
    false,
  );
  for (const width of [1040, 720, 380]) {
    await page.setViewportSize({ width, height: 1000 });
    const accessibility = await new AxeBuilder({ page })
      .include("#app")
      .disableRules(["color-contrast"])
      .analyze();
    assert.deepEqual(
      accessibility.violations.map((v) => v.id),
      [],
    );
    await page.screenshot({
      path: path.join(out, "player-hunting-" + width + ".png"),
      fullPage: true,
    });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
      "Player hunting horizontal overflow",
    );
  }
  await page
    .getByRole("button", { name: "Take hunting shot", exact: true })
    .click();
  await page.waitForFunction(
    () => journey.store.getActiveDowntimeBlock().participants[0].submitted,
  );
  assert.equal(await page.evaluate(() => journey.state.attackRolls), 1);
  assert.equal(
    await page.evaluate(
      () => journey.actor.items.get("arrows").system.quantity,
    ),
    5,
  );
  await page.evaluate(async () => {
    const id = journey.store.getActiveDowntimeBlock().id;
    await journey.service.prepareGuidedDowntimeParticipant({
      blockId: id,
      actorId: "mira",
    });
    await journey.service.applyActiveDowntimeBlock(id);
    await journey.mount("activities", { freshPlayer: true });
  });
  assert.equal(
    await page.evaluate(
      () => journey.actor.items.get("arrows").system.quantity,
    ),
    4,
  );
  assert.match(await page.locator("#app").innerText(), /secured/);
  await page.screenshot({
    path: path.join(out, "hunting-report.png"),
    fullPage: true,
  });
  assert.equal(await page.evaluate(() => journey.state.error ?? ""), "");
  assert.deepEqual(errors, []);
  console.log(
    "Hunting browser journey passed: custom area, actual services, equipment/time selection, Survival, refreshed shot prompt, attack, inventory and report at 1040/720/380px.",
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
