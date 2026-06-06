/**
 * Tests for the shared `openItemByUuid` — the single source of truth for
 * the repo-wide double-click / single-click "open item" gesture. Stubs
 * `globalThis.fromUuid` so it runs without a Foundry runtime.
 */

import assert from "node:assert/strict";

import { openItemByUuid } from "./loot/loot-app-shared.js";

const savedFromUuid = globalThis.fromUuid;

// Empty / missing uuid → no-op, returns false, never throws.
assert.equal(await openItemByUuid(""), false);
assert.equal(await openItemByUuid(null), false);
assert.equal(await openItemByUuid(undefined), false);

// No fromUuid available (non-Foundry context) → false.
delete globalThis.fromUuid;
assert.equal(await openItemByUuid("Compendium.x.Item.y"), false);

// Resolves a doc with a sheet → renders it and fires onOpened.
let renderArg = null;
let opened = 0;
globalThis.fromUuid = async () => ({
  sheet: {
    render(arg) {
      renderArg = arg;
    },
  },
});
const ok = await openItemByUuid("Compendium.x.Item.y", {
  onOpened: () => {
    opened += 1;
  },
});
assert.equal(ok, true, "returns true when a sheet opens");
assert.equal(renderArg, true, "sheet.render(true) called");
assert.equal(opened, 1, "onOpened fired exactly once");

// Doc without a sheet → false, onOpened NOT fired.
let opened2 = 0;
globalThis.fromUuid = async () => ({});
assert.equal(
  await openItemByUuid("Compendium.x.Item.z", {
    onOpened: () => {
      opened2 += 1;
    },
  }),
  false,
);
assert.equal(opened2, 0, "onOpened not fired without a sheet");

// fromUuid throwing is swallowed → false (silence the expected warn).
{
  const realWarn = console.warn;
  console.warn = () => {};
  globalThis.fromUuid = async () => {
    throw new Error("boom");
  };
  try {
    assert.equal(await openItemByUuid("Compendium.x.Item.err"), false);
  } finally {
    console.warn = realWarn;
  }
}

if (savedFromUuid !== undefined) globalThis.fromUuid = savedFromUuid;
else delete globalThis.fromUuid;

process.stdout.write("dblclick-open validation passed\n");
