import assert from "node:assert/strict";

import {
  CRITICAL_INJURY_BODY_REGION_KEYS,
  CRITICAL_INJURY_BODY_REGIONS,
  indexCriticalInjuriesByBodyRegion,
  resolveCriticalInjuryBodyLocation,
} from "./injury/body-regions.js";

const expectedRegionKeys = [
  "head",
  "torso",
  "left-arm",
  "right-arm",
  "left-leg",
  "right-leg",
  "whole-body",
  "mind",
];

assert.deepEqual(CRITICAL_INJURY_BODY_REGION_KEYS, expectedRegionKeys);
assert.equal(
  new Set(CRITICAL_INJURY_BODY_REGIONS.map((region) => region.key)).size,
  expectedRegionKeys.length,
  "region metadata keys are unique",
);
assert.ok(
  CRITICAL_INJURY_BODY_REGIONS.every(
    (region) =>
      Object.isFrozen(region) &&
      region.label &&
      region.kind &&
      "side" in region,
  ),
  "each region exposes immutable presentation metadata",
);

const expectedDefaults = {
  "lost-limb": ["left-arm", "right-arm", "left-leg", "right-leg"],
  "crippling-injury": ["left-arm", "right-arm", "left-leg", "right-leg"],
  concussion: ["head"],
  "broken-arm": ["left-arm", "right-arm"],
  "fractured-ribs": ["torso"],
  "internal-bleeding": ["torso"],
  "deep-cut": ["whole-body"],
  "loss-of-eye": ["head"],
  "loss-of-hearing": ["head"],
  "shattered-knee": ["left-leg", "right-leg"],
  "dislocated-shoulder": ["left-arm", "right-arm"],
  infection: ["whole-body"],
  "minor-injury": ["whole-body"],
  "deep-scar": ["whole-body"],
  "psychic-trauma": ["mind"],
  "nerve-damage": ["whole-body"],
  nightmares: ["mind"],
  "soul-shaken": ["mind"],
};

for (const [injuryKey, regionKeys] of Object.entries(expectedDefaults)) {
  const resolved = resolveCriticalInjuryBodyLocation({ injuryKey });
  assert.deepEqual(
    resolved.regionKeys,
    regionKeys,
    `${injuryKey} body regions`,
  );
  assert.ok(
    resolved.regionKeys.every((key) => expectedRegionKeys.includes(key)),
    `${injuryKey} uses only known region keys`,
  );
}

const bodyParts = [
  ["left-arm", "arm", "Left arm"],
  ["right-arm", "arm", "Right arm"],
  ["left-leg", "leg", "Left leg"],
  ["right-leg", "leg", "Right leg"],
];
for (const [key, kind, label] of bodyParts) {
  const resolved = resolveCriticalInjuryBodyLocation({
    injuryKey: "lost-limb",
    detail: { type: "body-part", key, kind },
  });
  assert.deepEqual(resolved.regionKeys, [key]);
  assert.equal(resolved.locationLabel, label);
  assert.equal(resolved.specificity, "exact");
  assert.equal(resolved.source, "detail");
}

assert.deepEqual(
  resolveCriticalInjuryBodyLocation({
    injuryKey: "crippling-injury",
    detail: {
      type: "body-part",
      key: "injured-arm",
      label: "Injured arm",
      kind: "arm",
    },
  }).regionKeys,
  ["left-arm", "right-arm"],
  "a treated Broken Arm remains available from either arm hotspot",
);
assert.deepEqual(
  resolveCriticalInjuryBodyLocation({
    injuryKey: "lost-limb",
    detail: { type: "body-part", key: "unknown", kind: "leg" },
  }).regionKeys,
  ["left-leg", "right-leg"],
  "a known limb kind remains useful when its side is unavailable",
);
assert.equal(
  resolveCriticalInjuryBodyLocation({ injuryKey: "lost-limb" }).source,
  "missing-detail",
);
assert.equal(
  resolveCriticalInjuryBodyLocation({ injuryKey: "broken-arm" }).specificity,
  "unspecified-side",
);
assert.deepEqual(
  resolveCriticalInjuryBodyLocation({ injuryKey: "Concussion" }).regionKeys,
  ["head"],
  "presentation mapping is insensitive to key casing",
);
assert.deepEqual(
  resolveCriticalInjuryBodyLocation({
    injuryKey: "shattered-knee",
    detail: { type: "body-part", key: "left-arm", kind: "arm" },
  }).regionKeys,
  ["left-leg", "right-leg"],
  "a mismatched detail cannot move a knee injury to an arm",
);

for (const ability of ["str", "dex", "con"]) {
  const resolved = resolveCriticalInjuryBodyLocation({
    injuryKey: "nerve-damage",
    detail: { type: "ability", key: ability },
  });
  assert.deepEqual(resolved.regionKeys, ["whole-body"]);
  assert.equal(resolved.source, "ability-detail");
}
for (const ability of ["int", "wis", "cha"]) {
  const resolved = resolveCriticalInjuryBodyLocation({
    injuryKey: "nerve-damage",
    detail: { type: "ability", key: ability },
  });
  assert.deepEqual(resolved.regionKeys, ["mind"]);
  assert.equal(resolved.source, "ability-detail");
}
assert.equal(
  resolveCriticalInjuryBodyLocation({
    injuryKey: "nerve-damage",
    detail: { type: "ability", key: "unknown" },
  }).specificity,
  "fallback",
);

for (const amount of [1, 6, 99]) {
  assert.deepEqual(
    resolveCriticalInjuryBodyLocation({
      injuryKey: "deep-cut",
      detail: { type: "max-hp-loss", key: "max-hp-loss", amount },
    }).regionKeys,
    ["whole-body"],
    "Deep Cut amount does not invent a wound location",
  );
}

assert.deepEqual(
  resolveCriticalInjuryBodyLocation({ injuryKey: "not-in-v2" }),
  {
    regionKeys: ["whole-body"],
    locationLabel: "Whole body",
    specificity: "fallback",
    source: "fallback",
  },
  "unknown injuries stay visible through the safe whole-body fallback",
);
assert.deepEqual(
  resolveCriticalInjuryBodyLocation(null).regionKeys,
  ["whole-body"],
  "malformed input never throws or disappears",
);

const headOne = { id: "injury-head-1", injuryKey: "concussion" };
const headTwo = { id: "injury-head-2", injuryKey: "loss-of-eye" };
const knee = { id: "injury-knee", injuryKey: "shattered-knee" };
const regions = indexCriticalInjuriesByBodyRegion([
  headOne,
  knee,
  headTwo,
  { ...headOne },
]);

assert.deepEqual(Object.keys(regions), expectedRegionKeys);
assert.deepEqual(
  regions.head,
  [headOne, headTwo],
  "same-region injuries preserve input order and duplicate ids are ignored",
);
assert.deepEqual(regions["left-leg"], [knee]);
assert.deepEqual(regions["right-leg"], [knee]);
assert.deepEqual(regions["whole-body"], []);
assert.ok(
  Object.values(indexCriticalInjuriesByBodyRegion(null)).every(
    (injuries) => injuries.length === 0,
  ),
  "an absent injury list produces a complete empty index",
);

process.stdout.write("critical injury body region validation passed\n");
