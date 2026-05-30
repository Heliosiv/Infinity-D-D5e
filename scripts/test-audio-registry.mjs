import assert from "node:assert/strict";

import {
  SOUND_EVENTS,
  SOUND_REGISTRY,
  playModuleSound,
  playResultSound,
  preloadModuleSounds,
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
