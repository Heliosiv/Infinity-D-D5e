/**
 * Lint player-visible description HTML for leaked dev-notes, placeholders,
 * empty labels, unresolved templates, and UTF-8 mojibake.
 *
 * These all shipped pack-wide once (the asset-pipeline "Planned icon" note on
 * every item, empty "Rarity:" lines on 251 items, double-encoded minus signs);
 * this check keeps them from creeping back in.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PACK_PATH = "packs/infinity-dnd5e-items.db";
const items = readFileSync(PACK_PATH, "utf8")
  .split(/\r?\n/)
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));

const DENY = [
  [/Planned icon/i, "asset-pipeline dev-note 'Planned icon'"],
  [/Icon plan/i, "asset-pipeline dev-note 'Icon plan'"],
  [
    /shared asset|bespoke asset/i,
    "asset-pipeline dev-note 'shared/bespoke asset'",
  ],
  [/\bTODO\b|\bFIXME\b|\bXXX\b/, "developer marker"],
  [/lorem ipsum/i, "placeholder lorem text"],
  [/\{\{[^}]*\}\}/, "unresolved Handlebars template"],
  [/<li>Rarity:\s*<\/li>/, "empty 'Rarity:' label"],
  // mojibake: UTF-8 bytes mis-decoded as CP1252 then re-encoded.
  [/â(?:€|ˆ|…)|Ã(?:—|¶)/, "mojibake / encoding artifact"],
];

const offenders = [];
for (const item of items) {
  const texts = [
    item.system?.description?.value,
    item.system?.description?.chat,
    item.system?.unidentified?.description,
  ].filter(Boolean);
  for (const text of texts) {
    let hit = null;
    for (const [re, label] of DENY) {
      if (re.test(text)) {
        hit = label;
        break;
      }
    }
    if (hit) {
      offenders.push(`${item.name} (${item._id}): ${hit}`);
      break;
    }
  }
}

assert.equal(
  offenders.length,
  0,
  `description quality issues:\n  ${offenders.slice(0, 40).join("\n  ")}${
    offenders.length > 40 ? `\n  ...and ${offenders.length - 40} more` : ""
  }`,
);

process.stdout.write(
  `pack description check passed (${items.length} items clean)\n`,
);
