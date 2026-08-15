import assert from "node:assert/strict";

import {
  buildEnvironmentExport,
  downloadEnvironmentExport,
  environmentCatalogFingerprint,
  ENVIRONMENT_EXPORT_FILENAME,
  ENVIRONMENT_EXPORT_LIMIT,
  ENVIRONMENT_EXPORT_SCHEMA,
  planEnvironmentImport,
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
assert.deepEqual(Object.keys(exported).sort(), [
  "activeEnvironmentId",
  "environments",
  "schema",
]);
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
assert.equal(downloaded.reason, null);

assert.deepEqual(
  downloadEnvironmentExport({
    catalog: [builtIn],
    download() {
      throw new Error("empty exports must not call the downloader");
    },
  }),
  {
    ok: false,
    reason: "unavailable",
    data: {
      schema: ENVIRONMENT_EXPORT_SCHEMA,
      activeEnvironmentId: null,
      environments: [],
    },
    filename: ENVIRONMENT_EXPORT_FILENAME,
  },
);

let overflowDownloadCalled = false;
const overflowDownload = downloadEnvironmentExport({
  catalog: many,
  download() {
    overflowDownloadCalled = true;
    return true;
  },
});
assert.equal(overflowDownload.ok, false);
assert.equal(overflowDownload.reason, "limit-exceeded");
assert.equal(overflowDownloadCalled, false);

const freshImport = planEnvironmentImport(exported, [builtIn]);
assert.equal(freshImport.ok, true);
assert.deepEqual(freshImport.preview, {
  additions: 2,
  updates: 0,
  unchanged: 0,
  total: 2,
  recommendedActiveEnvironment: freshImport.imported[0].environment,
});
assert.deepEqual(
  freshImport.catalog.map((entry) => entry.id),
  [builtIn.id, ashen.id, riverCamp.id],
);
assert.equal(freshImport.catalog[0].builtIn, true);
assert.equal(freshImport.catalog[1].builtIn, false);

const updateFile = buildEnvironmentExport(
  [{ ...ashen, label: "Ashen March Revised", foodDc: 16, dc: 18 }],
  ashen.id,
);
const updatePlan = planEnvironmentImport(updateFile, [builtIn, ashen]);
assert.equal(updatePlan.ok, true);
assert.equal(updatePlan.preview.updates, 1);
assert.equal(updatePlan.preview.additions, 0);
assert.equal(updatePlan.catalog[1].label, "Ashen March Revised");
assert.equal(updatePlan.catalog[1].foodDc, 16);
assert.equal(
  planEnvironmentImport(buildEnvironmentExport([ashen]), [builtIn, ashen])
    .preview.unchanged,
  1,
);

for (const [label, invalid] of [
  ["wrong schema", { ...exported, schema: "other" }],
  ["empty file", { ...exported, environments: [] }],
  [
    "too many entries",
    {
      ...exported,
      environments: Array.from(
        { length: ENVIRONMENT_EXPORT_LIMIT + 1 },
        (_, index) => environment({ id: `too-many-${index}` }),
      ),
    },
  ],
  [
    "duplicate ids",
    { ...exported, environments: [ashen, { ...ashen, label: "Duplicate" }] },
  ],
  [
    "built-in collision",
    { ...exported, environments: [{ ...builtIn, builtIn: false }] },
  ],
  [
    "unsafe formula",
    {
      ...exported,
      environments: [{ ...ashen, yieldFood: "1d6 + @abilities.wis.mod" }],
    },
  ],
  [
    "unsafe id",
    { ...exported, environments: [{ ...ashen, id: "../../unsafe" }] },
  ],
  [
    "case collision",
    { ...exported, environments: [{ ...ashen, id: "ASHEN-MARCH" }] },
  ],
  [
    "missing active suggestion",
    { ...exported, activeEnvironmentId: "not-in-file" },
  ],
]) {
  const plan = planEnvironmentImport(invalid, [builtIn, ashen]);
  assert.equal(plan.ok, false, `${label} is rejected`);
  assert.deepEqual(
    plan.catalog,
    [builtIn, ashen],
    `${label} produces no partial catalog`,
  );
  assert.ok(plan.errors.length > 0, `${label} explains the validation failure`);
}

assert.equal(
  environmentCatalogFingerprint([builtIn, ashen]),
  environmentCatalogFingerprint([
    structuredClone(builtIn),
    structuredClone(ashen),
  ]),
);
assert.notEqual(
  environmentCatalogFingerprint([builtIn, ashen]),
  environmentCatalogFingerprint([builtIn, { ...ashen, foodDc: 17 }]),
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

process.stdout.write("resource environment portability validation passed\n");
