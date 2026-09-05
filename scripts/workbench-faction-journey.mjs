import assert from "node:assert/strict";

export async function auditFactionNavigation(page) {
  await page.evaluate(async () => {
    const { ReputationWorkspaceApp } =
      await import("/scripts/reputation-workspace.js");
    const { configureGmWorkbench } = await import("/scripts/gm-workbench.js");
    const { normalizeFaction } =
      await import("/scripts/reputation/standing.js");
    const state = { failSave: true, writes: 0, opened: 0 };
    journey.settings.set("factions", [
      normalizeFaction({ id: "f1", name: "The Watch", revealed: true }),
    ]);
    const save = game.settings.set;
    game.settings.set = async (module, key, value) => {
      if (key === "factions") {
        state.writes++;
        if (state.failSave) throw new Error("Faction editing unavailable");
      }
      return save(module, key, value);
    };
    const root = document.createElement("section");
    root.id = "faction-app";
    root.className = "infinity-dnd5e infinity-reputation-workspace";
    root.innerHTML = '<div class="application-content"></div>';
    document.body.append(root);
    const app = Object.assign(Object.create(ReputationWorkspaceApp.prototype), {
      element: root,
      _selectedId: "f1",
      _saveStatus: "All changes saved",
      rendered: true,
      async render() {
        const context = await this._prepareContext();
        const response = await fetch("/render/factions", {
          method: "POST",
          body: JSON.stringify(context),
        });
        root.querySelector(".application-content").innerHTML =
          await response.text();
        this._onRender(context, {});
      },
      close() {
        this.rendered = false;
        root.hidden = true;
        this._onClose({});
        return Promise.resolve();
      },
    });
    root.addEventListener("click", async (event) => {
      const target = event.target.closest("[data-action]");
      if (!target || target.disabled) return;
      await ReputationWorkspaceApp.DEFAULT_OPTIONS.actions[
        target.dataset.action
      ].call(app, event, target);
    });
    configureGmWorkbench({
      injuries: {
        open: () => {
          state.opened++;
          return { rendered: true };
        },
      },
    });
    globalThis.factionJourney = { app, state };
    document.getElementById("notices").textContent = "";
    await app.render();
  });
  const app = page.locator("#faction-app");
  const navigate = () =>
    app.locator('[data-workbench-route="injuries"]').click();
  await navigate();
  await page.waitForFunction(() => factionJourney.state.opened === 1);
  assert.equal(await page.evaluate(() => factionJourney.state.writes), 0);
  assert.equal(await page.locator("#notices").textContent(), "");

  await page.evaluate(async () => {
    const { app } = factionJourney;
    app.rendered = true;
    app._gmWorkbenchSwitching = false;
    app.element.hidden = false;
    await app.render();
  });
  await app.locator('input[name="name"]').fill("Draft faction name");
  await navigate();
  await page.waitForFunction(() => !factionJourney.app._gmWorkbenchNavigating);
  assert.equal(await page.evaluate(() => factionJourney.state.opened), 1);
  assert.equal(await page.evaluate(() => factionJourney.app.rendered), true);
  assert.equal(
    await app.locator('input[name="name"]').inputValue(),
    "Draft faction name",
  );
  await page.evaluate(() => {
    factionJourney.state.failSave = false;
  });
  await app.locator('[data-action="save"]').click();
  await page.waitForFunction(
    () => journey.settings.get("factions")[0].name === "Draft faction name",
  );
  const writes = await page.evaluate(() => factionJourney.state.writes);
  await navigate();
  await page.waitForFunction(() => factionJourney.state.opened === 2);
  assert.equal(await page.evaluate(() => factionJourney.state.writes), writes);
}
