import assert from "node:assert/strict";

import { openInfinityPrimaryLauncher } from "./primary-launcher.js";
import { isFullGM } from "./permissions.js";

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

/* Both GM profiles follow their current Foundry role, including role changes. */
{
  const originalGame = globalThis.game;
  const originalConst = globalThis.CONST;
  globalThis.CONST = { USER_ROLES: { GAMEMASTER: 4 } };
  try {
    for (const name of ["Gamemaster", "Test GM", "Another GM"]) {
      const user = { id: `user-${name}`, name, role: 3, isGM: true };
      globalThis.game = { user };
      const current = fixture({ fullGm: false });
      current.bindings.isFullGM = () => isFullGM();

      openInfinityPrimaryLauncher(current.bindings);
      assert.deepEqual(current.calls.splice(0), ["player-launcher"], name);

      user.role = 4;
      openInfinityPrimaryLauncher(current.bindings);
      assert.deepEqual(current.calls.splice(0), ["gm-workbench"], name);

      current.bindings.getPrivateStateStatus = () => ({ state: "blocked" });
      openInfinityPrimaryLauncher(current.bindings);
      assert.deepEqual(current.calls.splice(0), ["campaign-recovery"], name);

      user.role = 2;
      user.isGM = false;
      openInfinityPrimaryLauncher(current.bindings);
      assert.deepEqual(current.calls.splice(0), ["player-launcher"], name);
    }
  } finally {
    globalThis.game = originalGame;
    globalThis.CONST = originalConst;
  }
}

{
  const current = fixture({ fullGm: true, state: "blocked" });
  current.bindings.getPrivateStateStatus = () => ({
    state: "blocked",
    code: "vault-locked",
  });
  current.bindings.openPrivateVault = () => current.calls.push("vault");
  openInfinityPrimaryLauncher(current.bindings);
  assert.deepEqual(
    current.calls,
    ["vault"],
    "a locked vault must never offer an empty campaign replacement",
  );
}

process.stdout.write("primary launcher routing validation passed\n");
