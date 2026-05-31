import assert from "node:assert/strict";

import { SOUND_EVENTS } from "./audio.js";
import {
  registerSoundAutomation,
  resetSoundAutomationForTests,
} from "./compat/sound-automation.js";

function makeHooks() {
  const listeners = new Map();
  return {
    listeners,
    on(name, callback) {
      const entries = listeners.get(name) ?? [];
      entries.push(callback);
      listeners.set(name, entries);
    },
    call(name, ...args) {
      for (const callback of listeners.get(name) ?? []) callback(...args);
    },
  };
}

function installFoundryGlobals({ activeModules = [] } = {}) {
  const socketPayloads = [];
  const audioCalls = [];
  const modules = new Map(
    activeModules.map((moduleId) => [moduleId, { active: true }]),
  );
  globalThis.game = {
    modules,
    settings: {
      get(moduleId, key) {
        if (moduleId !== "infinity-dnd5e") return undefined;
        if (key === "soundsEnabled") return true;
        if (key === "automationSoundsEnabled") return true;
        if (key === "soundVolume") return 0.5;
        return undefined;
      },
    },
    socket: {
      emit(channel, payload) {
        socketPayloads.push({ channel, payload });
      },
    },
    user: { id: "tester" },
  };
  globalThis.AudioHelper = {
    play(data) {
      audioCalls.push(data);
      return { id: data.src };
    },
  };
  globalThis.setTimeout = (callback) => {
    callback();
    return 1;
  };
  return { audioCalls, socketPayloads };
}

function restoreFoundryGlobals(originals) {
  if (originals.game === undefined) delete globalThis.game;
  else globalThis.game = originals.game;
  if (originals.AudioHelper === undefined) delete globalThis.AudioHelper;
  else globalThis.AudioHelper = originals.AudioHelper;
  if (originals.Sequencer === undefined) delete globalThis.Sequencer;
  else globalThis.Sequencer = originals.Sequencer;
  globalThis.setTimeout = originals.setTimeout;
}

function makeItem(overrides = {}) {
  return {
    id: overrides.id ?? "item-a",
    name: overrides.name ?? "Test Wand",
    type: overrides.type ?? "spell",
    uuid: overrides.uuid ?? `Item.${overrides.id ?? "item-a"}`,
    system: {
      rarity: overrides.rarity ?? "common",
      ...(overrides.system ?? {}),
    },
    flags: overrides.flags ?? {},
  };
}

function makeActivity(item, overrides = {}) {
  return {
    id: overrides.id ?? "activity-a",
    item,
    parent: item,
    range: overrides.range ?? { value: 30, units: "ft" },
    target: overrides.target ?? {},
    type: overrides.type ?? "attack",
    flags: overrides.flags ?? {},
  };
}

function eventKeys(socketPayloads) {
  return socketPayloads.map((entry) => entry.payload.eventKey);
}

{
  const originals = {
    AudioHelper: globalThis.AudioHelper,
    game: globalThis.game,
    Sequencer: globalThis.Sequencer,
    setTimeout: globalThis.setTimeout,
  };
  try {
    const hooks = makeHooks();
    const { socketPayloads } = installFoundryGlobals();
    resetSoundAutomationForTests(hooks);
    assert.equal(
      registerSoundAutomation({ hooks, gameRef: globalThis.game }),
      true,
    );

    const item = makeItem({ type: "weapon" });
    hooks.call("dnd5e.preUseActivity", makeActivity(item));
    hooks.call("dnd5e.rollAttack", makeActivity(item));

    assert.deepEqual(
      eventKeys(socketPayloads),
      [SOUND_EVENTS.ROLL_START],
      "activity start and immediate attack roll share one roll-start sound",
    );
  } finally {
    restoreFoundryGlobals(originals);
  }
}

{
  const originals = {
    AudioHelper: globalThis.AudioHelper,
    game: globalThis.game,
    Sequencer: globalThis.Sequencer,
    setTimeout: globalThis.setTimeout,
  };
  try {
    const hooks = makeHooks();
    const { socketPayloads } = installFoundryGlobals();
    resetSoundAutomationForTests(hooks);
    registerSoundAutomation({ hooks, gameRef: globalThis.game });

    const item = makeItem({
      flags: {
        "infinity-dnd5e": {
          soundProfile: { events: { use: SOUND_EVENTS.CLEAR_RESET } },
        },
      },
    });
    const activity = makeActivity(item, {
      flags: {
        "infinity-dnd5e": {
          soundProfile: { events: { use: SOUND_EVENTS.DEPOSIT } },
        },
      },
    });
    hooks.call("dnd5e.preUseActivity", activity);

    assert.equal(
      socketPayloads[0].payload.eventKey,
      SOUND_EVENTS.DEPOSIT,
      "activity soundProfile overrides item soundProfile",
    );
  } finally {
    restoreFoundryGlobals(originals);
  }
}

