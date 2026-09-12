/** Actual player transport test. Restricted to the disposable local world. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import {
  TEST_VAULT_PASSPHRASE,
  unlockTestVault,
} from "./test-utils/foundry-vault.mjs";

if (!process.argv.includes("--test-world=downtime-gauntlet"))
  throw Error("Disposable test world required");
const canary = "VAULT-PRIVATE-WIRE-CANARY-605159ea";
const report = {
  checks: [],
  playerFrames: 0,
  exposed: false,
  keyExposed: false,
};
const browser = await chromium.launch({ headless: true });
let gm, player;
const timeout = setTimeout(() => {
  console.error("Native vault audit timed out");
  void browser.close();
}, 600000);
async function join(name) {
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
  });
  const page = await context.newPage();
  page.on("websocket", (socket) => {
    if (name === "Gauntlet Player")
      socket.on("framereceived", ({ payload }) => {
        report.playerFrames++;
        const text = String(payload);
        report.exposed ||= text.includes(canary);
        report.keyExposed ||= text.includes(TEST_VAULT_PASSPHRASE);
      });
    socket.on("framesent", ({ payload }) => {
      report.keyExposed ||= String(payload).includes(TEST_VAULT_PASSPHRASE);
    });
  });
  await page.goto("http://127.0.0.1:32173/join");
  await page.locator('[name="userid"]').selectOption({ label: name });
  await page.locator('[name="join"]').click();
  await page.waitForFunction(() => globalThis.game?.ready);
  assert.equal(await page.evaluate(() => game.world.id), "downtime-gauntlet");
  return page;
}
async function rawSnapshot(page) {
  return page.evaluate(() => ({
    journals: game.journal.map((entry) => entry.toObject()),
    initial: game.data,
    settings: [...game.settings.storage.get("world")].map((entry) =>
      entry.toObject(),
    ),
    local: { ...localStorage },
    session: { ...sessionStorage },
  }));
}
try {
  console.log("Joining GM");
  gm = await join("Gamemaster");
  console.log("GM ready");
  await gm.waitForFunction(
    () =>
      globalThis.game?.modules
        ?.get("infinity-dnd5e")
        ?.api?.getPrivateStateStatus().code === "vault-locked",
  );
  await gm.locator("#infinity-private-vault").waitFor();
  const accessibility = await new AxeBuilder({ page: gm })
    .include("#infinity-private-vault")
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  assert.deepEqual(
    accessibility.violations.map((v) => v.id),
    [],
  );
  mkdirSync("output/playwright/private-vault", { recursive: true });
  await gm
    .locator("#infinity-private-vault")
    .screenshot({ path: "output/playwright/private-vault/unlock.png" });
  report.checks.push(
    "native vault dialog has labeled controls and passes WCAG A/AA axe checks",
  );
  const before = await gm.evaluate(() =>
    JSON.stringify(game.journal.map((entry) => entry.toObject())),
  );
  await gm
    .locator('[name="vaultPassphrase"]')
    .fill("deliberately wrong synthetic phrase");
  await gm.locator('#infinity-private-vault button[data-action="ok"]').click();
  await gm.locator("#infinity-private-vault").waitFor({ state: "hidden" });
  assert.equal(
    await gm.evaluate(() =>
      JSON.stringify(game.journal.map((entry) => entry.toObject())),
    ),
    before,
  );
  console.log("Checkpoint", report.checks.length + 1);
  report.checks.push("wrong passphrase leaves existing records unchanged");
  console.log("Unlocking GM");
  await unlockTestVault(gm);
  console.log("GM unlocked");
  const fixture = await gm.evaluate(async (secret) => {
    const store =
      await import("/modules/infinity-dnd5e/scripts/downtime/store.js");
    const config = store.loadDowntimeConfig();
    const template = config.guidedTemplates.find(
      (entry) => entry.outcomes?.length,
    );
    const originalReport = template.outcomes[0].report;
    template.outcomes[0].report = secret;
    await store.saveDowntimeConfig(config);
    return { templateId: template.id, originalReport };
  }, canary);
  console.log("Joining player");
  player = await join("Gauntlet Player");
  console.log("Player joined");
  let snapshot = JSON.stringify(await rawSnapshot(player));
  assert.equal(snapshot.includes(canary), false);
  assert.equal(snapshot.includes(TEST_VAULT_PASSPHRASE), false);
  const initialCipher = await player.evaluate(() =>
    game.journal
      .find((entry) => entry.getFlag("infinity-dnd5e", "privateStateStore"))
      ?.getFlag("infinity-dnd5e", "privateVault"),
  );
  assert.equal(
    typeof initialCipher,
    "object",
    "player must actually receive the encrypted store; not a missing-record false positive",
  );
  console.log("Checkpoint", report.checks.length + 1);
  report.checks.push(
    "fresh player receives ciphertext, with no private canary or key in raw documents, initial data, settings or browser storage",
  );
  await gm.evaluate(
    async ({ secret, templateId }) => {
      const store =
        await import("/modules/infinity-dnd5e/scripts/downtime/store.js");
      const config = store.loadDowntimeConfig();
      config.guidedTemplates.find(
        (entry) => entry.id === templateId,
      ).outcomes[0].report = `${secret}-updated`;
      await store.saveDowntimeConfig(config);
    },
    { secret: canary, templateId: fixture.templateId },
  );
  await player.waitForFunction(
    (previous) =>
      game.journal
        .find((entry) => entry.getFlag("infinity-dnd5e", "privateStateStore"))
        ?.getFlag("infinity-dnd5e", "privateVault")?.fields?.downtimeConfig !==
      previous,
    initialCipher.fields.downtimeConfig,
  );
  snapshot = JSON.stringify(await rawSnapshot(player));
  assert.equal(snapshot.includes(canary), false);
  assert.ok(report.playerFrames > 0);
  assert.equal(report.exposed, false);
  assert.equal(report.keyExposed, false);
  console.log("Checkpoint", report.checks.length + 1);
  report.checks.push(
    "live update delivers changed ciphertext; captured player WebSocket frames contain neither private canary nor vault passphrase",
  );
  const savedConfigCipher = () => {
    const id = game.settings.get("infinity-dnd5e", "privateStateStoreId");
    return JSON.stringify([
      id,
      game.journal.get(id)?.getFlag("infinity-dnd5e", "privateVault")?.fields
        ?.downtimeConfig,
    ]);
  };
  const afterUpdate = await gm.evaluate(savedConfigCipher);
  await gm.reload();
  await gm.waitForFunction(
    () =>
      globalThis.game?.modules
        ?.get("infinity-dnd5e")
        ?.api?.getPrivateStateStatus().code === "vault-locked",
  );
  assert.equal(await gm.evaluate(savedConfigCipher), afterUpdate);
  console.log("Unlocking GM");
  await unlockTestVault(gm);
  console.log("GM unlocked");
  assert.equal(
    await gm.evaluate(
      async (templateId) =>
        (await import("/modules/infinity-dnd5e/scripts/private-state.js"))
          .getPrivateState("downtimeConfig")
          .guidedTemplates.find((entry) => entry.id === templateId).outcomes[0]
          .report,
      fixture.templateId,
    ),
    `${canary}-updated`,
  );
  console.log("Checkpoint", report.checks.length + 1);
  report.checks.push(
    "GM reload requires local unlock and restores exact durable state without plaintext persistence",
  );
  await gm.evaluate(async ({ templateId, originalReport }) => {
    const store =
      await import("/modules/infinity-dnd5e/scripts/downtime/store.js");
    const config = store.loadDowntimeConfig();
    config.guidedTemplates.find(
      (entry) => entry.id === templateId,
    ).outcomes[0].report = originalReport;
    delete config.vaultTestCanary;
    await store.saveDowntimeConfig(config);
  }, fixture);
  report.runtime = await gm.evaluate(() => ({
    foundry: game.version,
    system: game.system.version,
    module: game.modules.get("infinity-dnd5e").version,
  }));
  report.passed = true;
  console.log(
    `Installed private-vault transport passed ${report.checks.length} scenarios (${report.playerFrames} player WebSocket frames).`,
  );
} catch (error) {
  report.failure = String(error.stack ?? error);
  throw error;
} finally {
  clearTimeout(timeout);
  mkdirSync("output/playwright/private-vault", { recursive: true });
  writeFileSync(
    "output/playwright/private-vault/results.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await browser.close();
}
