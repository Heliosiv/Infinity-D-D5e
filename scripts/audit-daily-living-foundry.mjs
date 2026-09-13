/** Native daily-living acceptance helper; caller must guard the disposable world. */
import assert from "node:assert/strict";
export async function runDailyLivingNative(page) {
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(page.url()).hostname));
  assert.equal(await page.evaluate(() => game.world.id), "downtime-gauntlet");
  const result = await page.evaluate(async () => {
    const store =
      await import("/modules/infinity-dnd5e/scripts/resource/store.js");
    const watcher =
      await import("/modules/infinity-dnd5e/scripts/resource/calendar-watcher.js");
    await game.settings.set("infinity-dnd5e", "resourceAutoTrigger", false);
    const old = store.loadResourceConfig();
    const actors = [];
    for (const mode of ["supplies", "modest", "covered"])
      actors.push(
        await Actor.create({
          name: "Continuity " + mode,
          type: "character",
          system: { currency: { gp: 20 } },
          items: [{ name: "Rations", type: "loot", system: { quantity: 5 } }],
          ownership: { default: 0 },
        }),
      );
    const config = {
      ...old,
      dailyLiving: true,
      upkeepPaused: false,
      resources: [
        {
          id: "food",
          label: "Food",
          scope: "per-character",
          perDay: 1,
          forageYields: "food",
          matching: { nameKeywords: ["rations"] },
        },
      ],
      roster: actors.map((a, i) => ({
        actorId: a.id,
        consumes: true,
        living: ["supplies", "modest", "covered"][i],
        livingReason: i === 2 ? "Hosted by synthetic guild" : "",
      })),
    };
    await store.saveResourceConfig(config);
    const period = watcher.manualUpkeepPeriod();
    await store.saveRunState({
      ...store.loadRunState(),
      lastSeenDay: period.calendarDay - 1,
      lastUpkeepResult: null,
      activeUpkeep: null,
    });
    const first = await watcher.advanceDayNow({
      expectedPeriod: watcher.manualUpkeepPeriod(),
    });
    const snapshot = () =>
      actors.map((a) => ({
        gp: a.system.currency.gp,
        food: a.items.find((i) => i.name === "Rations").system.quantity,
      }));
    const charged = snapshot();
    const duplicate = await watcher.advanceDayNow();
    const unchanged = snapshot();
    return {
      actorIds: actors.map((a) => a.id),
      config,
      old,
      firstBlocked: first?.blocked ?? false,
      charged,
      duplicate,
      unchanged,
    };
  });
  assert.equal(result.firstBlocked, false);
  assert.deepEqual(result.charged, [
    { gp: 20, food: 4 },
    { gp: 19, food: 5 },
    { gp: 20, food: 5 },
  ]);
  assert.deepEqual(result.unchanged, result.charged);
  assert.equal(result.duplicate.reason, "day-already-recorded");
  return result;
}
export async function verifyDailyLivingReload(page, result) {
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(page.url()).hostname));
  assert.equal(await page.evaluate(() => game.world.id), "downtime-gauntlet");
  const after = await page.evaluate(async ({ actorIds, old }) => {
    const w =
      await import("/modules/infinity-dnd5e/scripts/resource/calendar-watcher.js");
    const s = await import("/modules/infinity-dnd5e/scripts/resource/store.js");
    const duplicate = await w.advanceDayNow();
    const balances = actorIds.map((id) => {
      const a = game.actors.get(id);
      return {
        gp: a.system.currency.gp,
        food: a.items.find((i) => i.name === "Rations").system.quantity,
      };
    });
    const stale = await w.skipUpkeepNow({
      expectedPeriod: { calendarDay: -999 },
    });
    const skipped = await w.skipUpkeepNow({
      expectedPeriod: w.manualUpkeepPeriod(),
    });
    await s.saveResourceConfig(old);
    return { duplicate, balances, stale, skipped };
  }, result);
  assert.equal(after.duplicate.reason, "day-already-recorded");
  assert.deepEqual(after.balances, result.charged);
  assert.equal(after.stale.blocked, true);
  assert.equal(after.skipped.skipped, true);
}

