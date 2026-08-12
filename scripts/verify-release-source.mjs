import { spawnSync } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npmCommand, ["run", "verify:source"], {
  env: { ...process.env, INFINITY_REQUIRE_RELEASE_VERSION: "1" },
  // Node 24 no longer launches .cmd shims directly through spawnSync on
  // Windows. The command and arguments are fixed, so routing only that
  // platform through cmd.exe is both bounded and portable across npm installs.
  shell: process.platform === "win32",
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
