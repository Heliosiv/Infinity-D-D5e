import { unlockTestVault } from "./test-utils/foundry-vault.mjs";
/** Exercise real ApplicationV2 routing and same-GM tab handoff in the test world. */
import assert from "node:assert/strict";
import path from "node:path";
import { GM_WORKBENCH_ROUTES } from "./gm-workbench-routes.js";

export async function runWorkbenchFoundryJourney({ gm, output, record }) {
  assert.equal(await gm.evaluate(() => game.world.id), "downtime-gauntlet");
  async function routeLoop(page) {
    await page.evaluate(() => {
      globalThis.gauntletNavigationErrors = [];
      for (const level of ["warn", "error"]) {
        const original = ui.notifications[level];
        ui.notifications[level] = function (message, ...args) {
          gauntletNavigationErrors.push(String(message));
          return original.call(this, message, ...args);
        };
      }
    });
    for (let pass = 0; pass < 2; pass++) {
      for (const route of [
        ...GM_WORKBENCH_ROUTES,
        ...GM_WORKBENCH_ROUTES.toReversed(),
      ]) {
        console.log(`Workbench navigation ${pass + 1}: ${route}`);
        await page.locator(`[data-workbench-route="${route}"]`).click();
        await page
          .locator(`[data-workbench-route="${route}"][aria-current="page"]`)
          .waitFor();
        assert.equal(
          await page.locator(".gmw-chrome").count(),
          1,
          "Only one routed workspace remains open",
        );
      }
    }
    assert.deepEqual(
      await page.evaluate(() => gauntletNavigationErrors),
      [],
      "Browsing unchanged workspaces must not report permission or save errors",
    );
  }
  await routeLoop(gm);
  record("installed workbench: 20 leader navigation actions", { errors: 0 });
  const follower = await gm.context().newPage();
  follower.setDefaultTimeout(20_000);
  try {
    await follower.goto(gm.url());
    await follower.waitForFunction(() => game?.ready, null, {
      timeout: 30_000,
    });
    await unlockTestVault(follower);
    await follower.waitForFunction(
      () =>
        game.modules.get("infinity-dnd5e")?.api?.getPrivateStateStatus()
          .state === "ready",
      null,
      { timeout: 30_000 },
    );
    assert.equal(
      await follower.evaluate(() => game.world.id),
      "downtime-gauntlet",
    );
    await follower.evaluate(() =>
      game.modules.get("infinity-dnd5e").api.openMerchantWorkspace(),
    );
    const leadership = await follower.evaluate(async () => {
      const module =
        await import("/modules/infinity-dnd5e/scripts/campaign-tab-leadership.js");
      await module.ensureCampaignTabLeadership();
      return module.getCampaignTabLeadershipStatus();
    });
    assert.equal(
      leadership.leader,
      false,
      "Duplicate GM tab must be read-only",
    );
    await routeLoop(follower);
    record(
      "installed workbench: 20 read-only duplicate-GM navigation actions",
      { errors: 0, readOnly: true },
    );
    await gm.close();
    await follower.waitForFunction(
      async () => {
        const module =
          await import("/modules/infinity-dnd5e/scripts/campaign-tab-leadership.js");
        return module.getCampaignTabLeadershipStatus().leader;
      },
      null,
      { timeout: 30_000 },
    );
    await follower.evaluate(() =>
      game.modules.get("infinity-dnd5e").api.openDowntimeWorkspace(),
    );
    await follower.locator(".infinity-downtime-workspace").screenshot({
      path: path.join(output, "workbench-leadership-transfer.png"),
    });
    record(
      "installed workbench: closing leader transfers editing to remaining GM tab",
      { leader: true },
    );
    return follower;
  } catch (error) {
    await follower
      .screenshot({ path: path.join(output, "failure-workbench-follower.png") })
      .catch(() => {});
    await follower.close();
    throw error;
  }
}
