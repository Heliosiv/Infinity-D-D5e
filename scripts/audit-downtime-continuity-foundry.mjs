/** Writes synthetic data only in the disposable localhost downtime-gauntlet world. */
import {
  runDailyLivingNative,
  verifyDailyLivingReload,
  verifyCalendarAndLivingFailures,
} from "./audit-daily-living-foundry.mjs";
import { runResearchNative } from "./audit-research-continuity-foundry.mjs";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { unlockTestVault } from "./test-utils/foundry-vault.mjs";
if (!process.argv.includes("--test-world=downtime-gauntlet"))
  throw Error("Explicit disposable test world required");
const base = "http://127.0.0.1:32173";
const browser = await chromium.launch({ headless: true });
const wire = [];
const watchdog = setTimeout(() => {
  console.error("Native continuity timed out");
  void browser.close();
}, 600000);
const evidence = {
  world: "downtime-gauntlet",
  checks: [],
  completed: false,
  at: new Date().toISOString(),
};
async function join(name, unlock = true) {
  console.log("Joining", name);
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem("core.noCanvas", "true"));
  if (name === "Gauntlet Player")
    page.on("websocket", (ws) =>
      ws.on("framereceived", (e) => wire.push(String(e.payload))),
    );
  await page.goto(base + "/join");
  await page.locator('[name="userid"]').selectOption({ label: name });
  await page.locator('[name="join"]').click();
  await page.waitForFunction(() => globalThis.game?.ready, null, {
    timeout: 45000,
  });
  assert.equal(await page.evaluate(() => game.world.id), "downtime-gauntlet");
  assert.equal(
    await page.evaluate(() => game.settings.get("core", "noCanvas")),
    true,
  );
  console.log("Joined", name);
  if (unlock) {
    await unlockTestVault(page);
    const pending = page
      .locator(".infinity-dialog")
      .filter({ has: page.locator(".daily-supplies-dialog") });
    await pending.waitFor({ state: "visible", timeout: 2000 }).catch(() => {});
    if (await pending.count()) {
      await pending.locator('button[data-action="no"]').click();
      await pending.waitFor({ state: "hidden" });
      await page.waitForFunction(async () => {
        const s =
          await import("/modules/infinity-dnd5e/scripts/resource/store.js");
        const w =
          await import("/modules/infinity-dnd5e/scripts/resource/calendar-watcher.js");
        return (
          s.loadRunState().lastSeenDay === w.manualUpkeepPeriod().calendarDay
        );
      });
    }
  }
  console.log("Ready", name);
  return page;
}
try {
  if (process.argv.includes("--research-only")) {
    const gm = await join("Gamemaster", false);
    const locked = await gm.evaluate(async () => {
      try {
        (
          await import("/modules/infinity-dnd5e/scripts/downtime/private-records.js")
        ).readPrivateDowntimeFamily("hunting");
        return false;
      } catch {
        return true;
      }
    });
    assert.equal(locked, true, "private family reads require vault unlock");
    await unlockTestVault(gm);
    await gm.evaluate(async () => {
      const p =
        await import("/modules/infinity-dnd5e/scripts/private-state.js");
      await p.setPrivateStates({
        downtimeWorkflow: {},
        downtimeWorkflowCheckpoint: {},
      });
    });
    await gm.reload();
    await gm.waitForFunction(() => globalThis.game?.ready);
    await unlockTestVault(gm);
    const player = await join("Gauntlet Player", false);
    await runResearchNative(gm, player);
    assert.ok(wire.length > 0);
    assert.doesNotMatch(
      wire.join("\n"),
      /Native GM-only followup canary|native-migration-secret-canary/,
    );
    evidence.checks.push(
      "Locked private-family read denied; native import preserved original; Research question approved and delivered to authenticated player without secret canaries",
    );
    evidence.completed = true;
    console.log(JSON.stringify(evidence, null, 2));
  } else {
    const gm = await join("Gamemaster");
    await gm.evaluate(async () => {
      if (!game.users.find((u) => u.name === "Continuity GM"))
        await User.create({ name: "Continuity GM", role: 4, password: "" });
    });
    const player = await join("Gauntlet Player", false);

    // Capture initial document material as well as subsequent socket traffic.
    console.log("Writing frozen records");
    const secrets = await gm.evaluate(async () => {
      const h =
        await import("/modules/infinity-dnd5e/scripts/downtime/hunting-store.js");
      const r =
        await import("/modules/infinity-dnd5e/scripts/downtime/research-store.js");
      const rules =
        await import("/modules/infinity-dnd5e/scripts/downtime/hunting.js");
      const id = "continuity-" + Date.now();
      const region = {
        ...rules.defaultHuntingRegions()[0],
        id,
        name: "Native hidden area canary",
      };
      await h.saveHuntingRegion(region);
      await h.saveHuntingBlock(id, region);
      await r.saveResearchSeed({
        id,
        title: "Native unrevealed seed canary",
        discoverable: false,
        playerKnown: false,
      });
      await r.saveResearchBlock(id, { timeOfDay: "night" });
      await r.saveResearchCase(id, "fixture-actor", {
        queueKey: "frozen-native-queue",
        dc: 19,
        subject: "Native confidential case canary",
        approved: false,
      });
      return {
        id,
        hunt: h.loadHuntingBlock(id),
        research: r.loadResearchBlock(id),
      };
    });
    evidence.checks.push(
      "Real encrypted write/read-back for hunting rules, seed and pending Research case",
    );
    const raw = await player.evaluate(() =>
      JSON.stringify({
        journal: game.journal.toJSON(),
        settings: game.settings.storage.get("world").toJSON(),
      }),
    );
    assert.doesNotMatch(
      raw,
      /Native hidden area canary|Native unrevealed seed canary|Native confidential case canary|frozen-native-queue|Native GM-only followup canary|native-migration-secret-canary/,
    );
    assert.ok(!raw.includes(secrets.hunt.seed));
    await gm.reload();
    await gm.waitForFunction(() => globalThis.game?.ready);
    const locked = await gm.evaluate(async () => {
      try {
        (
          await import("/modules/infinity-dnd5e/scripts/downtime/private-records.js")
        ).readPrivateDowntimeFamily("hunting");
        return false;
      } catch {
        return true;
      }
    });
    assert.equal(locked, true);
    await unlockTestVault(gm);
    const read = async (page) =>
      page.evaluate(
        async (id) => ({
          hunt: (
            await import("/modules/infinity-dnd5e/scripts/downtime/hunting-store.js")
          ).loadHuntingBlock(id),
          research: (
            await import("/modules/infinity-dnd5e/scripts/downtime/research-store.js")
          ).loadResearchBlock(id),
        }),
        secrets.id,
      );
    assert.deepEqual(await read(gm), {
      hunt: secrets.hunt,
      research: secrets.research,
    });
    evidence.checks.push(
      "Locked reload fails closed; unlock restores exact frozen records",
    );
    const living = await runDailyLivingNative(gm);
    evidence.checks.push(
      "Mixed native daily living: supplies OR lifestyle OR covered; duplicate day refused",
    );
    await gm.context().close();
    const gm2 = await join("Continuity GM");
    assert.deepEqual(await read(gm2), {
      hunt: secrets.hunt,
      research: secrets.research,
    });
    await gm2.waitForFunction(() => game.users.activeGM?.id === game.user.id);
    await gm2.evaluate(async (id) => {
      const r =
        await import("/modules/infinity-dnd5e/scripts/downtime/research-store.js");
      await r.saveResearchCase(id, "fixture-actor", {
        ...r.loadResearchCase(id, "fixture-actor"),
        approved: true,
      });
    }, secrets.id);
    await verifyDailyLivingReload(gm2, living);
    evidence.checks.push(
      "Replacement GM cannot charge the same living date; stale skip refused and current skip accepted",
    );
    evidence.checks.push(
      "Separate full GM browser unlocks and continues the same pending case",
    );
    await verifyCalendarAndLivingFailures(gm2, living);
    evidence.checks.push(
      "Paused month and large-jump GM prompt/skip preserve balances; insufficient funds stay unresolved; a persisted lost Actor reply charges once",
    );
    await runResearchNative(gm2, player);
    evidence.checks.push(
      "Native browser import preserves source; Research question reaches GM approval and completed player receipt",
    );
    assert.ok(wire.length > 0, "real player socket frames captured");
    assert.doesNotMatch(
      wire.join("\n"),
      /Native hidden area canary|Native unrevealed seed canary|Native confidential case canary|frozen-native-queue|Native GM-only followup canary|native-migration-secret-canary/,
    );
    const playerRaw = await player.evaluate(() =>
      JSON.stringify(game.journal.toJSON()),
    );
    assert.doesNotMatch(
      playerRaw,
      /Native hidden area canary|Native unrevealed seed canary|Native confidential case canary/,
    );
    evidence.checks.push(
      "Authenticated player initial documents and observed socket frames contain no secret canaries",
    );
    evidence.completed = true;
    console.log(JSON.stringify(evidence, null, 2));
  }
} finally {
  clearTimeout(watchdog);
  await browser.close();
  mkdirSync("output/playwright/continuity", { recursive: true });
  writeFileSync(
    process.argv.includes("--research-only")
      ? "output/playwright/continuity/native-research.json"
      : "output/playwright/continuity/native.json",
    JSON.stringify(evidence, null, 2),
  );
}
