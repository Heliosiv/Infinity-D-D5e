import assert from "node:assert/strict";
import { downtimeLocationActivityIds } from "./downtime/location-presets.js";
import { defaultGuidedDowntimeTemplates } from "./downtime/dispatch.js";
import { normalizeSettlementProfile } from "./downtime/settlements.js";
const library = [
  ...defaultGuidedDowntimeTemplates(),
  { id: "custom-campaign" },
];
for (const preset of ["adventuring", "wilderness"]) {
  const ids = downtimeLocationActivityIds(library, preset);
  assert(!ids.includes("guided-performance"));
  assert(!ids.includes("guided-labor"));
  assert(ids.includes("guided-reflection"));
  assert(!ids.includes("custom-campaign"));
}
assert(
  downtimeLocationActivityIds(library, "town").includes("guided-performance"),
);
const profile = normalizeSettlementProfile({
  id: "haven",
  name: "Haven",
  locationPresetId: "village",
  guidedTemplateIds: ["guided-performance", "custom-campaign"],
  linkedMerchantIds: ["shop-one"],
});
assert.deepEqual(downtimeLocationActivityIds(library, "village", profile), [
  "guided-performance",
  "custom-campaign",
]);
assert.deepEqual(profile.linkedMerchantIds, ["shop-one"]);
assert.deepEqual(normalizeSettlementProfile(profile), profile);
assert.deepEqual(
  downtimeLocationActivityIds(library, "town", { guidedTemplateIds: [] }),
  [],
);
assert.throws(
  () => downtimeLocationActivityIds(library, "invalid"),
  /valid location/,
);
console.log("Downtime location presets passed.");
