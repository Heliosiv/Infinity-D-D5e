import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Handlebars from "handlebars";
import { buildHarnessViews } from "./ui-harness.mjs";

const fixtures = new Map(buildHarnessViews().map((view) => [view.id, view]));

function render(id) {
  const fixture = fixtures.get(id);
  assert.ok(fixture?.template, `missing ${id} fixture`);
  return Handlebars.compile(readFileSync(fixture.template, "utf8"))(
    fixture.context,
  );
}

for (const [waiting, ready, failed, message] of [
  [
    "shop-picker-loading",
    "shop-picker-empty",
    "shop-picker-error",
    "Loading open shops",
  ],
  [
    "resource-overview-loading",
    "resource-overview",
    "resource-overview-error",
    "Loading Party Supplies",
  ],
  [
    "reputation-view-loading",
    "reputation-view",
    "reputation-view-error",
    "Loading revealed reputations",
  ],
]) {
  const html = render(waiting);
  assert.match(html, /class="infinity-undead-loader" aria-hidden="true"/);
  assert.match(html, /aria-busy="true"/);
  assert.ok(html.includes(message), `${waiting}: missing accessible wait text`);
  for (const id of [ready, failed]) {
    assert.doesNotMatch(render(id), /class="infinity-undead-loader(?: |")/);
  }
}

assert.match(
  render("resource-overview-refreshing"),
  /infinity-undead-loader--inline/,
);
assert.match(
  render("resource-overview-refreshing"),
  /previous snapshot and may be out of date/,
);
assert.match(render("shop-picker"), /infinity-undead-loader--inline/);
assert.match(render("shop-picker"), /A shop request is waiting for the GM/);
assert.match(
  readFileSync("assets/ui/undead-loading-track.svg", "utf8"),
  /<svg /,
);

console.log("Player loading states and fallback messages passed.");
