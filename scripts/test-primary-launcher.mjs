import assert from "node:assert/strict";

import { openInfinityPrimaryLauncher } from "./primary-launcher.js";

function fixture({ fullGm, state = "ready" }) {
  const calls = [];
  return {
    calls,
    bindings: {
      isFullGM: () => fullGm,
      getPrivateStateStatus: () => ({ state }),
      openPlayerLauncher: () => calls.push("player-launcher"),
      openCampaignRecovery: () => calls.push("campaign-recovery"),
      openGmWorkbench: () => calls.push("gm-workbench"),
    },
  };
}

{
  const current = fixture({ fullGm: true });
  openInfinityPrimaryLauncher(current.bindings);
  assert.deepEqual(current.calls, ["gm-workbench"]);
}

{
  const blocked = fixture({ fullGm: true, state: "blocked" });
  openInfinityPrimaryLauncher(blocked.bindings);
  assert.deepEqual(
    blocked.calls,
    ["campaign-recovery"],
    "fail-closed campaign state opens only the focused recovery window",
  );
}

for (const fullGm of [false, undefined]) {
  const player = fixture({ fullGm });
  openInfinityPrimaryLauncher(player.bindings);
  assert.deepEqual(player.calls, ["player-launcher"]);
}

process.stdout.write("primary launcher routing validation passed\n");
