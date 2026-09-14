/** Synthetic localhost Combat/Actor acceptance only. */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { unlockTestVault } from "./test-utils/foundry-vault.mjs";
if (!process.argv.includes("--test-world=downtime-gauntlet"))
  throw Error("Disposable world required");
const browser = await chromium.launch({ headless: true });
const watchdog = setTimeout(() => void browser.close(), 180000);
async function join(name) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem("core.noCanvas", "true"));
  await page.goto("http://127.0.0.1:32173/join");
  await page.locator('[name="userid"]').selectOption({ label: name });
  await page.locator('[name="join"]').click();
  await page.waitForFunction(() => globalThis.game?.ready, null, {
    timeout: 45000,
  });
  assert.equal(await page.evaluate(() => game.world.id), "downtime-gauntlet");
  return page;
}
try {
  const gm = await join("Gamemaster");
  await unlockTestVault(gm);
  const player = await join("Gauntlet Player");
  const result = await gm.evaluate(async () => {
    const { processCombatBleeding } =
      await import("/modules/infinity-dnd5e/scripts/injury/bleeding.js");
    const owner = game.users.find((u) => u.name === "Gauntlet Player");
    const actor = await Actor.create({
      name: "Bleeding native fixture",
      type: "character",
      ownership: { [owner.id]: 3 },
      system: { attributes: { hp: { value: 10, max: 10, temp: 3 } } },
    });
    await actor.createEmbeddedDocuments(
      "ActiveEffect",
      [false, true].map((disabled, index) => ({
        name: "Synthetic Internal Bleeding",
        disabled,
        flags: {
          "infinity-dnd5e": {
            criticalInjury: {
              id: `bleeding-${index}`,
              injuryKey: "internal-bleeding",
              tableVersion: 4,
            },
          },
        },
      })),
    );
    const combat = await Combat.create({ combatants: [{ actorId: actor.id }] });
    const originalCreate = ChatMessage.create;
    ChatMessage.create = async () => {
      throw Error("Synthetic completion interruption");
    };
    let rolls = 0;
    let interrupted = false;
    try {
      await processCombatBleeding(combat, {
        start: true,
        roll: async (formula) => {
          rolls++;
          return { total: formula === "1d6" ? 1 : 4 };
        },
      });
    } catch (error) {
      interrupted = error.message.includes("Synthetic completion");
    }
    ChatMessage.create = originalCreate;
    const { readCriticalInjuryBleeding } =
      await import("/modules/infinity-dnd5e/scripts/injury/workflow-store.js");
    return {
      actorId: actor.id,
      combatId: combat.id,
      hp: actor.system.attributes.hp.value,
      temp: actor.system.attributes.hp.temp,
      rolls,
      interrupted,
      events: readCriticalInjuryBleeding(combat.id).events.length,
    };
  });
  assert.deepEqual(
    [result.hp, result.temp, result.rolls, result.events, result.interrupted],
    [9, 0, 2, 1, true],
  );
  await player.waitForFunction(
    ({ actorId }) => game.actors.get(actorId)?.system.attributes.hp.value === 9,
    result,
  );
  const denied = await player.evaluate(async ({ combatId }) => {
    try {
      await game.combats
        .get(combatId)
        .setFlag("infinity-dnd5e", "criticalInjuryBleeding", {
          version: 1,
          events: [],
        });
      return false;
    } catch {
      return true;
    }
  }, result);
  assert.equal(
    denied,
    true,
    "server rejects player Combat writes despite permissive client check",
  );
  await gm.context().close();
  const next = await join("Continuity GM");
  await unlockTestVault(next);
  const resumed = await next.evaluate(async ({ actorId, combatId }) => {
    const { processCombatBleeding } =
      await import("/modules/infinity-dnd5e/scripts/injury/bleeding.js");
    const combat = game.combats.get(combatId);
    await processCombatBleeding(combat, {
      roll: async () => {
        throw Error("Must reuse saved dice");
      },
    });
    const { readCriticalInjuryBleeding } =
      await import("/modules/infinity-dnd5e/scripts/injury/workflow-store.js");
    const event = readCriticalInjuryBleeding(combat.id).events[0];
    const hp = game.actors.get(actorId).system.attributes.hp;
    return {
      hp: hp.value,
      temp: hp.temp,
      state: event.state,
      chatDone: event.chatDone,
      chatId: event.chatId,
    };
  }, result);
  assert.equal(resumed.hp, 9);
  assert.equal(resumed.temp, 0);
  assert.equal(resumed.state, "completed");
  assert.equal(resumed.chatDone, true);
  await next.reload();
  await next.waitForFunction(() => globalThis.game?.ready);
  await unlockTestVault(next);
  assert.equal(
    await next.evaluate(
      ({ actorId }) => game.actors.get(actorId).system.attributes.hp.value,
      result,
    ),
    9,
  );
  mkdirSync("output/playwright/bleeding", { recursive: true });
  await player.screenshot({ path: "output/playwright/bleeding/player.png" });
  writeFileSync(
    "output/playwright/bleeding/evidence.json",
    JSON.stringify(
      {
        result,
        resumed,
        reloadPassed: true,
        playerCombatWriteDenied: true,
      },
      null,
      2,
    ),
  );
  console.log(
    "Native Bleeding: temp HP, disabled effect, interrupted completion, GM handoff, saved chat and reload passed",
  );
} finally {
  clearTimeout(watchdog);
  await browser.close();
}
