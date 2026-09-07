import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { buildUiHarnessDocument } from "./ui-harness.mjs";
const root = process.cwd();
const pixiIndex = process.argv.indexOf("--pixi");
if (pixiIndex < 0 || !process.argv[pixiIndex + 1])
  throw new Error(
    "Supply a local PIXI 7 browser bundle with --pixi <path>. This audit writes only local test fixtures.",
  );
const pixiBundle = readFileSync(path.resolve(process.argv[pixiIndex + 1]));
const server = createServer((req, res) => {
  const p = new URL(req.url, "http://localhost").pathname;
  if (p === "/") {
    res.setHeader("content-type", "text/html");
    res.end(buildUiHarnessDocument());
    return;
  }
  if (p === "/pixi-fixture.js") {
    res.setHeader("content-type", "text/javascript");
    res.end(pixiBundle);
    return;
  }
  if (!p.startsWith("/scripts/") || !p.endsWith(".js")) {
    res.writeHead(404).end();
    return;
  }
  const file = path.resolve(root, "." + decodeURIComponent(p));
  if (!file.startsWith(root + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    res.setHeader(
      "content-type",
      p.endsWith(".js") ? "text/javascript" : "text/plain",
    );
    res.end(readFileSync(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 950 } });
const out = path.resolve("output/playwright/injury-ui");
mkdirSync(out, { recursive: true });
try {
  await page.goto(url);
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("[data-harness-section]"))
      el.hidden = el.dataset.harnessSection !== "critical-injury-triage";
  });
  await page.screenshot({
    path: path.join(out, "party-board.png"),
    fullPage: false,
  });
  await page.evaluate(async () => {
    window.foundry = {
      applications: {
        api: {
          ApplicationV2: class {},
          HandlebarsApplicationMixin: (Base) => Base,
        },
      },
    };
    const gm = { id: "gm", role: 4, isGM: true, active: true };
    const player = { id: "player", role: 1, character: "actor-bryn" };
    window.game = {
      user: gm,
      users: { contents: [gm, player], activeGM: gm },
      settings: { get: () => true },
      actors: { get: () => null },
    };
    const { CriticalInjuryTriageApp } =
      await import("/scripts/injury/injury-triage-app.js");
    const { CriticalInjuryApp } = await import("/scripts/injury/injury-app.js");
    CriticalInjuryApp.open = (options) => {
      window.openedCharacter = options.actorId;
    };
    const root = document.querySelector(
      '[data-harness-window="critical-injury-triage"]',
    );
    const log = document.querySelector(
      '[data-harness-window="critical-injury-log"]',
    );
    const views = { triage: root.innerHTML, history: log.innerHTML };
    const app = {
      element: root,
      _search: "",
      _view: "triage",
      _manualOpen: false,
      _manualOwnersByActor: new Map([
        ["actor-aric", new Set(["player-aric"])],
        ["actor-bryn", new Set(["player-bryn"])],
      ]),
    };
    app._wireManualRecipient =
      CriticalInjuryTriageApp.prototype._wireManualRecipient;
    app._filterRows = CriticalInjuryTriageApp.prototype._filterRows;
    app.render = () => {
      root.innerHTML = views[app._view];
      CriticalInjuryTriageApp.prototype._onRender.call(app, {}, {});
    };
    root.addEventListener("click", (event) => {
      const target = event.target.closest("[data-action]");
      if (!target) return;
      const fn = {
        showView: CriticalInjuryTriageApp._onShowView,
        startManualReview: CriticalInjuryTriageApp._onStartManualReview,
        openCharacter: CriticalInjuryTriageApp._onOpenCharacter,
      }[target.dataset.action];
      fn?.call(app, event, target);
    });
    CriticalInjuryTriageApp.prototype._onRender.call(app, {}, {});
  });
  const board = page.locator('[data-harness-window="critical-injury-triage"]');
  await board.getByRole("searchbox").fill("Bryn");
  assert.equal(await board.locator(".ci-triage-party-card:visible").count(), 1);
  await board
    .getByRole("button", { name: "View injuries for Bryn", exact: true })
    .click();
  assert.equal(await page.evaluate(() => window.openedCharacter), "actor-bryn");
  await board.getByRole("searchbox").fill("no matching wound");
  assert.equal(
    await board.locator('[data-role="injury-no-matches"]').isVisible(),
    true,
  );
  await board.getByRole("button", { name: /Injury log/ }).click();
  assert.equal(await board.locator(".ci-triage-log-row").count(), 2);
  await board.getByRole("searchbox").fill("concussion");
  assert.equal(await board.locator(".ci-triage-log-row:visible").count(), 1);
  await board.getByRole("searchbox").fill("");
  await page.screenshot({ path: path.join(out, "injury-log.png") });
  await board.getByRole("button", { name: "Party & rolls" }).click();
  await board
    .getByRole("button", { name: "New injury roll", exact: true })
    .click();
  assert.equal(
    await board
      .locator('[name="actorId"]')
      .evaluate((element) => element === document.activeElement),
    true,
    "New injury roll opens and focuses manual review directly",
  );
  await board.locator('[name="actorId"]').selectOption("actor-bryn");
  assert.equal(
    await board.locator('[name="targetUserId"]').inputValue(),
    "player-bryn",
  );
  await page.addScriptTag({ url: url + "/pixi-fixture.js" });
  await page.evaluate(async () => {
    document.body.innerHTML =
      '<h1 style="color:#eee;font:24px Arial;margin:24px">Injury token badge · canvas fixture</h1>';
    document.body.style.background = "#161b22";
    const app = new PIXI.Application({
      width: 700,
      height: 420,
      backgroundColor: 0x202936,
      antialias: true,
    });
    document.body.append(app.view);
    window.pixiApp = app;
    const token = new PIXI.Container();
    token.position.set(250, 120);
    token.w = 120;
    token.h = 120;
    token.interactiveChildren = false;
    token.eventMode = "static";
    token.hitArea = new PIXI.Rectangle(0, 0, 120, 120);
    token.document = { actorLink: true };
    token.actor = {
      id: "actor-bryn",
      type: "character",
      name: "Bryn",
      ownership: { player: 3 },
      effects: {
        contents: [
          {
            flags: {
              "infinity-dnd5e": {
                criticalInjury: { id: "injury", injuryName: "Shattered Knee" },
              },
            },
          },
        ],
      },
    };
    token.addChild(
      new PIXI.Graphics()
        .beginFill(0x526d83)
        .lineStyle(3, 0xc3b786)
        .drawCircle(60, 60, 58)
        .endFill(),
    );
    token
      .addChild(
        new PIXI.Text("Bryn", {
          fill: 0xffffff,
          fontFamily: "Arial",
          fontSize: 22,
        }),
      )
      .position.set(35, 43);
    app.stage.addChild(token);
    window.fixtureToken = token;
    window.badgeModule = await import("/scripts/injury/token-badge.js");
    badgeModule.refreshTokenInjuryBadge(token);
    window.openedCharacter = null;
  });
  const pos = await page.evaluate(() => {
    const badge = fixtureToken.children.find(
      (c) => c.name === "infinity-injury-badge",
    );
    const p = badge.toGlobal(new PIXI.Point(20, 15));
    const box = pixiApp.view.getBoundingClientRect();
    return { x: box.x + p.x, y: box.y + p.y };
  });
  await page.mouse.click(pos.x, pos.y);
  assert.equal(
    await page.evaluate(() => window.openedCharacter),
    "actor-bryn",
    "real PIXI pointer event opens injuries",
  );
  await page.screenshot({ path: path.join(out, "token-badge.png") });
  await page.evaluate(() => {
    fixtureToken.actor.effects.contents = [];
    badgeModule.refreshTokenInjuryBadge(fixtureToken);
  });
  assert.equal(
    await page.evaluate(() => fixtureToken.interactiveChildren),
    false,
    "original token child interaction is restored",
  );
  console.log(
    "Browser journeys passed: party search, no matches, injury log switching/search, character click, owner selection, real PIXI badge click and cleanup.",
  );
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
