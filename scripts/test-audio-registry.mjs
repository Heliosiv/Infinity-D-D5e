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

const files = new Set();
for (const [eventKey, entry] of Object.entries(SOUND_REGISTRY)) {
  assert.equal(entry.id, eventKey, `${eventKey}: id matches event key`);
  assert.match(entry.file, /^assets\/sounds\/[-a-z]+\.wav$/);
  assert.equal(
    entry.src,
    `modules/infinity-dnd5e/${entry.file}`,
    `${eventKey}: Foundry module src is derived from asset path`,
  );
  assert.ok(!files.has(entry.file), `${entry.file} should not be reused`);
  files.add(entry.file);
  assert.ok(entry.volume >= 0 && entry.volume <= 1, `${eventKey}: volume`);
  assert.ok(entry.cooldownMs >= 0, `${eventKey}: cooldown`);
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
      socketPayloads[0].payload.options.volume,
      undefined,
      "broadcast payload stays semantic and does not include sender volume",
    );

    receiveSoundEventPayload(socketPayloads[0].payload);
    assert.equal(
      calls.length,
      1,
      "a local echo of the same socket event is ignored",
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
      calls.some((call) => call.data.src.endsWith("/legendary-chime.wav")),
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

assert.equal(typeof preloadModuleSounds, "function");

process.stdout.write("audio registry validation passed\n");
