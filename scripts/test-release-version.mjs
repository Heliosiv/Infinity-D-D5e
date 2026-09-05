import assert from "node:assert/strict";
import {
  parseReleaseVersion,
  compareReleaseVersions,
  validateReleaseVersion,
} from "./release-version.mjs";

const sequence = [
  "0.3.13",
  "0.3.14-alpha",
  "0.3.14-alpha.1",
  "0.3.14-alpha.beta",
  "0.3.14-beta",
  "0.3.14-preview.8",
  "0.3.14-preview.9",
  "0.3.14-preview.10",
  "0.3.14",
  "0.3.15",
];
for (let index = 1; index < sequence.length; index++) {
  assert.ok(
    compareReleaseVersions(
      parseReleaseVersion(sequence[index - 1]),
      parseReleaseVersion(sequence[index]),
    ) < 0,
  );
}
for (const invalid of [
  "0.3.14-junk..9",
  "0.3.14-preview.09",
  "00.3.14",
  "0.3.14tail",
  "0.3",
])
  assert.equal(parseReleaseVersion(invalid), null);
assert.equal(
  compareReleaseVersions(
    parseReleaseVersion("v0.3.14+build.2"),
    parseReleaseVersion("0.3.14+build.1"),
  ),
  0,
);
const previews = ["v0.3.14-preview.8", "v0.3.14-preview.9"];
assert.equal(
  validateReleaseVersion({
    version: "0.3.14-preview.9",
    tags: previews,
    headTags: [previews[1]],
    requireExactTag: true,
  }),
  previews[1],
);
assert.equal(
  validateReleaseVersion({
    version: "0.3.14",
    tags: previews,
    headTags: ["v0.3.14"],
    requireExactTag: true,
  }),
  previews[1],
);
assert.throws(
  () => validateReleaseVersion({ version: "0.3.14-preview.8", tags: previews }),
  /behind/,
);
assert.throws(
  () =>
    validateReleaseVersion({ version: "0.3.14-preview.10", tags: ["v0.3.14"] }),
  /behind/,
);
assert.throws(
  () =>
    validateReleaseVersion({
      version: "0.3.14-preview.9",
      tags: previews,
      headTags: [previews[0]],
      requireExactTag: true,
    }),
  /exact tag/,
);
assert.throws(
  () =>
    validateReleaseVersion({
      version: "0.3.15",
      tags: previews,
      requireExactTag: true,
    }),
  /exact tag/,
);
assert.throws(
  () =>
    validateReleaseVersion({
      version: "0.3.14",
      tags: [],
      requireExactTag: true,
    }),
  /exact tag/,
);
assert.doesNotThrow(() =>
  validateReleaseVersion({ version: "0.3.15", tags: previews }),
);
console.log("Release version ordering and exact-tag guards passed");