export async function verifyCalendarAndLivingFailures(page, result) {
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(page.url()).hostname));
  assert.equal(await page.evaluate(() => game.world.id), "downtime-gauntlet");
  const snapshot = () =>
    page.evaluate(
      (ids) =>
        ids.map((id) => {
          const a = game.actors.get(id);
          return {
            gp: a.system.currency.gp,
            food: a.items.find((i) => i.name === "Rations").system.quantity,
          };
        }),
      result.actorIds,
    );
  const waitBaseline = () =>
    page.waitForFunction(async () => {
      const s =
        await import("/modules/infinity-dnd5e/scripts/resource/store.js");
      const w =
        await import("/modules/infinity-dnd5e/scripts/resource/calendar-watcher.js");
      return (
        s.loadRunState().lastSeenDay === w.manualUpkeepPeriod().calendarDay
      );
    });
  await page.evaluate(async (config) => {
    const s = await import("/modules/infinity-dnd5e/scripts/resource/store.js");
    await s.saveResourceConfig({ ...config, upkeepPaused: true });
    await game.time.advance(30 * 86400);
  }, result.config);
  await waitBaseline();
  assert.deepEqual(
    await snapshot(),
    result.charged,
    "paused month charges nobody",
  );
  await page.evaluate(async (config) => {
    const s = await import("/modules/infinity-dnd5e/scripts/resource/store.js");
    await s.saveResourceConfig({
      ...config,
      upkeepPaused: false,
      maxCatchUpDays: 7,
    });
    await game.settings.set("infinity-dnd5e", "resourceAutoTrigger", true);
    await game.time.advance(30 * 86400);
  }, result.config);
  const dialog = page
    .locator(".infinity-dialog")
    .filter({ has: page.locator(".daily-supplies-dialog") });
  await dialog.waitFor({ state: "visible" });
  assert.match(await dialog.innerText(), /30 calendar days are pending/);
  assert.deepEqual(
    await snapshot(),
    result.charged,
    "large jump waits for the GM",
  );
  console.log(
    "Native calendar buttons:",
    await dialog.locator("button").allTextContents(),
  );
  await dialog.locator('button[data-action="no"]').click();
  await waitBaseline();
  assert.deepEqual(
    await snapshot(),
    result.charged,
    "skip ignores entire pending month",
  );
  const failure = await page.evaluate(async ({ actorIds, config, old }) => {
    const { settleLiving } =
      await import("/modules/infinity-dnd5e/scripts/resource/living.js");
    const s = await import("/modules/infinity-dnd5e/scripts/resource/store.js");
    const actor = game.actors.get(actorIds[1]);
    const update = actor.update;
    const runId = "native-lost-reply-" + Date.now();
    let calls = 0;
    actor.update = async function (patch) {
      calls++;
      await update.call(this, patch);
      throw Error("Synthetic lost Actor update reply");
    };
    try {
      const rows = [{ actorId: actor.id }];
      await settleLiving({ config, rows, runId, days: 1, actors: game.actors });
      await settleLiving({
        config,
        rows: [{ actorId: actor.id }],
        runId,
        days: 1,
        actors: game.actors,
      });
    } finally {
      actor.update = update;
    }
    const afterLost = actor.system.currency.gp;
    await actor.update({
      "system.currency": { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 },
    });
    const rows = [{ actorId: actor.id }];
    await settleLiving({
      config,
      rows,
      runId: "native-no-funds-" + Date.now(),
      days: 1,
      actors: game.actors,
    });
    await game.settings.set("infinity-dnd5e", "resourceAutoTrigger", false);
    await s.saveResourceConfig(old);
    return {
      calls,
      afterLost,
      covered: rows[0].living.covered,
      errors: rows[0].errors,
      gp: actor.system.currency.gp,
      food: actor.items.find((i) => i.name === "Rations").system.quantity,
    };
  }, result);
  assert.equal(failure.calls, 1, "persisted lost reply does not charge twice");
  assert.equal(failure.afterLost, 18);
  assert.equal(failure.covered, false);
  assert.equal(failure.gp, 0);
  assert.equal(failure.food, 5);
  assert.match(failure.errors.join(" "), /could not pay/);
}
