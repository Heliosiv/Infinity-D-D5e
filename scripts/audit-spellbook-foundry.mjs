/** Real Foundry workflow, restricted to the local disposable downtime-gauntlet world. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
const output = "output/playwright/spellbook";
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const evidence = { scenarios: [] };
let gm, player, fixtures;
async function join(name) {
  const page = await (
    await browser.newContext({ viewport: { width: 1280, height: 900 } })
  ).newPage();
  page.on("console", (message) => {
    if (message.type() === "error") console.log(name, message.text());
  });
  page.setDefaultTimeout(20000);
  await page.goto("http://127.0.0.1:32173/join");
  await page.locator('[name="userid"]').selectOption({ label: name });
  await page.locator('[name="join"]').click();
  await page.waitForFunction(() => globalThis.game?.ready);
  assert.equal(await page.evaluate(() => game.world.id), "downtime-gauntlet");
  if (!(await page.evaluate(() => game.settings.get("core", "noCanvas")))) {
    await page.evaluate(() => game.settings.set("core", "noCanvas", true));
    await page.reload();
    await page.waitForFunction(() => globalThis.game?.ready);
  }
  return page;
}
try {
  gm = await join("Gamemaster");
  await gm.waitForFunction(
    () =>
      game.modules.get("infinity-dnd5e")?.api?.getPrivateStateStatus().state ===
      "ready",
  );
  player = await join("Gauntlet Player");
  fixtures = await gm.evaluate(async () => {
    if (game.world.id !== "downtime-gauntlet") throw Error("Wrong world");
    const store =
      await import("/modules/infinity-dnd5e/scripts/downtime/store.js");
    const active = store.getActiveDowntimeBlock();
    if (
      active?.locationName === "Wizard study QA" &&
      ["collecting", "locked", "planned"].includes(active.state) &&
      active.participants.every((p) =>
        game.actors.get(p.actorId)?.getFlag("infinity-dnd5e", "spellbookQa"),
      )
    ) {
      const service =
        await import("/modules/infinity-dnd5e/scripts/downtime/service.js");
      await service.cancelActiveDowntimeBlock(active.id);
    }
    if (store.getActiveDowntimeBlock())
      throw Error("Finish the existing test block first");
    const owner = game.users.find((u) => u.name === "Gauntlet Player");
    const actor = await Actor.create({
      name: "Spellbook QA Wizard",
      type: "character",
      ownership: { [owner.id]: 3 },
      flags: {
        "infinity-dnd5e": { spellbookQa: true },
        ddbimporter: { dndbeyond: { characterId: "123456789" } },
      },
      system: { currency: { gp: 500 }, abilities: { int: { value: 16 } } },
      items: [
        {
          name: "Wizard",
          type: "class",
          system: {
            identifier: "wizard",
            levels: 3,
            spellcasting: { progression: "full", ability: "int" },
          },
        },
        { name: "Spellbook", type: "loot", system: { quantity: 1 } },
      ],
    });
    const source = await Item.create({
      name: "Spellbook QA Web",
      type: "spell",
      system: {
        level: 2,
        school: "con",
        source: { rules: "2024" },
        activities: {
          QaSpellActivity1: {
            type: "save",
            save: { ability: ["dex"], dc: { calculation: "spellcasting" } },
          },
        },
      },
    });
    return {
      actorId: actor.id,
      sourceId: source.id,
      sourceUuid: source.uuid,
      playerId: owner.id,
      templates: store.loadDowntimeConfig().guidedTemplates,
      worldTime: game.time.worldTime,
    };
  });
  console.log("Fixture ready", fixtures.actorId);
  await gm.evaluate(() => {
    game.modules.get("infinity-dnd5e").api.openDowntimeWorkspace();
  });
  await gm.locator('[data-action="setView"][data-view="activities"]').click();
  await gm
    .locator(
      '[data-action="selectGuidedTemplate"][data-template-id="guided-learn-spell"]',
    )
    .click();
  await gm.locator('[name="learningUuid"]').fill(fixtures.sourceUuid);
  await gm
    .locator('[name="learningSourceName"]')
    .fill("Recovered wizard notes");
  await gm.locator('[data-action="saveGuidedTemplate"]').click();
  await gm.waitForFunction(async () => {
    const { loadDowntimeConfig } =
      await import("/modules/infinity-dnd5e/scripts/downtime/store.js");
    return (
      loadDowntimeConfig().guidedTemplates.find(
        (a) => a.id === "guided-learn-spell",
      )?.work.learning?.name === "Spellbook QA Web"
    );
  });
  evidence.scenarios.push(
    "GM configures and saves an actual spell through the learning UI",
  );
  console.log("GM learning editor passed");
  for (const hours of [1, 3]) {
    const blockId = await gm.evaluate(
      async ({ actorId, hours }) => {
        const service =
          await import("/modules/infinity-dnd5e/scripts/downtime/service.js");
        const block = await service.openDowntimeBlock({
          mode: "guided",
          locationName: "Wizard study QA",
          hours,
          actorIds: [actorId],
          templateIds: ["guided-learn-spell"],
          projectIds: [],
        });
        await service.openBlockForPlayers(block.id);
        return block.id;
      },
      { actorId: fixtures.actorId, hours },
    );
    await player.evaluate(async (actorId) => {
      const app = game.modules
        .get("infinity-dnd5e")
        .api.openDowntimeActivities({ actorId });
      await app._adapter.refreshPlayerProjection({ actorId });
      await app.render(true);
    }, fixtures.actorId);
    await player.waitForFunction(
      async ({ blockId, actorId }) => {
        const { DowntimeActivitiesApp } =
          await import("/modules/infinity-dnd5e/scripts/downtime-activities.js");
        const app = DowntimeActivitiesApp._instance;
        return (
          app?._blockId === blockId && app?._actorId === actorId && !app?._busy
        );
      },
      { blockId, actorId: fixtures.actorId },
    );
    const card = player.locator('[data-activity-id="guided-learn-spell"]');
    await card.waitFor();
    if (await card.locator('select[name="hours"]').count())
      await card.locator('select[name="hours"]').selectOption(String(hours));
    await card.locator('[data-action="addActivity"]').click();
    await player.locator('[data-action="submitQueue"]').click();
    if (await player.locator('dialog [data-action="yes"]').count())
      await player.locator('dialog [data-action="yes"]').click();
    await gm.waitForFunction(async () => {
      const { getActiveDowntimeBlock } =
        await import("/modules/infinity-dnd5e/scripts/downtime/store.js");
      return getActiveDowntimeBlock()?.participants?.[0]?.submitted === true;
    });
    const result = await gm.evaluate(async (blockId) => {
      const service =
        await import("/modules/infinity-dnd5e/scripts/downtime/service.js");
      await service.lockActiveDowntimeBlock(blockId);
      await service.planActiveDowntimeBlock(blockId);
      return service.applyActiveDowntimeBlock(blockId);
    }, blockId);
    assert.equal(result.state, "completed");
    console.log("Applied study hours", hours);
  }
  const learned = await gm.evaluate(async (id) => {
    const actor = game.actors.get(id);
    const store =
      await import("/modules/infinity-dnd5e/scripts/downtime/store.js");
    const item = actor.items.find((i) =>
      i.getFlag("infinity-dnd5e", "learnedSpell"),
    );
    return {
      spell: item?.toObject(),
      currency: actor.system.currency.gp,
      records: Object.values(
        store.loadDowntimeWorkflowStore().spellbooks ?? {},
      ).filter((r) => r.actorId === id).length,
    };
  }, fixtures.actorId);
  assert.equal(learned.records, 1);
  assert.equal(learned.currency, 400);
  assert.equal(learned.spell.system.prepared, 0);
  assert.equal(learned.spell.system.sourceItem, "class:wizard");
  assert.equal(Object.keys(learned.spell.system.activities).length, 1);
  evidence.scenarios.push(
    "Player submits split-hour study; real GM workflow spends 100 gp once and persists usable unprepared Wizard spell",
  );
  const sheetId = await player.evaluate(async (id) => {
    const sheet = game.actors.get(id).sheet;
    await sheet.render(true);
    return sheet.id;
  }, fixtures.actorId);
  await player.locator(`#${sheetId} [data-action="toggleControls"]`).click();
  // D&D5e renders the controls into its visible context menu; the base
  // ApplicationV2 dropdown remains hidden inside the sheet.
  await player
    .getByText("Wizard Notes", { exact: true })
    .filter({ visible: true })
    .click();
  await player
    .getByRole("heading", { name: "Spellbook QA Web · Level 2" })
    .waitFor();
  assert.equal(
    await player
      .getByRole("button", { name: "Forget this downtime spell" })
      .count(),
    0,
  );
  await player.screenshot({ path: `${output}/player-notes.png` });
  const accessibility = await new AxeBuilder({ page: player })
    .include(".infinity-wizard-notes")
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  assert.deepEqual(
    accessibility.violations.map((v) => ({ id: v.id, impact: v.impact })),
    [],
  );
  evidence.scenarios.push(
    "Player Wizard Notes is readable, GM-only actions are hidden, and accessibility checks pass",
  );
  for (let i = 0; i < 2; i++) {
    await gm.evaluate(
      async ({ actorId, itemId }) => {
        if (game.world.id !== "downtime-gauntlet") throw Error("Wrong world");
        await game.actors
          .get(actorId)
          .deleteEmbeddedDocuments("Item", [itemId]);
      },
      { actorId: fixtures.actorId, itemId: learned.spell._id },
    );
    await player.evaluate(
      (id) =>
        Hooks.callAll("ddb-importer.characterProcessDataComplete", {
          actor: game.actors.get(id),
        }),
      fixtures.actorId,
    );
    await gm.waitForFunction(
      ({ actorId, itemId }) => game.actors.get(actorId).items.has(itemId),
      { actorId: fixtures.actorId, itemId: learned.spell._id },
    );
  }
  evidence.scenarios.push(
    "Two simulated destructive imports on a real Actor recover via the importing player's completion signal, without duplicates",
  );
  await gm.reload();
  await gm.waitForFunction(
    () =>
      globalThis.game?.ready &&
      game.modules.get("infinity-dnd5e")?.api?.getPrivateStateStatus().state ===
        "ready",
  );
  const afterReload = await gm.evaluate(async (id) => {
    const { spellbookRecords, openWizardNotes } =
      await import("/modules/infinity-dnd5e/scripts/downtime/spellbook.js");
    await openWizardNotes(game.actors.get(id));
    return spellbookRecords(id).length;
  }, fixtures.actorId);
  assert.equal(afterReload, 1);
  await gm.getByRole("button", { name: "Forget this downtime spell" }).click();
  await gm.locator('dialog [data-action="yes"]').click();
  await gm.waitForFunction(
    (id) =>
      !game.actors
        .get(id)
        .items.some((item) => item.getFlag("infinity-dnd5e", "learnedSpell")),
    fixtures.actorId,
  );
  await gm.evaluate(async (id) => {
    const { reconcileSpellbook } =
      await import("/modules/infinity-dnd5e/scripts/downtime/spellbook.js");
    await reconcileSpellbook(id);
  }, fixtures.actorId);
  assert.equal(
    await gm.evaluate(
      (id) =>
        game.actors.get(id).items.filter((i) => i.type === "spell").length,
      fixtures.actorId,
    ),
    0,
  );
  assert.equal(
    await gm.evaluate(() => game.time.worldTime),
    fixtures.worldTime,
  );
  evidence.scenarios.push(
    "Reload retains permanent ledger; GM Forget UI tombstones the record and prevents resurrection; calendar unchanged",
  );
  await gm.screenshot({ path: `${output}/gm-notes.png` });
  evidence.passed = true;
} catch (error) {
  evidence.failure = String(error.stack ?? error);
  await gm?.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  await player
    ?.screenshot({ path: `${output}/failure-player.png` })
    .catch(() => {});
  throw error;
} finally {
  if (fixtures && gm)
    await gm
      .evaluate(async (fixtures) => {
        if (game.world.id !== "downtime-gauntlet") throw Error("Wrong world");
        const store =
          await import("/modules/infinity-dnd5e/scripts/downtime/store.js");
        if (store.getActiveDowntimeBlock()) return; // retain evidence for recovery after a failed journey
        await store.updateDowntimeConfig((config) => ({
          ...config,
          guidedTemplates: fixtures.templates,
        }));
        const actor = game.actors.get(fixtures.actorId);
        if (actor?.getFlag("infinity-dnd5e", "spellbookQa"))
          await actor.delete();
        const source = game.items.get(fixtures.sourceId);
        if (source?.name === "Spellbook QA Web") await source.delete();
      }, fixtures)
      .catch((error) => {
        evidence.cleanupFailure = String(error);
      });
  writeFileSync(`${output}/results.json`, JSON.stringify(evidence, null, 2));
  await browser.close();
}
console.log(JSON.stringify(evidence, null, 2));
