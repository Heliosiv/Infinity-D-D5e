import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { bindFullGmWindowGuard } from "./infinity-app.js";

function createHooks() {
  let nextId = 1;
  const listeners = new Map();
  return {
    on(event, handler) {
      const id = nextId++;
      listeners.set(id, { event, handler });
      return id;
    },
    off(event, id) {
      if (listeners.get(id)?.event === event) listeners.delete(id);
    },
    call(event, ...args) {
      for (const listener of listeners.values()) {
        if (listener.event === event) listener.handler(...args);
      }
    },
    listenerCount(event) {
      return [...listeners.values()].filter(
        (listener) => listener.event === event,
      ).length;
    },
  };
}

/* A current-user demotion closes the window; unrelated user changes do not. */
{
  const originalGame = globalThis.game;
  const originalConst = globalThis.CONST;
  const originalHooks = globalThis.Hooks;
  const hooks = createHooks();
  const currentUser = { id: "gm-1", isGM: true, role: 4 };
  let closeCalls = 0;

  globalThis.game = { user: currentUser };
  globalThis.CONST = { USER_ROLES: { GAMEMASTER: 4 } };
  globalThis.Hooks = hooks;

  try {
    const unbind = bindFullGmWindowGuard({
      close: async () => {
        closeCalls += 1;
      },
    });
    assert.equal(hooks.listenerCount("updateUser"), 1);

    hooks.call("updateUser", { id: "other-user", isGM: true, role: 3 });
    hooks.call("updateUser", { id: currentUser.id, isGM: true, role: 4 });
    assert.equal(closeCalls, 0);

    hooks.call("updateUser", { id: currentUser.id, isGM: true, role: 3 });
    await Promise.resolve();
    assert.equal(
      closeCalls,
      1,
      "Assistant-GM demotion closes a privileged window",
    );

    unbind();
    unbind();
    assert.equal(hooks.listenerCount("updateUser"), 0);
    hooks.call("updateUser", { id: currentUser.id, isGM: false, role: 1 });
    assert.equal(closeCalls, 1, "an unbound guard cannot close twice");
  } finally {
    if (originalGame === undefined) delete globalThis.game;
    else globalThis.game = originalGame;
    if (originalConst === undefined) delete globalThis.CONST;
    else globalThis.CONST = originalConst;
    if (originalHooks === undefined) delete globalThis.Hooks;
    else globalThis.Hooks = originalHooks;
  }
}

/* Every full-GM window binds the shared lifecycle guard. */
for (const file of [
  "scripts/dashboard.js",
  "scripts/loot/loot-app-base.js",
  "scripts/merchant-workspace.js",
  "scripts/reputation-workspace.js",
  "scripts/downtime-workspace.js",
]) {
  assert.match(
    readFileSync(file, "utf8"),
    /bindFullGmWindowGuard\(this\)/,
    `${file} should close when the current user stops being a full GM`,
  );
}

const merchantWorkspace = readFileSync("scripts/merchant-workspace.js", "utf8");
const reputationWorkspace = readFileSync(
  "scripts/reputation-workspace.js",
  "utf8",
);
const downtimeWorkspace = readFileSync("scripts/downtime-workspace.js", "utf8");
for (const [label, source] of [
  ["Merchant Workspace", merchantWorkspace],
  ["Reputation Workspace", reputationWorkspace],
]) {
  assert.match(
    source,
    /static open\(\) \{[\s\S]*?return runAsFullGM\(/,
    `${label} should reject Assistant GMs before constructing its editor`,
  );
  assert.doesNotMatch(
    source,
    /static open\(\) \{[\s\S]{0,300}?game\?\.user\?\.isGM/,
    `${label} should not use Foundry's broader isGM flag as its open gate`,
  );
}

assert.match(
  downtimeWorkspace,
  /static open\(\{[\s\S]*?return runAsFullGM\(/,
  "Downtime Workspace should reject Assistant GMs before constructing its editor",
);
assert.doesNotMatch(
  downtimeWorkspace,
  /static open\(\{[\s\S]{0,500}?game\?\.user\?\.isGM/,
  "Downtime Workspace should not use Foundry's broader isGM flag as its open gate",
);

const merchantSession = readFileSync("scripts/merchant-session.js", "utf8");
assert.match(
  merchantSession,
  /this\._previewMode\s*\?\s*bindFullGmWindowGuard\(this\)/,
  "a full-data GM merchant preview should close on role demotion",
);

process.stdout.write("privileged window validation passed\n");
