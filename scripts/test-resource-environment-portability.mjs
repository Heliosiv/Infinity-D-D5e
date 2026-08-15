import assert from "node:assert/strict";

import {
  buildEnvironmentExport,
  downloadEnvironmentExport,
  ENVIRONMENT_EXPORT_FILENAME,
  ENVIRONMENT_EXPORT_LIMIT,
  ENVIRONMENT_EXPORT_SCHEMA,
} from "./resource/environment-portability.js";

const builtIn = environment({ id: "limited", builtIn: true });
const ashen = environment({
  id: "ashen-march",
  label: "Ashen March",
  foodDc: 14,
  waterDc: 18,
  yieldFood: "2d4+1",
  yieldWater: "1d6",
});
const riverCamp = environment({
  id: "river-camp",
  label: "River Camp",
  foodDc: 10,
  waterDc: 8,
  yieldFood: "1d4",
  yieldWater: "1d8",
});

const exported = buildEnvironmentExport([builtIn, ashen, riverCamp], ashen.id);
assert.equal(exported.schema, ENVIRONMENT_EXPORT_SCHEMA);
assert.equal(exported.activeEnvironmentId, ashen.id);
assert.deepEqual(
  exported.environments.map((entry) => entry.id),
  [ashen.id, riverCamp.id],
  "exports preserve custom-region order and omit built-in presets",
);
assert.deepEqual(exported.environments[0], {
  id: "ashen-march",
  label: "Ashen March",
  dc: 18,
  foodDc: 14,
  waterDc: 18,
  forageable: true,
  yieldFood: "2d4+1",
  yieldWater: "1d6",
});
assert.equal(
  Object.hasOwn(exported.environments[0], "builtIn"),
  false,
  "portable data does not carry module-owned provenance",
);
assert.equal(
  buildEnvironmentExport([builtIn, ashen], "limited").activeEnvironmentId,
  null,
  "a built-in active id is not exported as portable custom state",
);

const many = Array.from({ length: ENVIRONMENT_EXPORT_LIMIT + 5 }, (_, index) =>
  environment({ id: `custom-${index}`, label: `Custom ${index}` }),
);
assert.equal(
  buildEnvironmentExport(many).environments.length,
  ENVIRONMENT_EXPORT_LIMIT,
  "portable files are bounded",
);

let observedDownload = null;
const downloaded = downloadEnvironmentExport({
  catalog: [builtIn, ashen],
  activeEnvironmentId: ashen.id,
  download(filename, data) {
    observedDownload = { filename, data };
    return true;
  },
});
assert.equal(downloaded.ok, true);
assert.equal(downloaded.filename, ENVIRONMENT_EXPORT_FILENAME);
assert.equal(observedDownload.filename, ENVIRONMENT_EXPORT_FILENAME);
assert.deepEqual(observedDownload.data, downloaded.data);

assert.deepEqual(
  downloadEnvironmentExport({
    catalog: [builtIn],
    download() {
      throw new Error("empty exports must not call the downloader");
    },
  }),
  {
    ok: false,
    data: {
      schema: ENVIRONMENT_EXPORT_SCHEMA,
      activeEnvironmentId: null,
      environments: [],
    },
    filename: ENVIRONMENT_EXPORT_FILENAME,
  },
);

function environment({
  id,
  label = id,
  builtIn = false,
  foodDc = 12,
  waterDc = 12,
  forageable = true,
  yieldFood = "1d6",
  yieldWater = "1d6",
}) {
  return {
    id,
    label,
    dc: Math.max(foodDc, waterDc),
    foodDc,
    waterDc,
    forageable,
    yieldFood,
    yieldWater,
    builtIn,
  };
}

process.stdout.write("resource environment portability export passed\n");
