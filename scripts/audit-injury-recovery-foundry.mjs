/** Native recovery acceptance; only synthetic data in the disposable local world. */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { unlockTestVault } from "./test-utils/foundry-vault.mjs";
if (!process.argv.includes("--test-world=downtime-gauntlet"))
  throw Error("Explicit disposable world required");
const browser = await chromium.launch({ headless: true });
const out = "output/playwright/injury-recovery";
mkdirSync(out, { recursive: true });
const evidence = [];
const fixtures = [];
const watchdog = setTimeout(() => void browser.close(), 180000);
async function join(name) {
  const context = await browser.newContext({
    viewport: { width: 1100, height: 850 },
  });
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
  console.log("Joining native fixture");
  const gm = await join("Gamemaster");
  await unlockTestVault(gm);
  console.log("Vault ready");
  const player = await join("Gauntlet Player");
  for (const [index, key, method] of [
    [0, "deep-cut", "rest"],
    [1, "internal-bleeding", "magic"],
    [2, "nightmares", "kit"],
    [3, "infection", "kit"],
  ]) {
    const seeded = await gm.evaluate(
      async ({ index, key }) => {
        const root = "/modules/infinity-dnd5e/scripts/injury/";
        const service = await import(root + "service.js");
        const store = await import(root + "workflow-store.js");
        const effects = await import(root + "effects.js");
        const table = await import(root + "table.js");
        const calendar = await import(root + "calendar.js");
        const owner = game.users.find((u) => u.name === "Gauntlet Player");
        const actor = await Actor.create({
          name: `Recovery V4 fixture ${index}`,
          type: "character",
          ownership: { [owner.id]: 3 },
          system: { attributes: { hp: { value: 5, max: 10 } } },
        });
        await actor.createEmbeddedDocuments("Item", [
          {
            name: "Healer's Kit",
            type: "consumable",
            system: {
              identifier: "healers-kit",
              uses: { max: "10", spent: 0 },
              quantity: 1,
            },
          },
        ]);
        const def = table.getCriticalInjuryDefinition(key, 4);
        const pendingId = `native-cure-${actor.id}`;
        const effectId = foundry.utils.randomID();
        const now = calendar.getCurrentInjuryTimestamp();
        const resolution = {
          injuryId: pendingId,
          effectDocumentId: effectId,
          injuryKey: key,
          injuryRoll: def.min,
          tableVersion: 4,
          recoveryFormula: "Requires treatment",
          recoveryDays: 0,
          recoveryStartTs: now,
          recoveryDueTs: null,
          detailTotal: key === "deep-cut" ? 4 : null,
          requestedBy: owner.id,
          resolvedBy: game.user.id,
          resolvedAt: Date.now(),
        };
        await store.createCriticalInjuryApproval({
          pendingId,
          actorId: actor.id,
          targetUserId: owner.id,
        });
        await store.claimCriticalInjuryApplication(pendingId, {
          id: pendingId,
          claimedBy: game.user.id,
        });
        await store.persistCriticalInjuryResolution(pendingId, resolution, {
          applicationLeaseId: pendingId,
        });
        const injury = service.buildInjuryFromResolution(
          pendingId,
          actor,
          resolution,
        );
        const [effect] = await actor.createEmbeddedDocuments(
          "ActiveEffect",
          [
            {
              ...effects.buildCriticalInjuryEffectData(injury, {
                startTime: now,
              }),
              _id: effectId,
            },
          ],
          { keepId: true },
        );
        await store.completeCriticalInjuryWorkflow(pendingId, {
          result: effects.getCriticalInjuryData(effect),
          effectId,
          applicationLeaseId: pendingId,
        });
        // The deterministic roll substitutes only the die, not treatment authority or writes.
        actor.rollSkill = async () => ({ total: 18 });
        return {
          actorId: actor.id,
          injuryId: injury.id,
          effectId,
          hp: actor.system.attributes.hp.value,
        };
      },
      { index, key },
    );
    fixtures.push(seeded);
    await player.waitForFunction(
      ({ actorId, effectId }) =>
        game.actors.get(actorId)?.effects.has(effectId),
      seeded,
    );
    const projection = await player.evaluate(async ({ actorId }) => {
      const { CriticalInjuryApp } =
        await import("/modules/infinity-dnd5e/scripts/injury/injury-app.js");
      const app = CriticalInjuryApp.open({ actorId });
      const effect = game.actors.get(actorId).effects.contents[0];
      return { data: effect.toObject(), app: Boolean(app) };
    }, seeded);
    assert.equal(
      projection.data.flags["infinity-dnd5e"].criticalInjury.treatmentDc,
      0,
    );
    assert.equal(
      projection.data.flags["infinity-dnd5e"].criticalInjury.recoveryDueTs,
      null,
    );
    assert.ok(!projection.data.duration.seconds);
    const request = player.locator(
      `[data-action="requestTreatment"][data-injury-id="${seeded.injuryId}"]`,
    );
    await request.waitFor();
    await player.screenshot({ path: `${out}/${key}-untreated.png` });
    await request.focus();
    await player.keyboard.press("Enter");
    if (key !== "infection") {
      const select = gm.locator('select[name="method"]');
      await select.waitFor();
      await select.selectOption(method);
      await gm
        .locator(".infinity-dialog")
        .filter({ has: select })
        .locator('button[data-action="ok"]')
        .click();
    }
    const healer = gm.locator('select[name="healerId"]');
    await healer.waitFor();
    await healer.selectOption(seeded.actorId);
    await gm.screenshot({ path: `${out}/${key}-review.png` });
    await gm
      .locator(".infinity-dialog")
      .filter({ has: healer })
      .locator('button[data-action="ok"]')
      .click();
    await player.waitForFunction(
      ({ actorId, effectId }) =>
        !game.actors.get(actorId)?.effects.has(effectId),
      seeded,
    );
    const result = await gm.evaluate(
      ({ actorId, injuryId }) => ({
        hp: game.actors.get(actorId).system.attributes.hp.value,
        exists: game.actors
          .get(actorId)
          .effects.some(
            (e) => e.flags["infinity-dnd5e"]?.criticalInjury?.id === injuryId,
          ),
      }),
      seeded,
    );
    assert.equal(result.exists, false);
    assert.equal(result.hp, seeded.hp);
    evidence.push({
      key,
      method,
      cured: true,
      noHpGrant: true,
      playerProjectionChecked: true,
    });
    console.log("Native cure passed", key, method);
  }
  await gm.reload();
  await gm.waitForFunction(() => globalThis.game?.ready);
  await unlockTestVault(gm);
  await player.reload();
  await player.waitForFunction(() => globalThis.game?.ready);
  for (const fixture of fixtures) {
    assert.equal(
      await player.evaluate(
        ({ actorId, effectId }) =>
          game.actors.get(actorId).effects.has(effectId),
        fixture,
      ),
      false,
    );
  }
  evidence.push({ reloadPreservesCures: true, keyboardRequests: true });
  writeFileSync(
    `${out}/evidence.json`,
    JSON.stringify({ checks: evidence, completed: true }, null, 2),
  );
} finally {
  clearTimeout(watchdog);
  await browser.close();
}
