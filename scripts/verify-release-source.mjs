import { spawnSync } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npmCommand, ["run", "verify:source"], {
  env: { ...process.env, INFINITY_REQUIRE_RELEASE_VERSION: "1" },
  stdio: "inherit",
});

process.exit(result.status ?? 1);
