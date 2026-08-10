import assert from "node:assert/strict";

import { verifyReleaseUrls } from "./verify-release-artifact.mjs";

const version = "0.3.2";
const repository = "Heliosiv/Infinity-D-D5e";
const githubManifest = {
  url: `https://github.com/${repository}`,
  manifest: `https://github.com/${repository}/releases/latest/download/module.json`,
  download: `https://github.com/${repository}/releases/download/v${version}/module.zip`,
};

assert.doesNotThrow(() =>
  verifyReleaseUrls(githubManifest, { repository: "", version }),
);
assert.doesNotThrow(() =>
  verifyReleaseUrls(githubManifest, { repository, version }),
);

const customManifest = {
  url: "https://downloads.example.test/infinity-dnd5e",
  manifest: "http://updates.example.test/foundry/module.json",
  download: `https://cdn.example.test/foundry/${version}/infinity-dnd5e.zip`,
};
assert.doesNotThrow(() =>
  verifyReleaseUrls(customManifest, { repository: "", version }),
);
assert.throws(
  () => verifyReleaseUrls(customManifest, { repository, version }),
  /Packaged homepage URL must be/,
);

for (const [label, patch, expected] of [
  ["blank", { manifest: "" }, /updater manifest URL is blank/],
  [
    "relative",
    { download: "downloads/module.zip" },
    /must be an absolute http\(s\) URL/,
  ],
  ["protocol", { url: "file:///module" }, /must use http or https/],
  [
    "credentials",
    { url: "https://build-user:secret@example.test/module" },
    /must not contain credentials/,
  ],
  [
    "placeholder",
    { download: "https://cdn.example.test/v{version}/module.zip" },
    /unresolved \{version\} placeholder/,
  ],
  [
    "encoded placeholder",
    { download: "https://cdn.example.test/v%7Bversion%7D/module.zip" },
    /unresolved \{version\} placeholder/,
  ],
]) {
  assert.throws(
    () =>
      verifyReleaseUrls(
        { ...customManifest, ...patch },
        { repository: "", version },
      ),
    expected,
    `${label} custom release URL must fail closed`,
  );
}

process.stdout.write("release artifact URL validation passed\n");