{
  const originals = {
    AudioHelper: globalThis.AudioHelper,
    game: globalThis.game,
    Sequencer: globalThis.Sequencer,
    setTimeout: globalThis.setTimeout,
  };
  try {
    const hooks = makeHooks();
    const { audioCalls, socketPayloads } = installFoundryGlobals();
    resetSoundAutomationForTests(hooks);
    registerSoundAutomation({ hooks, gameRef: globalThis.game });

    const item = makeItem({
      flags: {
        "infinity-dnd5e": {
          soundProfile: { enabled: false },
        },
      },
    });
    hooks.call("dnd5e.preUseActivity", makeActivity(item));

    assert.equal(socketPayloads.length, 0, "disabled profile emits no sound");
    assert.equal(audioCalls.length, 0, "disabled profile plays no local sound");
  } finally {
    restoreFoundryGlobals(originals);
  }
}

{
  const originals = {
    AudioHelper: globalThis.AudioHelper,
    game: globalThis.game,
    Sequencer: globalThis.Sequencer,
    setTimeout: globalThis.setTimeout,
  };
  try {
    const hooks = makeHooks();
    const { socketPayloads } = installFoundryGlobals({
      activeModules: ["midi-qol"],
    });
    resetSoundAutomationForTests(hooks);
    registerSoundAutomation({ hooks, gameRef: globalThis.game });

    const item = makeItem({ id: "midi-item", type: "weapon" });
    const activity = makeActivity(item);
    const workflow = { activity, actor: { id: "actor-a" }, item };

    hooks.call("dnd5e.preUseActivity", activity);
    hooks.call("midi-qol.preambleComplete", workflow);
    hooks.call("midi-qol.damageRollComplete", {
      ...workflow,
      damageRoll: { total: 4 },
    });

    assert.deepEqual(
      eventKeys(socketPayloads),
      [SOUND_EVENTS.ROLL_START, SOUND_EVENTS.RESULT_CASCADE],
      "MIDI-QOL hooks dedupe item start but add damage completion sound",
    );
  } finally {
    restoreFoundryGlobals(originals);
  }
}

{
  const originals = {
    AudioHelper: globalThis.AudioHelper,
    game: globalThis.game,
    Sequencer: globalThis.Sequencer,
    setTimeout: globalThis.setTimeout,
  };
  try {
    const hooks = makeHooks();
    const { socketPayloads } = installFoundryGlobals({
      activeModules: ["sequencer"],
    });
    resetSoundAutomationForTests(hooks);
    registerSoundAutomation({ hooks, gameRef: globalThis.game });

    hooks.call(
      "dnd5e.preUseActivity",
      makeActivity(makeItem({ type: "spell" }), {
        target: { template: { type: "circle" } },
      }),
    );

    assert.deepEqual(
      eventKeys(socketPayloads),
      [SOUND_EVENTS.ROLL_START, SOUND_EVENTS.LOADING_SHIMMER],
      "animation bridge adds a delayed animation-phase sound when Sequencer is active",
    );
  } finally {
    restoreFoundryGlobals(originals);
  }
}

{
  const originals = {
    AudioHelper: globalThis.AudioHelper,
    game: globalThis.game,
    Sequencer: globalThis.Sequencer,
    setTimeout: globalThis.setTimeout,
  };
  try {
    const hooks = makeHooks();
    const { socketPayloads } = installFoundryGlobals();
    resetSoundAutomationForTests(hooks);
    registerSoundAutomation({ hooks, gameRef: globalThis.game });

    hooks.call(
      "dnd5e.preUseActivity",
      makeActivity(makeItem({ type: "spell" }), {
        target: { template: { type: "circle" } },
      }),
    );

    assert.deepEqual(
      eventKeys(socketPayloads),
      [SOUND_EVENTS.ROLL_START],
      "missing Sequencer or Automated Animations modules leave animation bridge inactive",
    );
  } finally {
    restoreFoundryGlobals(originals);
  }
}

{
  const originals = {
    AudioHelper: globalThis.AudioHelper,
    game: globalThis.game,
    Sequencer: globalThis.Sequencer,
    setTimeout: globalThis.setTimeout,
  };
  try {
    const hooks = makeHooks();
    const { socketPayloads } = installFoundryGlobals();
    resetSoundAutomationForTests(hooks);
    registerSoundAutomation({ hooks, gameRef: globalThis.game });

    const item = makeItem({ rarity: "legendary", type: "weapon" });
    hooks.call("dnd5e.preUseActivity", makeActivity(item));

    assert.deepEqual(
      eventKeys(socketPayloads),
      [SOUND_EVENTS.ROLL_START, SOUND_EVENTS.LEGENDARY_CHIME],
      "legendary items add a delayed rarity chime",
    );
  } finally {
    restoreFoundryGlobals(originals);
  }
}

process.stdout.write("sound automation validation passed\n");
