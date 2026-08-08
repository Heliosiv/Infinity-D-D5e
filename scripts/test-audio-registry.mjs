import assert from "node:assert/strict";

import {
  SOUND_EVENTS,
  SOUND_REGISTRY,
  playModuleSound,
  playSoundEvent,
  playResultSound,
  preloadModuleSounds,
  receiveSoundEventPayload,
} from "./audio.js";

const eventValues = Object.values(SOUND_EVENTS);
assert.equal(
  new Set(eventValues).size,
  eventValues.length,
  "sound event keys are unique",
);

assert.deepEqual(
  Object.keys(SOUND_REGISTRY).sort(),
  eventValues.toSorted(),
  "registry covers every exported sound event",
);

const expectedVariantCounts = {
  [SOUND_EVENTS.LOADING_SHIMMER]: 2,
  [SOUND_EVENTS.ROLL_START]: 3,
  [SOUND_EVENTS.RESULT_CASCADE]: 3,
  [SOUND_EVENTS.HOARD_CASCADE]: 2,
  [SOUND_EVENTS.RARE_CHIME]: 2,
  [SOUND_EVENTS.LEGENDARY_CHIME]: 2,
  [SOUND_EVENTS.UI_OPEN]: 3,
  [SOUND_EVENTS.ITEM_OPEN]: 3,
  [SOUND_EVENTS.PRESET_APPLY]: 3,
  [SOUND_EVENTS.ROSTER_ADD]: 2,
  [SOUND_EVENTS.ROSTER_REMOVE]: 2,
  [SOUND_EVENTS.LOCK_TOGGLE]: 2,
  [SOUND_EVENTS.CHAT_SEND]: 2,
  [SOUND_EVENTS.DEPOSIT]: 3,
  [SOUND_EVENTS.CLEAR_RESET]: 2,
  [SOUND_EVENTS.WARNING_MUTED]: 3,
  [SOUND_EVENTS.MERCHANT_SESSION_OPEN]: 2,
  [SOUND_EVENTS.MERCHANT_PURCHASE]: 3,
  [SOUND_EVENTS.MERCHANT_SALE]: 3,
  [SOUND_EVENTS.MERCHANT_BARGAIN_WIN]: 2,
  [SOUND_EVENTS.MERCHANT_BARGAIN_FAIL]: 2,
};

const files = new Set();
for (const [eventKey, entry] of Object.entries(SOUND_REGISTRY)) {
  assert.equal(entry.id, eventKey, `${eventKey}: id matches event key`);
  assert.equal(
    entry.files.length,
    expectedVariantCounts[eventKey],
    `${eventKey}: expected variant count`,
  );
  assert.equal(entry.srcs.length, entry.files.length, `${eventKey}: src count`);
  assert.equal(entry.file, entry.files[0], `${eventKey}: first file alias`);
  assert.equal(entry.src, entry.srcs[0], `${eventKey}: first src alias`);
  for (const [index, file] of entry.files.entries()) {
    const suffix = String(index + 1).padStart(2, "0");
    assert.equal(
      file,
      `assets/sounds/${eventKey}-${suffix}.wav`,
      `${eventKey}: numbered variant path`,
    );
    assert.equal(
      entry.srcs[index],
      `modules/infinity-dnd5e/${file}`,
      `${eventKey}: Foundry module src is derived from asset path`,
    );
    assert.ok(!files.has(file), `${file} should not be reused`);
    files.add(file);
  }
  assert.ok(entry.volume >= 0 && entry.volume <= 1, `${eventKey}: volume`);
  assert.ok(entry.cooldownMs >= 0, `${eventKey}: cooldown`);
}

{
  const originalGame = globalThis.game;
  const originalFoundry = globalThis.foundry;
  const originalAudioHelper = globalThis.AudioHelper;
  const namespacedCalls = [];
  let globalCalled = false;
  globalThis.game = {
    settings: {
      get(moduleId, key) {
        if (moduleId !== "infinity-dnd5e") return undefined;
        if (key === "soundsEnabled") return true;
        if (key === "soundVolume") return 0.5;
        return undefined;
      },
    },
  };
  globalThis.foundry = {
    audio: {
      AudioHelper: {
        play(data, socketOptions) {
          namespacedCalls.push({ data, socketOptions });
          return { id: data.src };
        },
      },
    },
  };
  globalThis.AudioHelper = {
    play() {
      globalCalled = true;
    },
  };
  try {
    playModuleSound(SOUND_EVENTS.UI_OPEN, { cooldownMs: 0 });
    assert.equal(
      namespacedCalls.length,
      1,
      "playModuleSound prefers foundry.audio.AudioHelper",
    );
    assert.equal(
      globalCalled,
      false,
      "deprecated global AudioHelper is unused",
    );
  } finally {
    if (originalGame === undefined) delete globalThis.game;
    else globalThis.game = originalGame;
    if (originalFoundry === undefined) delete globalThis.foundry;
    else globalThis.foundry = originalFoundry;
    if (originalAudioHelper === undefined) delete globalThis.AudioHelper;
    else globalThis.AudioHelper = originalAudioHelper;
  }
}

