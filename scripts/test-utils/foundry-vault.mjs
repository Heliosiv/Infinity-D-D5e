import assert from "node:assert/strict";

// Public synthetic fixture only. This helper refuses every non-localhost world.
export const TEST_VAULT_PASSPHRASE =
  "synthetic gauntlet only amber compass linen";
export async function unlockTestVault(page) {
  const url = new URL(page.url());
  assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
  await page.waitForFunction(() => globalThis.game?.ready);
  assert.equal(await page.evaluate(() => game.world.id), "downtime-gauntlet");
  if (!(await page.evaluate(() => game.user.isGM))) return;
  await page.waitForFunction(
    () => game.modules.get("infinity-dnd5e")?.api?.openPrivateVault,
  );
  if (
    await page.evaluate(
      () =>
        game.modules.get("infinity-dnd5e").api.getPrivateStateStatus().state ===
        "ready",
    )
  )
    return;
  await page.evaluate(() => {
    void game.modules.get("infinity-dnd5e").api.openPrivateVault();
  });
  const dialog = page.locator("#infinity-private-vault");
  await dialog.locator('[name="vaultPassphrase"]').fill(TEST_VAULT_PASSPHRASE);
  if (await dialog.locator('[name="vaultConfirm"]').count()) {
    await dialog.locator('[name="vaultConfirm"]').fill(TEST_VAULT_PASSPHRASE);
    await dialog.locator('[name="vaultSaved"]').check();
  }
  await dialog.locator('button[data-action="ok"]').click();
  await page.waitForFunction(
    () =>
      game.modules.get("infinity-dnd5e").api.getPrivateStateStatus().state ===
      "ready",
    null,
    { timeout: 30000 },
  );
  await dialog.waitFor({ state: "hidden" });
}
