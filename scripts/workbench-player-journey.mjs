/** Player request/recovery segment of the local Workbench browser gauntlet. */
import assert from "node:assert/strict";
import path from "node:path";

export async function auditPlayerRequests(page, width, out) {
  await page.evaluate(async () => {
    const { ShopPickerApp } = await import("/scripts/shop-picker.js");
    const { ResourceOverviewApp } =
      await import("/scripts/resource-overview.js");
    const actor = {
      id: "hero",
      name: "Mira",
      type: "character",
      ownership: { player: 3 },
    };
    const player = {
      id: "player",
      name: "Player",
      role: 1,
      isGM: false,
      active: true,
      character: actor,
    };
    game.users.push(player);
    game.user = player;
    game.actors = { contents: [actor] };
    const state = { mode: "throw", sends: 0, actions: 0 };
    game.socket.emit = (_channel, payload) => {
      state.sends++;
      if (state.mode === "throw")
        throw new Error("Injected connection interruption");
      if (state.mode === "silent") return;
      const app = journey.playerApp;
      if (payload.type === "merchant:shop-list-request") {
        app._onShopList({
          targetUserId: player.id,
          shops: [
            {
              id: "shop",
              name: "Wayfarer Supplies",
              description: "Tools for the road",
              selfServiceMode: "open",
            },
          ],
        });
      } else if (payload.type === "merchant:shop-request") {
        app._onShopResult({
          targetUserId: player.id,
          merchantId: "shop",
          outcome: "denied",
        });
      } else if (payload.type === "resource:overview-request") {
        app._onOverviewReply({
          targetUserId: player.id,
          requestId: payload.requestId,
          enabled: true,
          overview: { partySize: 2, generatedAt: Date.now(), resources: [] },
        });
      }
    };
    async function mount(surface) {
      if (journey.playerApp) journey.playerApp._onClose({});
      const previous = document.getElementById("app");
      const element = previous.cloneNode(false);
      previous.replaceWith(element);
      element.hidden = false;
      element.className = `infinity-dnd5e infinity-${surface}`;
      element.innerHTML = '<div class="application-content"></div>';
      const Type =
        surface === "shop-picker" ? ShopPickerApp : ResourceOverviewApp;
      const app = Object.create(Type.prototype);
      Object.assign(app, {
        element,
        rendered: true,
        _unsubs: [],
        _shops: [],
        _query: "",
        _pending: new Set(),
        _reviewIdentities: new Map(),
        _loading: false,
        _loadTimer: null,
        _requestTimer: null,
        _requestId: null,
        _overview: null,
        _sharingEnabled: true,
      });
      app.render = () => {
        app.rendering = (app.rendering ?? Promise.resolve()).then(async () => {
          const context = await app._prepareContext();
          const response = await fetch(`/render/${surface}`, {
            method: "POST",
            body: JSON.stringify(context),
          });
          element.querySelector(".application-content").innerHTML =
            await response.text();
          app._onRender?.(context, {});
        });
        return app.rendering;
      };
      element.addEventListener("click", async (event) => {
        const button = event.target.closest("[data-action]");
        if (!button || button.disabled) return;
        try {
          await Type.DEFAULT_OPTIONS.actions[button.dataset.action].call(
            app,
            event,
            button,
          );
          state.actions++;
        } catch (error) {
          state.error = error.message;
        }
      });
      journey.playerApp = app;
      state.mode = "throw";
      if (surface === "shop-picker") app._requestList();
      else app._loadOverview();
      await app.render();
    }
    journey.playerState = state;
    journey.mountPlayer = mount;
  });
  const click = async (action) => {
    const before = await page.evaluate(() => journey.playerState.actions);
    await page.locator(`[data-action="${action}"]`).first().click();
    await page.waitForFunction(
      (before) =>
        journey.playerState.actions > before || journey.playerState.error,
      before,
    );
    assert.equal(
      await page.evaluate(() => journey.playerState.error ?? ""),
      "",
    );
    await page.evaluate(() => journey.playerApp.rendering);
  };
  for (const surface of ["shop-picker", "resource-overview"]) {
    await page.evaluate((surface) => journey.mountPlayer(surface), surface);
    assert.equal(
      await page.evaluate(() => journey.playerApp._requestFailed),
      true,
    );
    assert.equal(
      await page.locator('[data-action="refresh"]').first().isEnabled(),
      true,
    );
    assert.equal(await page.locator('[aria-busy="true"]').count(), 0);
    assert.match(await page.locator("#app").innerText(), /Try again|retry/i);
    await page.locator("#app").screenshot({
      path: path.join(out, `${surface}-request-error-${width}.png`),
    });

    // A quick reply must settle loading and clear the already-armed watchdog.
    await page.evaluate(() => {
      journey.playerState.mode = "reply";
    });
    await click("refresh");
    assert.equal(await page.evaluate(() => journey.playerApp._loading), false);
    assert.equal(
      await page.evaluate(() => journey.playerApp._requestFailed),
      false,
    );
    assert.equal(
      await page.evaluate(
        () => journey.playerApp._requestTimer ?? journey.playerApp._loadTimer,
      ),
      null,
    );
    if (surface === "resource-overview") {
      assert.equal(
        await page.evaluate(() => journey.playerApp._overview.partySize),
        2,
      );
      continue;
    }
    assert.match(await page.locator("#app").innerText(), /Wayfarer Supplies/);
    await page.evaluate(() => {
      journey.playerState.mode = "throw";
    });
    await click("openShop");
    assert.equal(await page.evaluate(() => journey.playerApp._pending.size), 0);
    assert.equal(
      await page.locator('[data-action="openShop"]').isEnabled(),
      true,
    );
    assert.match(
      await page.locator("#notices").textContent(),
      /could not be sent/,
    );
    await page.evaluate(() => {
      journey.playerState.mode = "reply";
    });
    await click("openShop");
    assert.equal(await page.evaluate(() => journey.playerApp._pending.size), 0);
    assert.match(
      await page.locator("#notices").textContent(),
      /turned you away/,
    );
    await page.evaluate(() => {
      journey.playerState.mode = "silent";
    });
    const sends = await page.evaluate(() => journey.playerState.sends);
    await click("openShop");
    assert.equal(
      await page.evaluate(() => journey.playerState.sends),
      sends + 1,
    );
    assert.equal(
      await page.locator('[data-action="openShop"]').isDisabled(),
      true,
    );
  }
  await page.evaluate(() => journey.playerApp._onClose({}));
  console.log(
    `Player request journeys passed at ${width}px: Shops and Party Supplies send failures, refresh recovery, quick replies, entry retry, and pending controls.`,
  );
}
