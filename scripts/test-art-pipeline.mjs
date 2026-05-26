import assert from "node:assert/strict";

import {
  ART_CONFIG,
  buildArtJobs,
  getPlannedAssets,
  loadArtPlan,
  readWebpDimensions,
  validatePlanShape,
} from "./art-pipeline.mjs";

const plan = await loadArtPlan();
validatePlanShape(plan);

const sharedJobs = buildArtJobs(plan, { kind: "shared" });
const uniqueJobs = buildArtJobs(plan, { kind: "unique" });
const allAssets = getPlannedAssets(plan);

assert.equal(sharedJobs.length, plan.counts.sharedAssets);
assert.equal(uniqueJobs.length, plan.counts.uniqueAssets);
assert.equal(allAssets.length, plan.counts.totalAssetsToGenerate);

for (const { job } of [...sharedJobs, ...uniqueJobs]) {
  assert.ok(job.prompt.includes("Foundry VTT item icon"));
  assert.equal(job.model, ART_CONFIG.model);
  assert.equal(job.quality, ART_CONFIG.quality);
  assert.equal(job.size, ART_CONFIG.size);
  assert.equal(job.output_format, ART_CONFIG.outputFormat);
  assert.equal(job.background, ART_CONFIG.background);
  assert.equal(job.n, 1);
  assert.equal(job.out, job.out.replace(/[\\/]/g, ""));
  assert.ok(job.out.endsWith(".webp"));
}

const vp8x = Buffer.alloc(30);
vp8x.write("RIFF", 0, "ascii");
vp8x.writeUInt32LE(vp8x.length - 8, 4);
vp8x.write("WEBP", 8, "ascii");
vp8x.write("VP8X", 12, "ascii");
vp8x.writeUInt32LE(10, 16);
writeUInt24LE(vp8x, 24, 1023);
writeUInt24LE(vp8x, 27, 1023);

assert.deepEqual(readWebpDimensions(vp8x), {
  width: 1024,
  height: 1024,
  chunk: "VP8X",
});

assert.throws(
  () => readWebpDimensions(Buffer.from("not a webp")),
  /not a RIFF WebP file/,
);

process.stdout.write("art-pipeline validation passed\n");

function writeUInt24LE(buffer, offset, value) {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >> 8) & 0xff;
  buffer[offset + 2] = (value >> 16) & 0xff;
}
