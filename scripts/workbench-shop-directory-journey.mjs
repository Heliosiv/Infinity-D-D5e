import assert from "node:assert/strict";

/** Exercise the actual directory controls and canonical in-memory readback. */
export async function auditShopOrganization({
  page,
  directory,
  directoryAction,
  harbor,
  river,
}) {
  const shops = () => page.evaluate(() => journey.settings.get("merchants"));
  await directory.getByText("Manage location", { exact: true }).click();
  await directory.locator('[name="renameLocation"]').fill("Harbor Market");
  await directoryAction('[data-action="renameLocation"]');
  assert.equal(
    await directory.locator(".mw-location-heading h3").textContent(),
    "Harbor Market",
  );
  await directory.locator("[data-location-search]").fill("river");
  assert.equal(await directory.locator(".mw-location:visible").count(), 1);
  await directory.locator("[data-location-search]").fill("");
  await directory.locator("[data-merchant-filter]").selectOption("closed");
  assert.equal(await directory.locator(".mw-list__row:visible").count(), 0);
  assert.equal(
    await directory.locator("[data-merchant-no-match]").isVisible(),
    true,
  );
  await directory.locator("[data-merchant-filter]").selectOption("all");
  await directory.locator("[data-merchant-sort]").selectOption("name-desc");
  const names = await directory
    .locator(".mw-list__row:visible .mw-list__name")
    .allTextContents();
  assert.deepEqual(
    names,
    [...names].sort((a, b) => b.localeCompare(a)),
  );
  await directory.locator("[data-shop-select]").first().check();
  await directory.locator("[data-merchant-search]").fill("nothing matches");
  assert.equal(
    await directory.locator("[data-selection-count]").textContent(),
    "0 selected",
    "changing filters clears hidden selections",
  );
  await directory.locator("[data-merchant-search]").fill("");
  await directory.locator("[data-select-visible]").check();
  assert.equal(
    await directory.locator("[data-selection-count]").textContent(),
    "3 selected",
  );
  await directory.locator("[data-select-visible]").uncheck();
  const boxes = directory.locator("[data-shop-select]");
  const movedIds = [
    await boxes.nth(0).getAttribute("data-shop-select"),
    await boxes.nth(1).getAttribute("data-shop-select"),
  ];
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  const beforeMove = await shops();
  await directory.locator('[name="selectedDestination"]').selectOption(river);
  await directoryAction('[data-action="moveSelectedShops"]');
  const afterMove = await shops();
  for (const id of movedIds) {
    const before = beforeMove.find((row) => row.id === id);
    assert.deepEqual(
      afterMove.find((row) => row.id === id),
      { ...before, shop: { ...before.shop, locationId: river } },
    );
  }
  assert.equal(
    await page.evaluate(() => journey.app._selectedLocationId),
    river,
  );
  await directoryAction(
    `[data-action="selectLocation"][data-location-id="${harbor}"]`,
  );
  const remaining = (await shops()).find(
    (row) => row.shop?.locationId === harbor,
  );
  await directory.getByText("Manage location", { exact: true }).click();
  await directoryAction('[data-action="removeLocation"]');
  assert.equal(
    await directory.locator(".mw-location-heading h3").textContent(),
    "Unassigned shops",
  );
  assert.equal(
    await directory.locator(`[data-location-id="${harbor}"]`).count(),
    0,
  );
  assert.deepEqual(
    (await shops()).find((row) => row.id === remaining.id),
    { ...remaining, shop: { ...remaining.shop, locationId: "" } },
  );

  // Direct deletion works for unassigned shops and closes that shop's editor.
  await directoryAction(
    `[data-action="selectMerchant"][data-merchant-id="${remaining.id}"]`,
  );
  await page.waitForSelector(
    `#infinity-merchant-${remaining.id} input[name="name"]`,
  );
  await page.evaluate(() => {
    journey.state.autoConfirm = false;
    journey.state.confirmPending = false;
  });
  const beforeDelete = await shops();
  await directory
    .locator(
      `[data-action="deleteMerchant"][data-merchant-id="${remaining.id}"]`,
    )
    .click();
  await page.waitForFunction(() => journey.state.confirmPending);
  await page.evaluate(() => {
    journey.state.confirmPending = false;
    journey.state.confirm(false);
  });
  await page.waitForFunction(() => !journey.app._locationBusy);
  await page.evaluate(() => journey.app.rendering);
  assert.deepEqual(
    await shops(),
    beforeDelete,
    "cancelling deletion preserves every shop",
  );
  await page.evaluate(() => {
    journey.state.autoConfirm = true;
  });
  await directoryAction(
    `[data-action="deleteMerchant"][data-merchant-id="${remaining.id}"]`,
  );
  assert.ok(!(await shops()).some((row) => row.id === remaining.id));
  assert.equal(
    await page.locator(`#infinity-merchant-${remaining.id}`).isVisible(),
    false,
  );
  await directoryAction(
    `[data-action="selectLocation"][data-location-id="${river}"]`,
  );
  for (const id of movedIds)
    await directory.locator(`[data-shop-select="${id}"]`).check();
  const untouched = (await shops()).filter((row) => !movedIds.includes(row.id));
  await directoryAction('[data-action="deleteSelectedShops"]');
  assert.deepEqual(
    await shops(),
    untouched,
    "batch deletion affects only checked shops",
  );
  assert.equal(
    await directory.locator("[data-selection-count]").textContent(),
    "0 selected",
  );
  console.log(
    "Directory browser journey passed: rename/search/sort/filter/selection, exact moves, location removal, cancel and delete, editor cleanup.",
  );
}
