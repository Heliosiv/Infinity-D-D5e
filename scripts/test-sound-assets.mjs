import assert from "node:assert/strict";

import { SOUND_REGISTRY } from "./audio.js";
import { validateSoundAssets } from "./sound-pipeline.mjs";

const entries = Object.entries(SOUND_REGISTRY);
assert.equal(
  entries.length,
  21,
  "the semantic sound registry must contain 21 cues",
);

const seenFiles = new Set();
let expectedAssetCount = 0;
for (const [id, entry] of entries) {
  assert.equal(entry.id, id, `${id} registry id must match its key`);
  assert.ok(
    entry.files.length >= 2,
    `${id} must provide multiple real-take variants`,
  );
  assert.equal(
    entry.srcs.length,
    entry.files.length,
    `${id} files/srcs must align`,
  );
  assert.equal(
    entry.file,
    entry.files[0],
    `${id} compatibility file must be variant 01`,
  );
  assert.equal(
    entry.src,
    entry.srcs[0],
    `${id} compatibility src must be variant 01`,
  );
  for (const [variantIndex, file] of entry.files.entries()) {
    const expectedFile = `assets/sounds/${id}-${String(variantIndex + 1).padStart(2, "0")}.wav`;
    assert.equal(file, expectedFile, `${id} variant naming drifted`);
    assert.ok(!seenFiles.has(file), `${file} is registered more than once`);
    seenFiles.add(file);
  }
  expectedAssetCount += entry.files.length;
}
assert.equal(
  expectedAssetCount,
  51,
  "the registry must expose all 51 sound variants",
);

const report = validateSoundAssets();
assert.deepEqual(report, {
  assetCount: 51,
  eventCount: 21,
  sourceCount: 14,
});
