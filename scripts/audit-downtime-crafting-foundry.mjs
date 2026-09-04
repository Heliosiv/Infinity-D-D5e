/** Additional journeys for audit-downtime-foundry.mjs's guarded disposable world. */
import assert from "node:assert/strict";
import path from "node:path";

export async function runCraftingFoundryJourney({
  gm,
  player,
  actorIds,
  worldTime,
  output,
  record,
}) {
  const actorId = actorIds[0];
  const sourceProbe = await gm.evaluate(async () => {
    try {
      const item = await fromUuid(
        "Compendium.infinity-dnd5e.infinity-dnd5e-items.Item.3c7JXOzsv55gqJS5",
      );
      return {
        found: Boolean(item),
        type: item?.type,
        name: item?.name,
        system: Boolean(item?.toObject()?.system),
        packs: game.packs.has("infinity-dnd5e.infinity-dnd5e-items"),
      };
    } catch (error) {
      return { error: String(error?.stack ?? error) };
    }
  });
  console.log("Crafting source check", JSON.stringify(sourceProbe));
  assert.equal(
    sourceProbe.found,
    true,
    "Compile the module's item catalog before running installed crafting journeys.",
  );
  const fixtures = await gm.evaluate(async (id) => {
    if (game.world.id !== "downtime-gauntlet")
      throw Error("Crafting tests require the disposable world.");
    const actor = game.actors.get(id);
    if (actor.getFlag("infinity-dnd5e", "downtimeGauntletActor") !== 1)
      throw Error("Expected marked test actor.");
    await actor.update({
      "system.currency": { pp: 0, gp: 500, ep: 0, sp: 0, cp: 0 },
    });
    const sources = [
      { name: "Smith's Tools", type: "tool", system: { quantity: 1 } },
      {
        name: `Gauntlet crafting timber ${foundry.utils.randomID(6)}`,
        type: "loot",
        system: { quantity: 5 },
      },
      {
        name: `Gauntlet spell ink ${foundry.utils.randomID(6)}`,
        type: "loot",
        system: { quantity: 2 },
      },
      {
        name: "Gauntlet scribing spell",
        type: "spell",
        system: {
          level: 2,
          activities: {
            [foundry.utils.randomID()]: {
              type: "save",
              save: { ability: ["dex"], dc: { calculation: "spellcasting" } },
            },
          },
        },
      },
    ];
    for (const source of sources)
      source.flags = { "infinity-dnd5e": { downtimeCraftingFixture: true } };
    const created = await actor.createEmbeddedDocuments("Item", sources);
    return {
      toolId: created[0].id,
      timberName: created[1].name,
      inkName: created[2].name,
      timberId: created[1].id,
      inkId: created[2].id,
      spellId: created[3].id,
    };
  }, actorId);

  async function inventory() {
    return gm.evaluate(
      ({ actorId, fixtures }) => {
        const actor = game.actors.get(actorId);
        const cp = Object.entries({
          pp: 1000,
          gp: 100,
          ep: 50,
          sp: 10,
          cp: 1,
        }).reduce(
          (sum, [key, rate]) =>
            sum + Number(actor.system.currency[key] ?? 0) * rate,
          0,
        );
        return {
          cp,
          timber: actor.items.get(fixtures.timberId).system.quantity,
          ink: actor.items.get(fixtures.inkId).system.quantity,
          tool: actor.items.get(fixtures.toolId).system.quantity,
          spellPresent: actor.items.has(fixtures.spellId),
          outputs: actor.items
            .filter((item) => item.getFlag("infinity-dnd5e", "downtimeCraft"))
            .map((item) => ({
              id: item.id,
              name: item.name,
              type: item.type,
              quantity: item.system.quantity,
              activities: Object.keys(item.toObject().system.activities ?? {})
                .length,
              uses: item.system.uses?.toObject?.() ?? item.system.uses,
            })),
          time: game.time.worldTime,
        };
      },
      { actorId, fixtures },
    );
  }
  async function savePreset(kind, name, material, quantity) {
    await gm.locator('[data-action="setView"][data-view="activities"]').click();
    await gm
      .locator(`[data-action="craftingPreset"][data-recipe="${kind}"]`)
      .click();
    await gm.getByLabel("Activity name", { exact: true }).fill(name);
    if (kind === "arrows")
      await gm
        .getByLabel("Additional cost per workday (gp)", { exact: true })
        .fill("2");
    await gm
      .locator("summary")
      .filter({ hasText: "Inventory materials to consume" })
      .click();
    await gm.locator('[name="materialName"]').first().fill(material);
    await gm
      .locator('[name="materialQuantity"]')
      .first()
      .fill(String(quantity));
    await gm.locator('[data-action="saveGuidedTemplate"]').click();
    await gm.waitForFunction(
      (name) =>
        document.querySelector("#dt-template-editor-heading")?.textContent ===
        name,
      name,
    );
    const id = await gm
      .locator('[data-form="guided-template"] [name="id"]')
      .inputValue();
    assert.ok(id);
    return id;
  }
  async function openBlock(templateId, hours, targetId = "") {
    await gm.locator('[data-action="setView"][data-view="current"]').click();
    if (await gm.locator('[data-action="beginNextBlock"]').count())
      await gm.locator('[data-action="beginNextBlock"]').click();
    await gm
      .getByLabel("Downtime location", { exact: true })
      .fill("Gauntlet crafting workshop");
    await gm
      .locator('[data-form="new-block"] [name="hours"]')
      .fill(String(hours));
    for (const box of await gm.locator('[name="actorIds"]').all())
      await box.setChecked((await box.getAttribute("value")) === actorId);
    for (const box of await gm.locator('[name="templateIds"]').all())
      await box.setChecked((await box.getAttribute("value")) === templateId);
    for (const box of await gm.locator('[name="projectIds"]').all())
      if (await box.isEnabled()) await box.uncheck();
    await gm.locator('[data-action="createBlock"]').click();
    await gm.locator('[data-action="openForPlayers"]').click();
    await player.locator('[data-action="refresh"]').click();
    const card = player.locator(`[data-activity-id="${templateId}"]`);
    await card.waitFor();
    if (targetId)
      await card.locator('[name="targetId"]').selectOption(targetId);
    if (targetId) {
      await player.locator('[data-action="refresh"]').click();
      assert.equal(
        await card.locator('[name="targetId"]').inputValue(),
        targetId,
        "a refresh keeps the chosen source before submission",
      );
    }
    const shownCost = targetId
      ? await card.locator("[data-target-detail]").innerText()
      : await card.locator(".dt-activity-card__cost").innerText();
    await card.locator('[data-action="addActivity"]').click();
    await player.locator('[data-action="submitQueue"]').click();
    await gm.locator('[data-action="lockBlock"]').click();
    await gm.locator("[data-guided-report]").waitFor();
    assert.equal(
      (await gm.locator("[data-work-summary]").innerText()).trim(),
      shownCost.trim(),
      "GM reviews the exact cost and inventory result shown to the player",
    );
    return shownCost;
  }
  async function apply() {
    await gm.locator('[data-action="applyBlock"]').click();
    await gm.waitForFunction(() =>
      document
        .querySelector(".infinity-downtime-workspace")
        ?.textContent.includes("Completed reports"),
    );
    assert.equal((await inventory()).time, worldTime);
  }
  const arrowId = await savePreset(
    "arrows",
    "Gauntlet resource arrows",
    fixtures.timberName,
    3,
  );
  assert.match(await openBlock(arrowId, 4), /Spend 1.25 gp/);
  const before = await inventory();
  await apply();
  const half = await inventory();
  assert.equal(half.cp, before.cp - 125);
  assert.equal(half.timber, before.timber);
  assert.equal(half.outputs.length, before.outputs.length);
  await gm.reload();
  await gm.waitForFunction(() => game.ready);
  await gm.evaluate(() =>
    game.modules.get("infinity-dnd5e").api.openDowntimeWorkspace(),
  );
  await gm.locator('[data-action="refresh"]').click();
  assert.match(await openBlock(arrowId, 4), /Receive 20 × Arrows/);
  await apply();
  const finished = await inventory();
  assert.equal(finished.cp, before.cp - 250);
  assert.equal(finished.timber, before.timber - 3);
  assert.equal(finished.tool, 1);
  assert.equal(finished.outputs.length, before.outputs.length + 1);
  assert.equal(finished.outputs.at(-1).quantity, 20);
  record("resource arrow crafting across two half-days and GM reload", {
    before,
    half,
    finished,
  });

  const scrollId = await savePreset(
    "scroll",
    "Gauntlet resource scroll",
    fixtures.inkName,
    1,
  );
  const scrollFirst = await openBlock(scrollId, 8, fixtures.spellId);
  assert.match(scrollFirst, /Spend 33.34 gp/);
  assert.match(scrollFirst, /No finished items yet/);
  await player
    .locator(".infinity-downtime-activities")
    .screenshot({ path: path.join(output, "crafting-player-choice.png") });
  await apply();
  assert.equal((await inventory()).ink, 2);
  const scrollLast = await openBlock(scrollId, 16, fixtures.spellId);
  assert.match(scrollLast, /Spend 66.66 gp/);
  assert.match(scrollLast, /Receive 1 ×/);
  await gm
    .locator(".infinity-downtime-workspace")
    .screenshot({ path: path.join(output, "crafting-gm-review.png") });
  await apply();
  const scribed = await inventory();
  assert.equal(scribed.cp, finished.cp - 10000);
  assert.equal(scribed.ink, 1);
  assert.equal(scribed.spellPresent, true);
  const scrollItem = scribed.outputs.find((item) =>
    item.name.includes("Gauntlet scribing spell"),
  );
  assert.ok(scrollItem);
  assert.equal(scrollItem.type, "consumable");
  assert.ok(
    scrollItem.activities > 0,
    "native scroll retains a usable spell activity",
  );
  assert.equal(scrollItem.quantity, 1);
  record(
    "owned spell becomes a usable native scroll after paid multi-day work",
    { scribed, scrollItem },
  );

  assert.match(await openBlock(scrollId, 24, scrollItem.id), /Spend 100 gp/);
  await apply();
  const copied = await inventory();
  assert.equal(copied.cp, scribed.cp - 10000);
  assert.equal(copied.ink, 0);
  assert.equal(
    copied.outputs.find((item) => item.id === scrollItem.id).quantity,
    1,
  );
  assert.equal(copied.outputs.length, scribed.outputs.length + 1);
  record(
    "copying an owned scroll consumes ink and GP while keeping the original",
    { copied },
  );
  await player.reload();
  await player.waitForFunction(() => game.ready);
  await player.evaluate(() =>
    game.modules.get("infinity-dnd5e").api.openDowntimeActivities(),
  );
  await player.locator(".dt-receipt").waitFor();
  assert.match(await player.locator(".dt-receipt").innerText(), /Spent 100 gp/);
  await player
    .locator(".infinity-downtime-activities")
    .screenshot({ path: path.join(output, "crafting-player-receipt.png") });
}
