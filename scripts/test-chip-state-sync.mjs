import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const CHECKS = [
  ["per-encounter loot", "scripts/app.js", "templates/loot-forge.hbs"],
  ["hoard loot", "scripts/hoard-loot.js", "templates/hoard-loot.hbs"],
  [
    "per-creature loot",
    "scripts/per-creature-loot.js",
    "templates/per-creature-loot.hbs",
  ],
];

for (const [name, file, template] of CHECKS) {
  const source = readFileSync(file, "utf8");
  assert.ok(
    source.includes('target.type === "checkbox"') &&
      source.includes('closest(".lf-chip")') &&
      source.includes('classList.toggle("is-checked", target.checked)'),
    `${name}: checkbox chips should sync the is-checked class without a full render`,
  );

  const templateSource = readFileSync(template, "utf8");
  assert.ok(
    !templateSource.includes('{{#if selected}}is-checked{{/if}}'),
    `${name}: chip templates should not render stale is-checked classes`,
  );
}

process.stdout.write("chip state sync validation passed\n");