{
  const originalGame = globalThis.game;
  const originalFoundry = globalThis.foundry;
  const originalAudioHelper = globalThis.AudioHelper;
  const calls = [];
  globalThis.game = {
    settings: {
      get(moduleId, key) {
        if (moduleId !== "infinity-dnd5e") return undefined;
        if (key === "soundsEnabled") return true;
        if (key === "soundVolume") return 0.5;
        return undefined;
      },
    },
  };
  delete globalThis.foundry;
  globalThis.AudioHelper = {
    play(data) {
      calls.push(data);
      return { id: data.src };
    },
  };
  try {
    for (let index = 0; index < 4; index += 1) {
      playModuleSound(SOUND_EVENTS.PRESET_APPLY, { cooldownMs: 0 });
    }
    const rotatingSources = calls.slice(0, 4).map((call) => call.src);
    assert.equal(
      new Set(rotatingSources.slice(0, 3)).size,
      3,
      "direct local calls rotate through every variant before repeating",
    );
    assert.equal(
      rotatingSources[3],
      rotatingSources[0],
      "direct local variant rotation wraps deterministically",
    );

    playModuleSound(SOUND_EVENTS.WARNING_MUTED, {
      cooldownMs: 0,
      variantKey: "stable-socket-event",
    });
    playModuleSound(SOUND_EVENTS.WARNING_MUTED, {
      cooldownMs: 0,
      variantKey: "stable-socket-event",
    });
    assert.equal(
      calls.at(-1).src,
      calls.at(-2).src,
      "the same variant key always selects the same source",
    );
  } finally {
    if (originalGame === undefined) delete globalThis.game;
    else globalThis.game = originalGame;
    if (originalFoundry === undefined) delete globalThis.foundry;
    else globalThis.foundry = originalFoundry;
    if (originalAudioHelper === undefined) delete globalThis.AudioHelper;
    else globalThis.AudioHelper = originalAudioHelper;
  }
}

{
  const originalGame = globalThis.game;
  const originalAudioHelper = globalThis.AudioHelper;
  const calls = [];
  const socketPayloads = [];
  globalThis.game = {
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
    user: { id: "user-a" },
  };
  globalThis.AudioHelper = {
    play(data, socketOptions) {
      calls.push({ data, socketOptions });
      return { id: data.src };
    },
  };
  try {
    playSoundEvent(SOUND_EVENTS.ROLL_START, {
      audience: "all",
      automation: true,
      contextKey: "Actor.a.Item.b",
      phase: "use",
      cooldownMs: 0,
    });

    assert.equal(calls.length, 1, "broadcast sound plays locally once");
    assert.equal(socketPayloads.length, 1, "broadcast sound emits once");
    assert.equal(socketPayloads[0].channel, "module.infinity-dnd5e");
    assert.equal(socketPayloads[0].payload.type, "sound-event");
    assert.equal(socketPayloads[0].payload.eventKey, SOUND_EVENTS.ROLL_START);
    assert.equal(socketPayloads[0].payload.originUserId, "user-a");
    assert.equal(
      socketPayloads[0].payload.file,
      undefined,
      "broadcast payload does not expose an asset file",
    );
    assert.equal(
      socketPayloads[0].payload.src,
      undefined,
      "broadcast payload does not expose a Foundry source",
    );
    assert.equal(
      socketPayloads[0].payload.options.volume,
      undefined,
      "broadcast payload stays semantic and does not include sender volume",
    );
    assert.equal(
      socketPayloads[0].payload.options.variantKey,
      undefined,
      "broadcast payload derives variants from its event id",
    );

    receiveSoundEventPayload(socketPayloads[0].payload);
    assert.equal(
      calls.length,
      1,
      "a local echo of the same socket event is ignored",
    );

    const remoteAudio = await import(`./audio.js?remote-client=${Date.now()}`);
    globalThis.game.user = { id: "user-b" };
    remoteAudio.receiveSoundEventPayload(socketPayloads[0].payload, "user-a");
    assert.equal(
      calls.length,
      2,
      "a remote client plays the socket event once",
    );
    assert.equal(
      calls[1].data.src,
      calls[0].data.src,
      "sender and receiver derive the same variant from the event id",
    );
  } finally {
    if (originalGame === undefined) delete globalThis.game;
    else globalThis.game = originalGame;
    if (originalAudioHelper === undefined) delete globalThis.AudioHelper;
    else globalThis.AudioHelper = originalAudioHelper;
  }
}

