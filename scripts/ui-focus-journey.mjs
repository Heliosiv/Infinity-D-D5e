import assert from "node:assert/strict";

/** Exercise the production render hooks against replacement DOM in Chromium. */
export async function auditRefreshFocus(page) {
  await page.evaluate(async () => {
    document.body.innerHTML = `<section id="focus-a" class="application infinity-dnd5e"><input name="query" value="abcdef"></section><section id="focus-b" class="application infinity-dnd5e"><input name="query" value="other"></section>`;
    const hooks = new Map();
    globalThis.Hooks = { on: (name, fn) => hooks.set(name, fn) };
    const { registerUiFoundationHooks } =
      await import("/scripts/infinity-app.js");
    registerUiFoundationHooks();
    globalThis.refreshFocusFixture = () => {
      const root = document.querySelector("#focus-a");
      root.innerHTML = '<input name="query" value="abcdef">';
      hooks.get("renderApplicationV2")({ element: root });
    };
  });
  const a = page.locator("#focus-a input");
  const b = page.locator("#focus-b input");
  await a.focus();
  await b.focus();
  await page.evaluate(() => refreshFocusFixture());
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(
    await b.evaluate((el) => el === document.activeElement),
    true,
    "background refresh must not steal focus from another window",
  );

  await a.focus();
  await a.evaluate((el) => {
    el.setSelectionRange(2, 4, "backward");
    el.dispatchEvent(new Event("select", { bubbles: true }));
  });
  await page.evaluate(() => refreshFocusFixture());
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.deepEqual(
    await a.evaluate((el) => [
      el === document.activeElement,
      el.selectionStart,
      el.selectionEnd,
      el.selectionDirection,
    ]),
    [true, 2, 4, "backward"],
    "refresh preserves the editing cursor and selection",
  );

  await page.evaluate(() => {
    refreshFocusFixture();
    document.querySelector("#focus-b input").focus();
  });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(
    await b.evaluate((el) => el === document.activeElement),
    true,
    "a queued restoration must respect newer user focus",
  );
  await a.focus();
  await page.evaluate(() => {
    refreshFocusFixture();
    document.querySelector("#focus-a input").disabled = true;
  });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(
    await a.evaluate((el) => el === document.activeElement),
    false,
    "a control disabled before restoration is never focused",
  );
  await page.evaluate(() => {
    document.querySelector("#focus-a input").disabled = false;
    document.querySelector("#focus-a input").focus();
    refreshFocusFixture();
    document.querySelector("#focus-a").remove();
  });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(
    await page.evaluate(() => document.activeElement === document.body),
    true,
    "closing a window while restoration is queued is safe",
  );
}
