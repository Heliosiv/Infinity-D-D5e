import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { buildUiHarnessDocument } from "./ui-harness.mjs";

const manifest = JSON.parse(readFileSync("module.json", "utf8"));
assert.equal(manifest.styles.at(-1), "styles/atlas.css");
const css = readFileSync("styles/atlas.css", "utf8");
const assets = [...css.matchAll(/url\("(\.\.\/assets\/ui\/[^"]+)"\)/g)];
assert.equal(assets.length, 10, "Atlas artwork and nine emblems must ship");
const harness = buildUiHarnessDocument();
let totalBytes = 0;
for (const [, relativePath] of assets) {
  const asset = path.resolve("styles", relativePath);
  const bytes = readFileSync(asset);
  totalBytes += statSync(asset).size;
  assert.ok(bytes.length > 0, `Empty UI asset: ${relativePath}`);
  // Exercise the actual harness embedding; missing art must not pass a visual audit.
  assert.ok(
    harness.includes(bytes.toString("base64")),
    `${relativePath} missing from harness`,
  );
  if (asset.endsWith(".svg")) {
    const source = bytes.toString("utf8");
    assert.match(source, /viewBox="0 0 64 64"/);
    assert.doesNotMatch(
      source,
      /<script|<foreignObject|\bon\w+=|(?:href|src)=/i,
    );
  } else {
    assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
    assert.equal(bytes.toString("ascii", 8, 12), "WEBP");
  }
}
assert.ok(totalBytes < 500_000, "Shared UI artwork must stay below 500 KB");
assert.doesNotMatch(harness, /url\("\.\.\/assets\/ui\//);
console.log(
  `UI assets verified: ${assets.length} local assets, ${totalBytes} bytes.`,
);
