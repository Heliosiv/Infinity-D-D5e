import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { navigateToAppSection } from "./infinity-app.js";

const templateFiles = readdirSync("templates", { recursive: true })
  .filter((name) => String(name).endsWith(".hbs"))
  .map((name) => path.join("templates", String(name)));

for (const file of templateFiles) {
  const source = readFileSync(file, "utf8");
  assert.doesNotMatch(
    source,
    /<a\b[^>]*\bhref\s*=\s*["']#/i,
    `${file} must use an in-window button action instead of a hash anchor`,
  );
}

for (const file of [
  "templates/reputation-workspace.hbs",
  "templates/merchant-workspace.hbs",
  "templates/resource-manager.hbs",
  "templates/settings.hbs",
]) {
  const source = readFileSync(file, "utf8");
  assert.match(source, /data-action="selectSection"/);
  for (const match of source.matchAll(
    /<button\b(?=[^>]*data-action="selectSection")[^>]*>/g,
  )) {
    assert.match(match[0], /\btype="button"/);
    const sectionTarget = match[0].match(
      /\bdata-section-target="([^"]+)"/,
    )?.[1];
    const controlledId = match[0].match(/\baria-controls="([^"]+)"/)?.[1];
    assert.ok(sectionTarget, `${file} section buttons identify their target`);
    assert.equal(
      controlledId,
      sectionTarget,
      `${file} section buttons control the section they navigate to`,
    );
    const idIndex = source.indexOf(`id="${sectionTarget}"`);
    assert.ok(idIndex >= 0, `${file} includes section ${sectionTarget}`);
    const targetTag = source.slice(
      source.lastIndexOf("<", idIndex),
      source.indexOf(">", idIndex) + 1,
    );
    assert.match(
      targetTag,
      /\btabindex="-1"/,
      `${file} section ${sectionTarget} accepts programmatic focus`,
    );
  }
}

{
  const calls = [];
  const section = {
    scrollIntoView(options) {
      calls.push(["scroll", options]);
    },
    focus(options) {
      calls.push(["focus", options]);
    },
  };
  const app = {
    element: {
      querySelector(selector) {
        calls.push(["query", selector]);
        return selector === "#rw-section-history" ? section : null;
      },
    },
  };
  let prevented = false;
  const navigated = navigateToAppSection.call(
    app,
    {
      preventDefault() {
        prevented = true;
      },
    },
    { dataset: { sectionTarget: "rw-section-history" } },
  );
  assert.equal(navigated, true);
  assert.equal(prevented, true);
  assert.deepEqual(calls, [
    ["query", "#rw-section-history"],
    ["scroll", { block: "start", inline: "nearest" }],
    ["focus", { preventScroll: true }],
  ]);

  assert.equal(
    navigateToAppSection.call(app, null, {
      dataset: { sectionTarget: "missing" },
    }),
    false,
  );
  assert.equal(navigateToAppSection.call(app, null, { dataset: {} }), false);
}

{
  const calls = [];
  let isOpen = false;
  const disclosure = {
    tagName: "DETAILS",
    get open() {
      return isOpen;
    },
    set open(value) {
      isOpen = value;
      calls.push(["open", value]);
    },
    scrollIntoView(options) {
      calls.push(["scroll", options]);
    },
    focus(options) {
      calls.push(["focus", options]);
    },
  };
  const app = {
    element: {
      querySelector(selector) {
        calls.push(["query", selector]);
        return disclosure;
      },
    },
  };

  assert.equal(
    navigateToAppSection.call(app, null, {
      dataset: { sectionTarget: "rm-setup" },
    }),
    true,
  );
  assert.equal(isOpen, true);
  assert.deepEqual(calls, [
    ["query", "#rm-setup"],
    ["open", true],
    ["scroll", { block: "start", inline: "nearest" }],
    ["focus", { preventScroll: true }],
  ]);
}

process.stdout.write("in-window section navigation validation passed\n");
