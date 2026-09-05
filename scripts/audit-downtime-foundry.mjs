/** Optional installed-Foundry gauntlet. Writes only to the named disposable world. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { runCraftingFoundryJourney } from "./audit-downtime-crafting-foundry.mjs";
import { runActivityLibraryFoundryJourney } from "./audit-downtime-library-foundry.mjs";
import { runWorkbenchFoundryJourney } from "./audit-workbench-foundry.mjs";

const WORLD = "downtime-gauntlet";
const args = process.argv.slice(2);
const argument = (name, fallback = "") => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || fallback : fallback;
};
if (!args.includes("--test-world") || argument("--test-world") !== WORLD) {
  throw new Error(`Run only against a disposable world: --test-world ${WORLD}`);
}
const base = new URL(argument("--url", "http://127.0.0.1:32173"));
if (
  base.protocol !== "http:" ||
  !["localhost", "127.0.0.1"].includes(base.hostname)
) {
  throw new Error(
    "The installed-world gauntlet accepts only a local HTTP server.",
  );
}
const output = path.resolve("output/playwright/downtime/foundry");
mkdirSync(output, { recursive: true });
const evidence = {
  startedAt: new Date().toISOString(),
  world: WORLD,
  scenarios: [],
};
const browser = await chromium.launch({ headless: true });
let gm;
let player;
let originalTemplates;

async function join(userName) {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  await page.goto(new URL("/join", base).href);
  await page.locator('[name="userid"]').selectOption({ label: userName });
  await page.locator('[name="join"]').click();
  await page.waitForFunction(() => globalThis.game?.ready, null, {
    timeout: 30_000,
  });
  assert.equal(
    await page.evaluate(() => game.world.id),
    WORLD,
    "refuse every other world before writing",
  );
  const noCanvas = await page.evaluate(() =>
    game.settings.get("core", "noCanvas"),
  );
  if (!noCanvas) {
    await page.evaluate(() => game.settings.set("core", "noCanvas", true));
    await page.reload();
    await page.waitForFunction(() => globalThis.game?.ready, null, {
      timeout: 30_000,
    });
  }
  return page;
}

async function readyGm() {
  await gm.waitForFunction(
    () =>
      globalThis.game?.ready &&
      game.modules.get("infinity-dnd5e")?.api?.getPrivateStateStatus().state ===
        "ready",
    null,
    { timeout: 30_000 },
  );
  await gm.evaluate(() =>
    game.modules.get("infinity-dnd5e").api.openDowntimeWorkspace(),
  );
}

async function state() {
  return gm.evaluate(async (actorIds) => {
    const store =
      await import("/modules/infinity-dnd5e/scripts/private-state.js");
    const workflow = store.getPrivateState("downtimeWorkflow");
    const block = workflow.activeBlock ?? workflow.history.at(-1);
    const copper = (a) =>
      Object.entries({ pp: 1000, gp: 100, ep: 50, sp: 10, cp: 1 }).reduce(
        (sum, [key, rate]) => sum + Number(a.system.currency[key] ?? 0) * rate,
        0,
      );
    return {
      blockId: block?.id,
      state: block?.state,
      active: Boolean(workflow.activeBlock),
      operations: Object.values(block?.operationLedger ?? {}).map(
        (row) => row.state,
      ),
      wallets: actorIds.map((id) => copper(game.actors.get(id))),
      time: game.time.worldTime,
    };
  }, evidence.actorIds);
}

function record(name, result) {
  evidence.scenarios.push({ name, ...result });
  writeFileSync(
    path.join(output, "results.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  console.log(`Passed: ${name}`);
}

async function waitCompleted() {
  await gm.waitForFunction(
    () =>
      document
        .querySelector(".infinity-downtime-workspace")
        ?.textContent.includes("Completed reports"),
    null,
    { timeout: 30_000 },
  );
  const current = await state();
  assert.equal(current.state, "completed");
  assert.equal(current.active, false);
  assert.ok(current.operations.every((value) => value === "applied"));
  assert.equal(current.time, evidence.worldTime);
  return current;
}

async function prepareParticipant(actorId) {
  await gm
    .locator(
      `.dt-participant [data-action="prepareParticipant"][data-actor-id="${actorId}"]`,
    )
    .click();
  await gm.locator("[data-guided-report]").first().waitFor();
  await gm.waitForFunction(
    () => document.activeElement?.id === "dt-preview-heading",
  );
}

async function selectResult(index) {
  const button = gm.locator(
    `[data-action="chooseGuidedOutcome"][data-outcome-index="${index}"]`,
  );
  await button.click();
  await gm.waitForFunction(
    (index) =>
      document
        .querySelector(
          `[data-action="chooseGuidedOutcome"][data-outcome-index="${index}"]`,
        )
        ?.getAttribute("aria-pressed") === "true",
    index,
  );
}

async function waitForParticipantReceipt(actorId, expected) {
  await player
    .getByRole("button", { name: "Refresh downtime", exact: true })
    .click();
  await player
    .locator(`[data-action="selectActor"][data-actor-id="${actorId}"]`)
    .click();
  await player.locator(".dt-receipt").waitFor();
  assert.match(await player.locator(".dt-receipt").innerText(), expected);
}

async function openUiBlock(templateId, location, hours = 8) {
  const currentView = gm.locator(
    '[data-action="setView"][data-view="current"]',
  );
  if ((await currentView.getAttribute("aria-current")) !== "page")
    await currentView.click();
  await gm.waitForFunction(
    () =>
      document
        .querySelector('[data-view="current"]')
        ?.getAttribute("aria-current") === "page",
  );
  if (await gm.locator('[data-action="beginNextBlock"]').count())
    await gm.locator('[data-action="beginNextBlock"]').click();
  await gm.getByLabel("Downtime location", { exact: true }).fill(location);
  await gm
    .locator('[data-form="new-block"] [name="hours"]')
    .fill(String(hours));
  for (const checkbox of await gm.locator('[name="actorIds"]').all()) {
    await checkbox.setChecked(
      evidence.actorIds.includes(await checkbox.getAttribute("value")),
    );
  }
  for (const checkbox of await gm.locator('[name="templateIds"]').all()) {
    await checkbox.setChecked(
      (await checkbox.getAttribute("value")) === templateId,
    );
  }
  for (const checkbox of await gm.locator('[name="projectIds"]').all()) {
    if (await checkbox.isEnabled()) await checkbox.uncheck();
  }
  await gm.locator('[data-action="createBlock"]').click();
  await gm.locator('[data-action="openForPlayers"]').click();
}

async function submitUiChoices(
  templateId,
  needsRoll,
  { probeRetry = false } = {},
) {
  for (const actorId of evidence.actorIds) {
    await player
      .locator(`[data-action="selectActor"][data-actor-id="${actorId}"]`)
      .click();
    await player.waitForFunction(
      (id) =>
        document
          .querySelector(`[data-action="selectActor"][data-actor-id="${id}"]`)
          ?.getAttribute("aria-current") === "true",
      actorId,
    );
    await player
      .locator(`[data-activity-id="${templateId}"] [data-action="addActivity"]`)
      .click();
    const submit = player.locator('[data-action="submitQueue"]');
    await player.waitForFunction(
      () =>
        document.querySelector('[data-action="submitQueue"]')?.disabled ===
        false,
    );
    assert.equal(
      (await submit.innerText()).trim(),
      needsRoll ? "Roll & submit" : "Submit activity",
    );
    if (probeRetry && actorId === evidence.actorIds[0]) {
      await submit.click();
      await player.locator('dialog [data-action="close"]').click();
      await player.waitForFunction(
        () =>
          document.querySelector('[data-action="submitQueue"]')?.disabled ===
          false,
      );
      assert.equal(
        await player
          .locator('.infinity-downtime-activities [role="alert"]')
          .count(),
        0,
        "cancelling a roll is not presented as a failed request",
      );
      await player.evaluate(async () => {
        const { DowntimeActivitiesApp } =
          await import("/modules/infinity-dnd5e/scripts/downtime-activities.js");
        const adapter = DowntimeActivitiesApp._instance._adapter;
        globalThis.downtimeRetryProbe = {
          originalTransport: adapter._submitTransport,
          originalTimeout: adapter._requestTimeoutMs,
          messagesBefore: game.messages.size,
          payloads: [],
        };
        adapter._requestTimeoutMs = 1500;
        adapter._submitTransport = (payload) => {
          downtimeRetryProbe.payloads.push(structuredClone(payload));
          if (downtimeRetryProbe.payloads.length === 1) return { ok: true };
          return downtimeRetryProbe.originalTransport(payload);
        };
      });
      await submit.click();
      await player.locator('dialog [data-action="normal"]').click();
      await player.waitForFunction(() =>
        document
          .querySelector('[data-action="submitQueue"]')
          ?.textContent.includes("Retry submission"),
      );
      assert.match(
        await player
          .locator('.infinity-downtime-activities [role="alert"]')
          .innerText(),
        /did not answer/,
      );
      await player.evaluate(async () => {
        const { DowntimeActivitiesApp } =
          await import("/modules/infinity-dnd5e/scripts/downtime-activities.js");
        DowntimeActivitiesApp._instance._adapter._requestTimeoutMs =
          downtimeRetryProbe.originalTimeout;
      });
      await submit.click();
      await player.locator('[data-action="recallSubmission"]').waitFor();
      const retry = await player.evaluate(async () => {
        const { DowntimeActivitiesApp } =
          await import("/modules/infinity-dnd5e/scripts/downtime-activities.js");
        DowntimeActivitiesApp._instance._adapter._submitTransport =
          downtimeRetryProbe.originalTransport;
        return {
          attempts: downtimeRetryProbe.payloads.length,
          sameRequest:
            JSON.stringify(downtimeRetryProbe.payloads[0]) ===
            JSON.stringify(downtimeRetryProbe.payloads[1]),
          rollMessages: game.messages.size - downtimeRetryProbe.messagesBefore,
        };
      });
      assert.deepEqual(retry, {
        attempts: 2,
        sameRequest: true,
        rollMessages: 1,
      });
      record("cancelled roll and timed-out submission retry", retry);
    } else {
      await submit.click();
      if (needsRoll)
        await player.locator('dialog [data-action="normal"]').click();
    }
    await player.locator('[data-action="recallSubmission"]').waitFor();
  }
}

async function prepareFaultBlock(label) {
  return gm.evaluate(
    async ({ actorIds, playerId, label }) => {
      const service =
        await import("/modules/infinity-dnd5e/scripts/downtime/service.js");
      const block = await service.openDowntimeBlock({
        mode: "guided",
        locationName: label,
        hours: 8,
        actorIds,
        templateIds: ["guided-labor"],
      });
      for (const actorId of actorIds)
        await service.submitQueueAuthoritatively({
          userId: playerId,
          requestId: `fixture-${block.id}-${actorId}`,
          blockId: block.id,
          actorId,
          queue: [
            {
              id: "fixture",
              activityId: "guided-labor",
              hours: 8,
              skill: "ath",
              guidedRoll: {
                total: 20,
                formula: "Gauntlet deterministic fixture",
              },
            },
          ],
        });
      await service.lockActiveDowntimeBlock(block.id);
      await service.planActiveDowntimeBlock(block.id);
      return block.id;
    },
    { actorIds: evidence.actorIds, playerId: evidence.playerId, label },
  );
}

try {
  gm = await join(argument("--gm", "Gamemaster"));
  await readyGm();
  gm = await runWorkbenchFoundryJourney({ gm, output, record });
  await readyGm();
  originalTemplates = await gm.evaluate(async () => {
    const store =
      await import("/modules/infinity-dnd5e/scripts/downtime/store.js");
    const original = structuredClone(
      store.loadDowntimeConfig().guidedTemplates,
    );
    // Old gauntlet runs accumulated these fixtures until the library was full.
    // Restore the exact library in finally, including any custom activities.
    await store.updateDowntimeConfig((config) => ({
      ...config,
      guidedTemplates: config.guidedTemplates.filter(
        (row) =>
          !["Gauntlet resource arrows", "Gauntlet resource scroll"].includes(
            row.name,
          ),
      ),
    }));
    return original;
  });
  const fixture = await gm.evaluate(async (craftingOnly) => {
    const state =
      await import("/modules/infinity-dnd5e/scripts/private-state.js");
    const previous = state.getPrivateState("downtimeWorkflow").activeBlock;
    if (
      craftingOnly &&
      previous?.locationName === "Gauntlet crafting workshop" &&
      ["applying", "needs-review"].includes(previous.state) &&
      previous.participants.every((row) =>
        game.actors
          .get(row.actorId)
          ?.getFlag("infinity-dnd5e", "downtimeGauntletActor"),
      )
    ) {
      const service =
        await import("/modules/infinity-dnd5e/scripts/downtime/service.js");
      await service.recoverActiveDowntimeBlock(previous.id);
    }
    if (
      craftingOnly &&
      previous?.locationName === "Gauntlet crafting workshop" &&
      ["collecting", "locked", "planned"].includes(previous.state) &&
      previous.participants.every((row) =>
        game.actors
          .get(row.actorId)
          ?.getFlag("infinity-dnd5e", "downtimeGauntletActor"),
      )
    ) {
      const service =
        await import("/modules/infinity-dnd5e/scripts/downtime/service.js");
      await service.cancelActiveDowntimeBlock(previous.id);
    }
    if (state.getPrivateState("downtimeWorkflow").activeBlock)
      throw Error(
        "Finish the existing disposable test block before running this gauntlet.",
      );
    const player = game.users.find(
      (user) => user.name === "Gauntlet Player" && user.role === 1,
    );
    if (!player)
      throw Error(
        "Create a test player named Gauntlet Player with no password in the disposable world.",
      );
    const actors = [];
    for (const [index, name] of [
      "Gauntlet runner — Mira",
      "Gauntlet runner — Rowan",
    ].entries()) {
      let actor = game.actors.find(
        (row) =>
          row.getFlag("infinity-dnd5e", "downtimeGauntletActor") === index + 1,
      );
      if (!actor)
        actor = await Actor.create({
          name,
          type: "character",
          ownership: { default: 0, [player.id]: 3 },
          flags: { "infinity-dnd5e": { downtimeGauntletActor: index + 1 } },
          system: { abilities: { str: { value: 16 }, int: { value: 16 } } },
        });
      await actor.update({
        "system.currency": { pp: 0, gp: (index + 1) * 10, ep: 0, sp: 0, cp: 0 },
      });
      actors.push(actor.id);
    }
    return {
      actorIds: actors,
      playerId: player.id,
      worldTime: game.time.worldTime,
      foundry: game.version,
      dnd5e: game.system.version,
    };
  }, args.includes("--crafting-only"));
  Object.assign(evidence, fixture);
  player = await join("Gauntlet Player");
  assert.equal(
    await player.evaluate(() => game.user.role),
    1,
    "exercise an actual player account",
  );
  await player.evaluate(() =>
    game.modules.get("infinity-dnd5e").api.openDowntimeActivities(),
  );
  await gm.locator('[data-action="refresh"]').click();

  if (
    !args.includes("--crafting-only") &&
    !args.includes("--activities-only")
  ) {
    await openUiBlock("guided-labor", "Gauntlet: real player skill checks");
    await submitUiChoices("guided-labor", true, { probeRetry: true });
    await prepareParticipant(evidence.actorIds[0]);
    await selectResult(2);
    const editedReport =
      "The harbor crew praises the careful repairs. The work is complete.";
    await gm.locator("[data-guided-report]").first().fill(editedReport);
    await gm.locator('[data-action="refresh"]').click();
    assert.equal(
      await gm.locator("[data-guided-report]").first().inputValue(),
      editedReport,
    );
    await gm.locator('[data-action="applyBlock"]').click();
    await gm
      .locator(
        `.dt-participant [data-action="prepareParticipant"][data-actor-id="${evidence.actorIds[1]}"]`,
      )
      .waitFor();
    const firstPaid = await state();
    assert.equal(firstPaid.state, "collecting");
    assert.equal(firstPaid.active, true);
    assert.deepEqual(firstPaid.wallets, [1400, 2000]);
    await waitForParticipantReceipt(
      evidence.actorIds[0],
      /harbor crew praises the careful repairs/i,
    );
    await prepareParticipant(evidence.actorIds[1]);
    await selectResult(2);
    await gm.locator('[data-action="applyBlock"]').click();
    const paid = await waitCompleted();
    await gm.waitForFunction(
      () => document.activeElement?.id === "dt-preview-heading",
    );
    assert.deepEqual(paid.wallets, [1400, 2400]);
    record(
      "two real player skill checks resolve independently with immediate receipts",
      { firstPaid, completed: paid },
    );

    await gm.locator('[data-action="setView"][data-view="activities"]').click();
    const templateId = await gm.evaluate(async () => {
      const store =
        await import("/modules/infinity-dnd5e/scripts/private-state.js");
      return (
        store
          .getPrivateState("downtimeConfig")
          .guidedTemplates.find((row) => row.name === "Gauntlet runner garden")
          ?.id ?? null
      );
    });
    if (templateId)
      await gm
        .locator(
          `[data-action="selectGuidedTemplate"][data-template-id="${templateId}"]`,
        )
        .click();
    else await gm.locator('[data-action="newGuidedTemplate"]').click();
    await gm
      .getByLabel("Activity name", { exact: true })
      .fill("Gauntlet runner garden");
    await gm
      .getByLabel("Player description", { exact: true })
      .fill("Tend the community garden during the assigned downtime.");
    for (const checkbox of await gm
      .locator('[data-form="guided-template"] [name="skills"]')
      .all())
      await checkbox.uncheck();
    for (let index = 0; index < 3; index += 1) {
      await gm
        .locator('[name="outcomeReport"]')
        .nth(index)
        .fill(
          [
            "The seedlings are tended.",
            "Fresh herbs fill the kitchen.",
            "A generous harvest rewards your care.",
          ][index],
        );
      await gm
        .locator('[name="outcomeReward"]')
        .nth(index)
        .fill(["0", "1.25", "2.5"][index]);
    }
    await gm.locator('[data-action="saveGuidedTemplate"]').click();
    await gm.waitForFunction(
      () =>
        document.querySelector('[data-form="guided-template"] [name="id"]')
          ?.value,
    );
    const gardenId = await gm
      .locator('[data-form="guided-template"] [name="id"]')
      .inputValue();
    await gm
      .locator(".infinity-downtime-workspace")
      .screenshot({ path: path.join(output, "activity-editor.png") });
    await openUiBlock(gardenId, "Gauntlet: custom activity without a roll");
    await submitUiChoices(gardenId, false);
    await prepareParticipant(evidence.actorIds[0]);
    assert.match(await gm.locator(".dt-preview").innerText(), /No skill check/);
    await selectResult(2);
    await gm.locator('[data-action="applyBlock"]').click();
    await gm
      .locator(
        `.dt-participant [data-action="prepareParticipant"][data-actor-id="${evidence.actorIds[1]}"]`,
      )
      .waitFor();
    const firstGarden = await state();
    assert.equal(firstGarden.state, "collecting");
    assert.equal(firstGarden.active, true);
    assert.deepEqual(firstGarden.wallets, [1650, 2400]);
    await waitForParticipantReceipt(
      evidence.actorIds[0],
      /generous harvest rewards your care/i,
    );
    await prepareParticipant(evidence.actorIds[1]);
    await selectResult(2);
    await gm.locator('[data-action="applyBlock"]').click();
    const garden = await waitCompleted();
    assert.deepEqual(garden.wallets, [1650, 2650]);
    record(
      "custom activity editor, individual no-roll choices, fractional rewards",
      { firstGarden, completed: garden },
    );

    await openUiBlock(
      "guided-labor",
      "Gauntlet: GM reconnect preserves choice",
    );
    await player
      .locator(
        `[data-action="selectActor"][data-actor-id="${evidence.actorIds[0]}"]`,
      )
      .click();
    await player
      .locator('[data-activity-id="guided-labor"] [data-action="addActivity"]')
      .click();
    await player.waitForFunction(
      () =>
        document.querySelector('[data-action="submitQueue"]')?.disabled ===
        false,
    );
    const beforeDisconnect = await player
      .locator("[data-queue-list]")
      .innerText();
    const reconnectBlockId = (await state()).blockId;
    const gmId = await gm.evaluate(() => game.user.id);
    await gm.context().close();
    await player.waitForFunction((id) => !game.users.get(id).active, gmId);
    await player
      .getByRole("button", { name: "Refresh downtime", exact: true })
      .click();
    await player
      .getByRole("heading", { name: "No full GM is online" })
      .waitFor();
    const offline = await player
      .locator(".infinity-downtime-activities")
      .innerText();
    assert.match(offline, /Last choice: Paid Work \(8h\)/);
    assert.doesNotMatch(offline, /Your last receipt is still shown/);
    assert.equal(
      await player.locator('[data-action="submitQueue"]').count(),
      0,
    );
    for (const actorId of [evidence.actorIds[1], evidence.actorIds[0]]) {
      await player
        .locator(`[data-action="selectActor"][data-actor-id="${actorId}"]`)
        .click();
      await player.waitForFunction(
        (id) =>
          document
            .querySelector(`[data-actor-id="${id}"]`)
            ?.getAttribute("aria-current") === "true",
        actorId,
      );
      await player
        .getByRole("heading", { name: "No full GM is online" })
        .waitFor();
      assert.equal(
        await player.locator('[data-action="submitQueue"]').count(),
        0,
      );
    }
    await player.locator(".infinity-downtime-activities").screenshot({
      path: path.join(output, "offline-choice.png"),
    });
    gm = await join(argument("--gm", "Gamemaster"));
    await readyGm();
    await player
      .getByRole("button", { name: "Try again", exact: true })
      .click();
    await player.locator('[data-action="submitQueue"]').waitFor();
    assert.equal(
      await player.locator("[data-queue-list]").innerText(),
      beforeDisconnect,
    );
    assert.equal(
      await player.locator('[data-action="submitQueue"]').isEnabled(),
      true,
    );
    await gm.evaluate(async (blockId) => {
      const service =
        await import("/modules/infinity-dnd5e/scripts/downtime/service.js");
      await service.cancelActiveDowntimeBlock(blockId);
    }, reconnectBlockId);
    record("GM offline and reconnect preserve the unfinished choice", {
      blockId: reconnectBlockId,
      choiceVisibleOffline: true,
      submissionDisabledOffline: true,
      sameChoiceAfterReconnect: true,
    });

    for (const afterWrite of [true, false]) {
      const before = await state();
      const label = afterWrite
        ? "Gauntlet: lost reply after payment"
        : "Gauntlet: interruption before payment";
      await prepareFaultBlock(label);
      await gm.evaluate(
        ({ actorId, afterWrite }) => {
          const actor = game.actors.get(actorId);
          const original = actor.update;
          actor.update = async function (...args) {
            actor.update = original;
            if (afterWrite) await original.apply(actor, args);
            throw Error("Gauntlet injected interruption");
          };
        },
        { actorId: evidence.actorIds[0], afterWrite },
      );
      await gm.locator('[data-action="applyBlock"]').click();
      await gm.locator('[data-action="recoverBlock"]').waitFor();
      const interrupted = await state();
      assert.equal(interrupted.state, "needs-review");
      assert.deepEqual(interrupted.wallets, [
        before.wallets[0] + (afterWrite ? 400 : 0),
        before.wallets[1] + 400,
      ]);
      await gm.reload();
      await readyGm();
      await gm.locator('[data-action="recoverBlock"]').click();
      const recovered = await waitCompleted();
      assert.deepEqual(
        recovered.wallets,
        before.wallets.map((value) => value + 400),
      );
      record(
        afterWrite
          ? "lost payment reply survives reload without duplicate rewards"
          : "unpaid operation recovers after reload",
        { interrupted, recovered, checks: "deterministic fixture totals" },
      );
    }
    await gm
      .locator(".infinity-downtime-workspace")
      .screenshot({ path: path.join(output, "recovered-reports.png") });
    await player.reload();
    await player.waitForFunction(() => globalThis.game?.ready, null, {
      timeout: 30_000,
    });
    await player.evaluate(() =>
      game.modules.get("infinity-dnd5e").api.openDowntimeActivities(),
    );
    for (const actorId of evidence.actorIds) {
      await player
        .locator(`[data-action="selectActor"][data-actor-id="${actorId}"]`)
        .click();
      await player.locator(".dt-receipt").waitFor();
      assert.match(
        await player.locator(".dt-receipt").innerText(),
        /4 gp added/,
      );
    }
    await player
      .locator(".infinity-downtime-activities")
      .screenshot({ path: path.join(output, "player-report.png") });
    record("both reports survive player reconnect", await state());
  }
  if (!args.includes("--crafting-only"))
    await runActivityLibraryFoundryJourney({
      gm,
      player,
      actorIds: evidence.actorIds,
      worldTime: evidence.worldTime,
      output,
      record,
      openUiBlock,
      submitUiChoices,
      prepareParticipant,
      selectResult,
      waitCompleted,
      state,
      waitForParticipantReceipt,
    });
  if (!args.includes("--activities-only"))
    await runCraftingFoundryJourney({
      gm,
      player,
      actorIds: evidence.actorIds,
      worldTime: evidence.worldTime,
      output,
      record,
    });
  evidence.functionalPassed = true;
  evidence.privacy = await player.evaluate(() => {
    const journal = game.journal.find((row) =>
      row.getFlag("infinity-dnd5e", "privateStateStore"),
    );
    const workflow = journal?.getFlag("infinity-dnd5e", "downtimeWorkflow");
    const config = journal?.getFlag("infinity-dnd5e", "downtimeConfig");
    return {
      playerRole: game.user.role,
      journalVisible: journal?.visible === true,
      readableWorkflow: Array.isArray(workflow?.history),
      readableActivityOutcomes:
        config?.guidedTemplates?.some((row) => Array.isArray(row.outcomes)) ===
        true,
    };
  });
  assert.equal(
    evidence.privacy.readableWorkflow ||
      evidence.privacy.readableActivityOutcomes,
    false,
    "Privacy gate: authenticated player received unredacted downtime data despite hidden Journal ownership",
  );
  evidence.completedAt = new Date().toISOString();
  console.log(
    `Installed Foundry downtime gauntlet passed. Evidence: ${output}`,
  );
} catch (error) {
  evidence.failure = String(error?.stack ?? error);
  if (gm)
    await gm
      .screenshot({ path: path.join(output, "failure-gm.png"), fullPage: true })
      .catch(() => {});
  if (player)
    await player
      .screenshot({
        path: path.join(output, "failure-player.png"),
        fullPage: true,
      })
      .catch(() => {});
  throw error;
} finally {
  if (originalTemplates && gm && !gm.isClosed()) {
    try {
      await gm.evaluate(async (templates) => {
        if (game.world.id !== "downtime-gauntlet")
          throw Error("Wrong test world");
        const store =
          await import("/modules/infinity-dnd5e/scripts/downtime/store.js");
        await store.updateDowntimeConfig((config) => ({
          ...config,
          guidedTemplates: templates,
        }));
        if (
          JSON.stringify(store.loadDowntimeConfig().guidedTemplates) !==
          JSON.stringify(templates)
        )
          throw Error("Test library restoration did not verify");
      }, originalTemplates);
      evidence.libraryRestored = true;
    } catch (error) {
      evidence.libraryRestored = false;
      evidence.restorationFailure = String(error?.stack ?? error);
      process.exitCode = 1;
    }
  }
  writeFileSync(
    path.join(output, "results.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  await browser.close();
}