{
  const originalGame = globalThis.game;
  const originalAudioHelper = globalThis.AudioHelper;
  const calls = [];
  let automationEnabled = false;
  globalThis.game = {
    settings: {
      get(moduleId, key) {
        if (moduleId !== "infinity-dnd5e") return undefined;
        if (key === "soundsEnabled") return true;
        if (key === "automationSoundsEnabled") return automationEnabled;
        if (key === "soundVolume") return 0.25;
        return undefined;
      },
    },
    user: { id: "receiver" },
  };
  globalThis.AudioHelper = {
    play(data) {
      calls.push(data);
      return { id: data.src };
    },
  };
  try {
    receiveSoundEventPayload({
      type: "sound-event",
      id: "remote-disabled",
      eventKey: SOUND_EVENTS.ROLL_START,
      originUserId: "remote",
      options: { automation: true, contextKey: "Item.x", cooldownMs: 0 },
    });
    assert.equal(
      calls.length,
      0,
      "receiving client can opt out of automation sounds",
    );

    automationEnabled = true;
    receiveSoundEventPayload({
      type: "sound-event",
      id: "remote-enabled",
      eventKey: SOUND_EVENTS.ROLL_START,
      originUserId: "remote",
      options: { automation: true, contextKey: "Item.y", cooldownMs: 0 },
    });
    assert.equal(calls.length, 1, "receiving client plays opted-in events");
    assert.equal(
      calls[0].volume,
      SOUND_REGISTRY[SOUND_EVENTS.ROLL_START].volume * 0.25,
      "receiving client applies its own volume",
    );
  } finally {
    if (originalGame === undefined) delete globalThis.game;
    else globalThis.game = originalGame;
    if (originalAudioHelper === undefined) delete globalThis.AudioHelper;
    else globalThis.AudioHelper = originalAudioHelper;
  }
}

{
  const originalGame = globalThis.game;
  const originalAudioHelper = globalThis.AudioHelper;
  const calls = [];
  globalThis.game = {
    settings: {
      get(moduleId, key) {
        if (moduleId !== "infinity-dnd5e") return undefined;
        if (key === "soundsEnabled") return true;
        if (key === "soundVolume") return 0.5;
        return undefined;
      },
    },
  };
  globalThis.AudioHelper = {
    play(data, socketOptions) {
      calls.push({ data, socketOptions });
      return { id: data.src };
    },
  };
  try {
    playModuleSound(SOUND_EVENTS.UI_OPEN, { cooldownMs: 0 });
    assert.equal(calls.length, 1, "playModuleSound delegates to AudioHelper");
    assert.equal(calls[0].socketOptions, false, "sounds stay local");
    assert.equal(calls[0].data.loop, false);
    assert.equal(calls[0].data.autoplay, true);
    assert.equal(calls[0].data.volume, 0.175);

    playResultSound(
      { items: [{ rarity: "legendary" }], totalGp: 1 },
      { cooldownMs: 0, chimeDelayMs: 0 },
    );
    assert.ok(
      calls.some((call) => /\/legendary-chime-\d{2}\.wav$/.test(call.data.src)),
      "legendary result plays legendary chime",
    );
  } finally {
    if (originalGame === undefined) delete globalThis.game;
    else globalThis.game = originalGame;
    if (originalAudioHelper === undefined) delete globalThis.AudioHelper;
    else globalThis.AudioHelper = originalAudioHelper;
  }
}

{
  const originalGame = globalThis.game;
  const originalAudioHelper = globalThis.AudioHelper;
  let called = false;
  globalThis.game = {
    settings: {
      get(moduleId, key) {
        if (moduleId !== "infinity-dnd5e") return undefined;
        if (key === "soundsEnabled") return false;
        return undefined;
      },
    },
  };
  globalThis.AudioHelper = {
    play() {
      called = true;
    },
  };
  try {
    playModuleSound(SOUND_EVENTS.UI_OPEN, { cooldownMs: 0 });
    assert.equal(called, false, "disabled sounds do not call AudioHelper");
  } finally {
    if (originalGame === undefined) delete globalThis.game;
    else globalThis.game = originalGame;
    if (originalAudioHelper === undefined) delete globalThis.AudioHelper;
    else globalThis.AudioHelper = originalAudioHelper;
  }
}

{
  const originalFoundry = globalThis.foundry;
  const originalAudioHelper = globalThis.AudioHelper;
  const preloaded = [];
  globalThis.foundry = {
    audio: {
      AudioHelper: {
        async preloadSound(src) {
          preloaded.push(src);
        },
      },
    },
  };
  delete globalThis.AudioHelper;
  try {
    await preloadModuleSounds();
    const expectedSources = Object.values(SOUND_REGISTRY).flatMap(
      (entry) => entry.srcs,
    );
    assert.deepEqual(
      preloaded.toSorted(),
      expectedSources.toSorted(),
      "preloadModuleSounds preloads every registered variant",
    );
  } finally {
    if (originalFoundry === undefined) delete globalThis.foundry;
    else globalThis.foundry = originalFoundry;
    if (originalAudioHelper === undefined) delete globalThis.AudioHelper;
    else globalThis.AudioHelper = originalAudioHelper;
  }
}

process.stdout.write("audio registry validation passed\n");
