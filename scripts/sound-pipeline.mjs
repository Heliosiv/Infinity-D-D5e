#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SOUND_REGISTRY } from "./audio.js";

const SAMPLE_RATE = 44_100;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const MAX_DURATION_SECONDS = 1.2;
const MAX_FILE_BYTES = 240_000;
const TAU = Math.PI * 2;

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const SOUND_SPECS = Object.freeze({
  "loading-shimmer": {
    duration: 1.0,
    peak: 0.56,
    render: renderLoadingShimmer,
  },
  "roll-start": { duration: 0.62, peak: 0.7, render: renderRollStart },
  "result-cascade": {
    duration: 0.68,
    peak: 0.6,
    render: renderResultCascade,
  },
  "hoard-cascade": { duration: 1.0, peak: 0.74, render: renderHoardCascade },
  "rare-chime": { duration: 0.82, peak: 0.66, render: renderRareChime },
  "legendary-chime": {
    duration: 1.12,
    peak: 0.7,
    render: renderLegendaryChime,
  },
  "ui-open": { duration: 0.3, peak: 0.56, render: renderUiOpen },
  "item-open": { duration: 0.42, peak: 0.52, render: renderItemOpen },
  "preset-apply": {
    duration: 0.32,
    peak: 0.52,
    render: renderPresetApply,
  },
  "roster-add": { duration: 0.26, peak: 0.52, render: renderRosterAdd },
  "roster-remove": {
    duration: 0.28,
    peak: 0.46,
    render: renderRosterRemove,
  },
  "lock-toggle": { duration: 0.22, peak: 0.6, render: renderLockToggle },
  "chat-send": { duration: 0.52, peak: 0.55, render: renderChatSend },
  deposit: { duration: 0.6, peak: 0.66, render: renderDeposit },
  "clear-reset": { duration: 0.38, peak: 0.52, render: renderClearReset },
  "warning-muted": { duration: 0.34, peak: 0.45, render: renderWarningMuted },
  "merchant-session-open": {
    duration: 0.42,
    peak: 0.58,
    render: renderMerchantSessionOpen,
  },
  "merchant-purchase": {
    duration: 0.6,
    peak: 0.64,
    render: renderMerchantPurchase,
  },
  "merchant-sale": { duration: 0.58, peak: 0.6, render: renderMerchantSale },
  "merchant-bargain-win": {
    duration: 0.78,
    peak: 0.66,
    render: renderMerchantBargainWin,
  },
  "merchant-bargain-fail": {
    duration: 0.5,
    peak: 0.5,
    render: renderMerchantBargainFail,
  },
});

if (isMainModule()) {
  const command = process.argv[2] ?? "validate";
  if (command === "generate") {
    generateSounds();
  } else if (command === "validate") {
    validateSoundAssets();
  } else {
    console.error("Usage: node scripts/sound-pipeline.mjs <generate|validate>");
    process.exit(1);
  }
}

export function generateSounds() {
  for (const entry of Object.values(SOUND_REGISTRY)) {
    const spec = SOUND_SPECS[entry.id];
    if (!spec) throw new Error(`No sound spec for ${entry.id}`);
    const filePath = path.join(root, entry.file);
    mkdirSync(path.dirname(filePath), { recursive: true });
    const buffer = createBuffer(spec.duration);
    spec.render(buffer, makeRng(hashString(entry.id)));
    finishBuffer(buffer, spec.peak);
    writeFileSync(filePath, encodeWav(buffer));
  }
  console.log(
    `generated ${Object.keys(SOUND_REGISTRY).length} procedural sound asset(s)`,
  );
}

export function validateSoundAssets() {
  const seenIds = new Set();
  const seenFiles = new Set();
  for (const [key, entry] of Object.entries(SOUND_REGISTRY)) {
    if (seenIds.has(entry.id))
      throw new Error(`Duplicate sound id ${entry.id}`);
    seenIds.add(entry.id);
    if (seenFiles.has(entry.file)) {
      throw new Error(`Duplicate sound file ${entry.file}`);
    }
    seenFiles.add(entry.file);

    const spec = SOUND_SPECS[entry.id];
    if (!spec) throw new Error(`${key} has no procedural spec`);
    if (entry.volume < 0 || entry.volume > 1) {
      throw new Error(`${key} volume ${entry.volume} must be between 0 and 1`);
    }

    const filePath = path.join(root, entry.file);
    if (!existsSync(filePath)) throw new Error(`${entry.file} is missing`);
    const stat = statSync(filePath);
    if (stat.size <= 44) throw new Error(`${entry.file} is too small`);
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(`${entry.file} is too large (${stat.size} bytes)`);
    }

    const wav = inspectWav(readFileSync(filePath));
    if (wav.sampleRate !== SAMPLE_RATE) {
      throw new Error(`${entry.file} sample rate ${wav.sampleRate} != 44100`);
    }
    if (wav.channels !== CHANNELS) {
      throw new Error(`${entry.file} channel count ${wav.channels} != 2`);
    }
    if (wav.bitsPerSample !== 16) {
      throw new Error(`${entry.file} bit depth ${wav.bitsPerSample} != 16`);
    }
    if (
      wav.durationSeconds <= 0 ||
      wav.durationSeconds > MAX_DURATION_SECONDS
    ) {
      throw new Error(
        `${entry.file} duration ${wav.durationSeconds.toFixed(3)}s is invalid`,
      );
    }
  }
  console.log(
    `sound asset validation passed (${Object.keys(SOUND_REGISTRY).length} WAV assets)`,
  );
}

function renderLoadingShimmer(buffer, rng) {
  // A satchel of magic opened: parchment unfurling + leather, a faint glimmer.
  addParchment(buffer, rng, {
    start: 0.0,
    duration: 0.72,
    amp: 0.07,
    pan: -0.12,
    panEnd: 0.18,
  });
  addLeather(buffer, rng, {
    start: 0.0,
    duration: 0.5,
    amp: 0.055,
    pan: -0.22,
    panEnd: 0.1,
  });
  addStruckMetal(buffer, rng, {
    start: 0.05,
    freq: 742,
    amp: 0.05,
    pan: -0.3,
    decay: 4.6,
  });
  addStruckMetal(buffer, rng, {
    start: 0.26,
    freq: 1116,
    amp: 0.032,
    pan: 0.28,
    decay: 5.4,
  });
  addGlints(buffer, rng, {
    count: 5,
    start: 0.2,
    spread: 0.5,
    baseFreq: 1500,
    amp: 0.016,
  });
  addRoomTail(buffer, { amount: 0.14 });
}

function renderRollStart(buffer, rng) {
  // Dice/bones shaken in a leather cup, then the cup set down on wood.
  addLeather(buffer, rng, {
    start: 0.0,
    duration: 0.16,
    amp: 0.07,
    pan: -0.2,
    panEnd: 0.2,
  });
  for (const start of [0.02, 0.07, 0.13, 0.2]) {
    addWoodKnock(buffer, rng, {
      start: start + rng() * 0.01,
      freq: 220 + rng() * 180,
      amp: 0.07 + rng() * 0.03,
      pan: -0.5 + rng() * 1.0,
      decay: 34,
    });
  }
  addWoodKnock(buffer, rng, {
    start: 0.3,
    freq: 150,
    amp: 0.16,
    pan: -0.05,
    decay: 22,
  });
  addParchment(buffer, rng, {
    start: 0.32,
    duration: 0.26,
    amp: 0.03,
    pan: 0.18,
  });
  addRoomTail(buffer, { amount: 0.1 });
}

function renderResultCascade(buffer, rng) {
  // Coins and trinkets tipped out onto a cloth-covered table.
  addFilteredNoise(buffer, rng, {
    start: 0.0,
    duration: 0.18,
    amp: 0.05,
    pan: -0.3,
    panEnd: 0.3,
    color: "cloth",
    attack: 0.004,
    release: 1.1,
  });
  for (const [index, start] of [0.03, 0.09, 0.16, 0.24, 0.34, 0.45].entries()) {
    addCoinClick(buffer, rng, {
      start: start + rng() * 0.012,
      amp: 0.12 + index * 0.012,
      freq: 660 + index * 60 + rng() * 120,
      pan: index % 2 === 0 ? -0.32 : 0.32,
    });
  }
  addStruckMetal(buffer, rng, {
    start: 0.26,
    freq: 560,
    amp: 0.03,
    pan: 0.08,
    decay: 6,
  });
  addParchment(buffer, rng, {
    start: 0.0,
    duration: 0.3,
    amp: 0.022,
    pan: 0.1,
  });
  addRoomTail(buffer, { amount: 0.11 });
}

function renderHoardCascade(buffer, rng) {
  // A heavy chest of coins poured out onto wood.
  addImpact(buffer, rng, {
    start: 0,
    duration: 0.3,
    freq: 84,
    amp: 0.24,
    pan: -0.1,
    color: "wood",
  });
  addFilteredNoise(buffer, rng, {
    start: 0.08,
    duration: 0.6,
    amp: 0.05,
    pan: -0.35,
    panEnd: 0.42,
    color: "coin",
    attack: 0.02,
    release: 1.7,
  });
  for (const start of [0.08, 0.13, 0.19, 0.26, 0.34, 0.44, 0.56, 0.7, 0.83]) {
    addCoinClick(buffer, rng, {
      start: start + rng() * 0.02,
      amp: 0.16 + rng() * 0.09,
      freq: 680 + rng() * 480,
      pan: -0.7 + rng() * 1.4,
    });
  }
  addStruckMetal(buffer, rng, {
    start: 0.34,
    freq: 330,
    amp: 0.04,
    pan: 0.2,
    decay: 4.4,
  });
  addRoomTail(buffer, { amount: 0.16 });
}

function renderRareChime(buffer, rng) {
  // A single struck bronze bell.
  addStruckMetal(buffer, rng, {
    start: 0.0,
    freq: 880,
    amp: 0.14,
    pan: -0.12,
    decay: 3.4,
  });
  addStruckMetal(buffer, rng, {
    start: 0.05,
    freq: 1320,
    amp: 0.06,
    pan: 0.22,
    decay: 4.6,
  });
  addFilteredNoise(buffer, rng, {
    start: 0.02,
    duration: 0.5,
    amp: 0.01,
    pan: 0.2,
    panEnd: -0.15,
    color: "shimmer",
    attack: 0.04,
    release: 2.0,
  });
  addRoomTail(buffer, { amount: 0.18 });
}

function renderLegendaryChime(buffer, rng) {
  // A struck temple bell — root / fifth / octave — over a low bronze body.
  addDecayTone(buffer, {
    start: 0.0,
    freq: 130.81,
    amp: 0.06,
    pan: 0,
    attack: 0.01,
    decayRate: 2.2,
  });
  addStruckMetal(buffer, rng, {
    start: 0.0,
    freq: 523.25,
    amp: 0.125,
    pan: -0.22,
    decay: 2.6,
  });
  addStruckMetal(buffer, rng, {
    start: 0.07,
    freq: 783.99,
    amp: 0.085,
    pan: 0.18,
    decay: 3.0,
  });
  addStruckMetal(buffer, rng, {
    start: 0.16,
    freq: 1046.5,
    amp: 0.055,
    pan: 0.36,
    decay: 3.6,
  });
  addGlints(buffer, rng, {
    count: 6,
    start: 0.24,
    spread: 0.5,
    baseFreq: 1700,
    amp: 0.016,
  });
  addFilteredNoise(buffer, rng, {
    start: 0.1,
    duration: 0.85,
    amp: 0.013,
    pan: -0.18,
    panEnd: 0.2,
    color: "shimmer",
    attack: 0.08,
    release: 2.3,
  });
  addRoomTail(buffer, { amount: 0.2 });
}

function renderUiOpen(buffer, rng) {
  // A leather-bound ledger opening.
  addLeather(buffer, rng, {
    start: 0.0,
    duration: 0.18,
    amp: 0.09,
    pan: -0.18,
    panEnd: 0.16,
  });
  addParchment(buffer, rng, {
    start: 0.04,
    duration: 0.2,
    amp: 0.05,
    pan: 0.1,
  });
  addWoodKnock(buffer, rng, {
    start: 0.0,
    freq: 240,
    amp: 0.05,
    pan: -0.12,
    decay: 40,
  });
  addRoomTail(buffer, { amount: 0.08 });
}

function renderItemOpen(buffer, rng) {
  // A single parchment page turned.
  addParchment(buffer, rng, {
    start: 0.0,
    duration: 0.26,
    amp: 0.075,
    pan: -0.26,
    panEnd: 0.3,
  });
  addWoodKnock(buffer, rng, {
    start: 0.16,
    freq: 300,
    amp: 0.035,
    pan: 0.16,
    decay: 44,
  });
  addRoomTail(buffer, { amount: 0.07 });
}

function renderPresetApply(buffer, rng) {
  // A wax seal pressed onto parchment.
  addWoodKnock(buffer, rng, {
    start: 0.006,
    freq: 300,
    amp: 0.16,
    pan: -0.1,
    decay: 30,
  });
  addLeather(buffer, rng, {
    start: 0.0,
    duration: 0.12,
    amp: 0.04,
    pan: 0.1,
  });
  addStruckMetal(buffer, rng, {
    start: 0.06,
    freq: 620,
    amp: 0.035,
    pan: 0.16,
    decay: 7,
  });
  addRoomTail(buffer, { amount: 0.06 });
}

function renderRosterAdd(buffer, rng) {
  // A token dropped into a leather pouch.
  addLeather(buffer, rng, {
    start: 0.0,
    duration: 0.12,
    amp: 0.07,
    pan: -0.16,
  });
  addCoinClick(buffer, rng, {
    start: 0.03,
    amp: 0.1,
    freq: 560,
    pan: 0.12,
  });
  addRoomTail(buffer, { amount: 0.05 });
}

function renderRosterRemove(buffer, rng) {
  // Drawn back out of the pouch — soft, downward.
  addLeather(buffer, rng, {
    start: 0.0,
    duration: 0.14,
    amp: 0.07,
    pan: 0.16,
    panEnd: -0.16,
  });
  addPitchSweep(buffer, {
    start: 0.03,
    duration: 0.16,
    fromFreq: 360,
    toFreq: 240,
    amp: 0.04,
    pan: -0.06,
    attack: 0.008,
    release: 1.8,
  });
  addRoomTail(buffer, { amount: 0.045 });
}

function renderLockToggle(buffer, rng) {
  // A wooden/iron clasp snapping shut.
  addWoodKnock(buffer, rng, {
    start: 0.005,
    freq: 360,
    amp: 0.2,
    pan: -0.18,
    decay: 30,
  });
  addStruckMetal(buffer, rng, {
    start: 0.05,
    freq: 540,
    amp: 0.06,
    pan: 0.16,
    decay: 9,
  });
  addRoomTail(buffer, { amount: 0.05 });
}

function renderChatSend(buffer, rng) {
  // A quill stroke across parchment, then set down.
  addParchment(buffer, rng, {
    start: 0.0,
    duration: 0.28,
    amp: 0.07,
    pan: -0.45,
    panEnd: 0.3,
  });
  addWoodKnock(buffer, rng, {
    start: 0.3,
    freq: 380,
    amp: 0.08,
    pan: 0.06,
    decay: 36,
  });
  addRoomTail(buffer, { amount: 0.08 });
}

function renderDeposit(buffer, rng) {
  // A coin pouch set down, coins settling inside.
  addImpact(buffer, rng, {
    start: 0.0,
    duration: 0.2,
    freq: 116,
    amp: 0.18,
    pan: -0.12,
    color: "cloth",
  });
  addLeather(buffer, rng, {
    start: 0.0,
    duration: 0.16,
    amp: 0.05,
    pan: 0.0,
  });
  for (const start of [0.09, 0.16, 0.27, 0.39]) {
    addCoinClick(buffer, rng, {
      start: start + rng() * 0.012,
      amp: 0.12 + rng() * 0.06,
      freq: 640 + rng() * 340,
      pan: -0.4 + rng() * 0.8,
    });
  }
  addRoomTail(buffer, { amount: 0.1 });
}

function renderClearReset(buffer, rng) {
  // A parchment swept off the table — airy, downward.
  addParchment(buffer, rng, {
    start: 0.0,
    duration: 0.3,
    amp: 0.08,
    pan: 0.45,
    panEnd: -0.4,
  });
  addPitchSweep(buffer, {
    start: 0.05,
    duration: 0.22,
    fromFreq: 240,
    toFreq: 140,
    amp: 0.05,
    pan: -0.08,
    attack: 0.02,
    release: 1.35,
  });
  addRoomTail(buffer, { amount: 0.06 });
}

function renderWarningMuted(buffer, rng) {
  // A dull, dead wooden thud — clearly "no".
  addWoodKnock(buffer, rng, {
    start: 0.0,
    freq: 104,
    amp: 0.22,
    pan: 0,
    decay: 30,
  });
  addFilteredNoise(buffer, rng, {
    start: 0.0,
    duration: 0.16,
    amp: 0.05,
    pan: 0,
    color: "cloth",
    attack: 0.002,
    release: 1.2,
  });
  addRoomTail(buffer, { amount: 0.035 });
}

function renderMerchantSessionOpen(buffer, rng) {
  // A shop counter knock and a small brass shop bell.
  addWoodKnock(buffer, rng, {
    start: 0.005,
    freq: 260,
    amp: 0.16,
    pan: -0.18,
    decay: 26,
  });
  addStruckMetal(buffer, rng, {
    start: 0.07,
    freq: 720,
    amp: 0.07,
    pan: -0.06,
    decay: 5,
  });
  addStruckMetal(buffer, rng, {
    start: 0.16,
    freq: 1080,
    amp: 0.045,
    pan: 0.22,
    decay: 6,
  });
  addRoomTail(buffer, { amount: 0.1 });
}

function renderMerchantPurchase(buffer, rng) {
  // Coins paid onto a wooden counter.
  addWoodKnock(buffer, rng, {
    start: 0.0,
    freq: 150,
    amp: 0.12,
    pan: -0.1,
    decay: 30,
  });
  for (const start of [0.06, 0.14, 0.24, 0.35]) {
    addCoinClick(buffer, rng, {
      start: start + rng() * 0.012,
      amp: 0.16 + rng() * 0.06,
      freq: 700 + rng() * 320,
      pan: -0.4 + rng() * 0.8,
    });
  }
  addStruckMetal(buffer, rng, {
    start: 0.45,
    freq: 760,
    amp: 0.04,
    pan: 0.1,
    decay: 7,
  });
  addRoomTail(buffer, { amount: 0.1 });
}

function renderMerchantSale(buffer, rng) {
  // Coins counted out into your hand — rising.
  for (const start of [0.02, 0.1, 0.19, 0.3]) {
    addCoinClick(buffer, rng, {
      start: start + rng() * 0.01,
      amp: 0.13 + rng() * 0.05,
      freq: 560 + rng() * 280,
      pan: -0.35 + rng() * 0.7,
    });
  }
  addStruckMetal(buffer, rng, {
    start: 0.34,
    freq: 660,
    amp: 0.05,
    pan: 0.08,
    decay: 6,
  });
  addRoomTail(buffer, { amount: 0.08 });
}

function renderMerchantBargainWin(buffer, rng) {
  // A bright flourish of struck coins — a deal struck.
  addStruckMetal(buffer, rng, {
    start: 0.0,
    freq: 660,
    amp: 0.11,
    pan: -0.18,
    decay: 4,
  });
  addStruckMetal(buffer, rng, {
    start: 0.08,
    freq: 880,
    amp: 0.08,
    pan: 0.1,
    decay: 4.6,
  });
  addStruckMetal(buffer, rng, {
    start: 0.18,
    freq: 1320,
    amp: 0.05,
    pan: 0.28,
    decay: 5.4,
  });
  addCoinClick(buffer, rng, {
    start: 0.05,
    amp: 0.1,
    freq: 900,
    pan: -0.2,
  });
  addRoomTail(buffer, { amount: 0.13 });
}

function renderMerchantBargainFail(buffer, rng) {
  // A flat wooden thud and a sour downward slide — no deal.
  addWoodKnock(buffer, rng, {
    start: 0.0,
    freq: 96,
    amp: 0.2,
    pan: 0.04,
    decay: 26,
  });
  addPitchSweep(buffer, {
    start: 0.05,
    duration: 0.28,
    fromFreq: 300,
    toFreq: 150,
    amp: 0.05,
    pan: -0.06,
    attack: 0.018,
    release: 1.3,
  });
  addRoomTail(buffer, { amount: 0.045 });
}

function createBuffer(duration) {
  const length = Math.ceil(duration * SAMPLE_RATE);
  return {
    left: new Float32Array(length),
    right: new Float32Array(length),
  };
}

function finishBuffer(buffer, peak) {
  removeDc(buffer.left);
  removeDc(buffer.right);
  // Gentle high-frequency roll-off to take the digital fizz / harsh edge off
  // the noise + soft-limiter before normalizing.
  lowPass(buffer.left, 13_500);
  lowPass(buffer.right, 13_500);
  fadeEdges(buffer, 0.005);
  softLimit(buffer, 1.12);
  normalize(buffer, peak);
}

function lowPass(samples, cutoffHz) {
  const dt = 1 / SAMPLE_RATE;
  const rc = 1 / (TAU * cutoffHz);
  const alpha = dt / (rc + dt);
  let previous = samples[0] ?? 0;
  for (let i = 0; i < samples.length; i += 1) {
    previous += alpha * (samples[i] - previous);
    samples[i] = previous;
  }
}

/* ------------------------------------------------------------------ *
 * Tactile-fantasy primitives — physical materials over clean UI tones:
 * struck metal, resonant wood, parchment crinkle, leather creak.
 * ------------------------------------------------------------------ */

/** A single decaying sine with a click-free attack and exponential tail —
 *  the building block for struck/plucked resonances (vs. addTone's power
 *  envelope). Stops early once inaudible so partials stay cheap. */
function addDecayTone(
  buffer,
  {
    start,
    freq,
    amp,
    pan = 0,
    attack = 0.001,
    decayRate = 8,
    maxDuration = 1.15,
  },
) {
  const startIndex = Math.max(0, Math.floor(start * SAMPLE_RATE));
  const endIndex = Math.min(
    buffer.left.length,
    startIndex + Math.ceil(maxDuration * SAMPLE_RATE),
  );
  const [leftGain, rightGain] = panGains(pan);
  for (let i = startIndex; i < endIndex; i += 1) {
    const t = (i - startIndex) / SAMPLE_RATE;
    const a = Math.min(1, t / Math.max(attack, 0.0003));
    const env = a * a * (3 - 2 * a) * Math.exp(-decayRate * t);
    if (t > attack && env < 0.00015) break;
    const sample = Math.sin(TAU * freq * t) * amp * env;
    buffer.left[i] += sample * leftGain;
    buffer.right[i] += sample * rightGain;
  }
}

/** Struck metal (bell / chime / coin ring): a bright noise strike transient
 *  plus inharmonic partials that decay faster the higher they are — the
 *  signature of a real struck bar, not a pure sine. */
function addStruckMetal(
  buffer,
  rng,
  { start, freq, amp, pan = 0, decay = 6, partials },
) {
  addFilteredNoise(buffer, rng, {
    start,
    duration: 0.013,
    amp: amp * 0.45,
    pan,
    color: "coin",
    attack: 0.0005,
    release: 0.7,
  });
  const set = partials ?? [
    [1.0, 1.0, 1.0],
    [2.76, 0.52, 1.7],
    [5.4, 0.3, 2.7],
    [8.93, 0.16, 4.0],
    [13.34, 0.07, 5.6],
  ];
  for (const [ratio, partialAmp, decMul] of set) {
    const detune = 1 + (rng() * 2 - 1) * 0.004;
    addDecayTone(buffer, {
      start,
      freq: freq * ratio * detune,
      amp: amp * partialAmp,
      pan: clamp(pan + Math.log2(ratio) * 0.05, -0.85, 0.85),
      attack: 0.0008,
      decayRate: decay * decMul,
    });
  }
}

/** A resonant wooden knock: a short woody noise tap with a couple of hollow
 *  body modes — a cup on a table, a clasp, a stamp. */
function addWoodKnock(buffer, rng, { start, freq, amp, pan = 0, decay = 26 }) {
  addFilteredNoise(buffer, rng, {
    start,
    duration: 0.02,
    amp: amp * 0.62,
    pan,
    color: "wood",
    attack: 0.0005,
    release: 0.85,
  });
  for (const [ratio, partialAmp, decMul] of [
    [1.0, 1.0, 1.0],
    [2.42, 0.5, 1.5],
    [3.9, 0.22, 2.3],
  ]) {
    addDecayTone(buffer, {
      start,
      freq: freq * ratio,
      amp: amp * partialAmp,
      pan,
      attack: 0.0008,
      decayRate: decay * decMul,
      maxDuration: 0.35,
    });
  }
}

/** Parchment / paper handling: a soft dry rustle plus a scatter of tiny
 *  crinkle cracks across the window. */
function addParchment(
  buffer,
  rng,
  { start, duration, amp, pan = 0, panEnd = pan },
) {
  addFilteredNoise(buffer, rng, {
    start,
    duration,
    amp: amp * 0.5,
    pan,
    panEnd,
    color: "parchment",
    attack: 0.02,
    release: 1.2,
  });
  const cracks = 4 + Math.floor(rng() * 5);
  for (let i = 0; i < cracks; i += 1) {
    addFilteredNoise(buffer, rng, {
      start: start + rng() * duration * 0.92,
      duration: 0.005 + rng() * 0.009,
      amp: amp * (0.35 + rng() * 0.6),
      pan: pan + (panEnd - pan) * rng(),
      color: "parchment",
      attack: 0.0006,
      release: 0.95,
    });
  }
}

/** Leather creak / soft pouch handling: low-mid grain with a gentle attack. */
function addLeather(
  buffer,
  rng,
  { start, duration, amp, pan = 0, panEnd = pan },
) {
  addFilteredNoise(buffer, rng, {
    start,
    duration,
    amp,
    pan,
    panEnd,
    color: "leather",
    attack: 0.014,
    release: 1.05,
  });
}

function addBell(buffer, { start, duration, freq, amp, pan = 0 }) {
  const partials = [
    [1, 1],
    [2.01, 0.34],
    [2.72, 0.16],
    [4.08, 0.075],
  ];
  for (const [ratio, partialAmp] of partials) {
    addTone(buffer, {
      start,
      duration: duration * (ratio === 1 ? 1 : 0.78),
      freq: freq * ratio,
      amp: amp * partialAmp,
      pan: clamp(pan + Math.log2(ratio) * 0.12, -0.85, 0.85),
      attack: 0.006 + ratio * 0.001,
      release: 2.15 + ratio * 0.42,
      tremoloDepth: ratio === 1 ? 0.015 : 0,
      tremoloRate: 4.2,
    });
  }
}

function addGlints(buffer, rng, { count, start, spread, baseFreq, amp }) {
  for (let index = 0; index < count; index += 1) {
    addBell(buffer, {
      start: start + rng() * spread,
      duration: 0.13 + rng() * 0.14,
      freq: baseFreq + rng() * 900,
      amp: amp * (0.65 + rng() * 0.55),
      pan: -0.75 + rng() * 1.5,
    });
  }
}

function addCoinClick(buffer, rng, { start, amp, freq, pan }) {
  addFilteredNoise(buffer, rng, {
    start,
    duration: 0.026,
    amp: amp * 0.34,
    pan,
    color: "coin",
    attack: 0.001,
    release: 0.55,
  });
  addTone(buffer, {
    start,
    duration: 0.11,
    freq,
    amp: amp * 0.21,
    pan,
    attack: 0.001,
    release: 5.1,
  });
  addTone(buffer, {
    start: start + 0.004,
    duration: 0.09,
    freq: freq * 1.92,
    amp: amp * 0.085,
    pan: clamp(pan * -0.4, -0.8, 0.8),
    attack: 0.001,
    release: 5.8,
  });
  addTone(buffer, {
    start: start + 0.008,
    duration: 0.07,
    freq: freq * 2.71,
    amp: amp * 0.04,
    pan: clamp(pan + 0.18, -0.8, 0.8),
    attack: 0.001,
    release: 6.4,
  });
}

function addImpact(buffer, rng, { start, duration, freq, amp, pan, color }) {
  addTone(buffer, {
    start,
    duration,
    freq,
    amp,
    pan,
    attack: 0.002,
    release: 3.2,
  });
  addTone(buffer, {
    start: start + 0.006,
    duration: duration * 0.55,
    freq: freq * 1.92,
    amp: amp * 0.18,
    pan: clamp(pan * -0.35, -0.7, 0.7),
    attack: 0.001,
    release: 4.4,
  });
  addFilteredNoise(buffer, rng, {
    start,
    duration: duration * 0.62,
    amp: amp * 0.22,
    pan,
    color,
    attack: 0.001,
    release: 2.2,
  });
}

function addTone(
  buffer,
  {
    start,
    duration,
    freq,
    amp,
    pan = 0,
    attack = 0.006,
    release = 2,
    tremoloDepth = 0,
    tremoloRate = 0,
  },
) {
  const startIndex = Math.max(0, Math.floor(start * SAMPLE_RATE));
  const endIndex = Math.min(
    buffer.left.length,
    startIndex + Math.ceil(duration * SAMPLE_RATE),
  );
  const [leftGain, rightGain] = panGains(pan);
  for (let i = startIndex; i < endIndex; i += 1) {
    const localT = (i - startIndex) / SAMPLE_RATE;
    const env = shapedEnvelope(localT, duration, attack, release);
    const tremolo =
      tremoloDepth > 0
        ? 1 + Math.sin(TAU * tremoloRate * localT) * tremoloDepth
        : 1;
    const sample = Math.sin(TAU * freq * localT) * amp * env * tremolo;
    buffer.left[i] += sample * leftGain;
    buffer.right[i] += sample * rightGain;
  }
}

function addPitchSweep(
  buffer,
  {
    start,
    duration,
    fromFreq,
    toFreq,
    amp,
    pan = 0,
    attack = 0.008,
    release = 1.6,
  },
) {
  const startIndex = Math.max(0, Math.floor(start * SAMPLE_RATE));
  const endIndex = Math.min(
    buffer.left.length,
    startIndex + Math.ceil(duration * SAMPLE_RATE),
  );
  const [leftGain, rightGain] = panGains(pan);
  let phase = 0;
  for (let i = startIndex; i < endIndex; i += 1) {
    const localT = (i - startIndex) / SAMPLE_RATE;
    const progress = Math.min(1, localT / duration);
    const freq = fromFreq + (toFreq - fromFreq) * smoothstep(progress);
    phase += TAU * (freq / SAMPLE_RATE);
    const env = shapedEnvelope(localT, duration, attack, release);
    const sample = Math.sin(phase) * amp * env;
    buffer.left[i] += sample * leftGain;
    buffer.right[i] += sample * rightGain;
  }
}

function addFilteredNoise(
  buffer,
  rng,
  {
    start,
    duration,
    amp,
    pan = 0,
    panEnd = pan,
    color = "paper",
    attack = 0.004,
    release = 1.4,
  },
) {
  const startIndex = Math.max(0, Math.floor(start * SAMPLE_RATE));
  const endIndex = Math.min(
    buffer.left.length,
    startIndex + Math.ceil(duration * SAMPLE_RATE),
  );
  let low = 0;
  let lowSlow = 0;
  let previousWhite = 0;
  for (let i = startIndex; i < endIndex; i += 1) {
    const localT = (i - startIndex) / SAMPLE_RATE;
    const progress = Math.min(1, localT / duration);
    const white = rng() * 2 - 1;
    low = low * 0.78 + white * 0.22;
    lowSlow = lowSlow * 0.93 + white * 0.07;
    const high = white - low;
    const snap = white - previousWhite;
    previousWhite = white;

    let colored;
    if (color === "coin") colored = high * 0.72 + snap * 0.22 + low * 0.06;
    else if (color === "wood") colored = low * 0.72 + high * 0.18;
    else if (color === "cloth") colored = lowSlow * 0.88 + low * 0.12;
    else if (color === "leather")
      colored = lowSlow * 0.52 + low * 0.42 + snap * 0.06;
    else if (color === "parchment")
      colored = high * 0.46 + snap * 0.36 + low * 0.18;
    else if (color === "shimmer") colored = high * 0.58 + low * 0.3;
    else colored = high * 0.34 + low * 0.66;

    const env = shapedEnvelope(localT, duration, attack, release);
    const currentPan = pan + (panEnd - pan) * smoothstep(progress);
    const [leftGain, rightGain] = panGains(currentPan);
    const sample = colored * amp * env;
    buffer.left[i] += sample * leftGain;
    buffer.right[i] += sample * rightGain;
  }
}

/**
 * Diffuse room tail — a spray of decaying, cross-fed early reflections instead
 * of one feedback echo. Several incommensurate tap times blur into a small
 * stone-hall ambience without the metallic slap-back ring the old single tap
 * produced. `amount` is the wet level; `room` scales the tap spacing.
 */
function addRoomTail(buffer, { amount = 0.1, room = 1 }) {
  const taps = [
    [9, 0.72],
    [17, 0.52],
    [26, 0.38],
    [37, 0.27],
    [50, 0.18],
    [65, 0.12],
    [83, 0.08],
  ];
  const srcLeft = buffer.left.slice();
  const srcRight = buffer.right.slice();
  const length = buffer.left.length;
  for (const [ms, gain] of taps) {
    const wet = gain * amount;
    const delayLeft = Math.max(
      1,
      Math.round(((ms * room) / 1000) * SAMPLE_RATE),
    );
    const delayRight = Math.max(
      1,
      Math.round(((ms * room * 1.18) / 1000) * SAMPLE_RATE),
    );
    // Cross-feed (left tail fed from the right source and vice versa) widens
    // the image, mixing a little same-side energy for body.
    for (let i = delayLeft; i < length; i += 1) {
      buffer.left[i] += srcRight[i - delayLeft] * wet * 0.7;
      buffer.left[i] += srcLeft[i - delayLeft] * wet * 0.4;
    }
    for (let i = delayRight; i < length; i += 1) {
      buffer.right[i] += srcLeft[i - delayRight] * wet * 0.7;
      buffer.right[i] += srcRight[i - delayRight] * wet * 0.4;
    }
  }
}

function shapedEnvelope(t, duration, attack, release) {
  const attackShape = Math.min(1, t / Math.max(attack, 0.001));
  const releaseShape = Math.max(0, 1 - t / duration);
  return attackShape * attackShape * Math.pow(releaseShape, release);
}

function panGains(pan) {
  const angle = ((clamp(pan, -1, 1) + 1) * Math.PI) / 4;
  return [Math.cos(angle), Math.sin(angle)];
}

function smoothstep(value) {
  const x = clamp(value, 0, 1);
  return x * x * (3 - 2 * x);
}

function removeDc(samples) {
  let previousInput = 0;
  let previousOutput = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const input = samples[i];
    const output = input - previousInput + 0.995 * previousOutput;
    samples[i] = output;
    previousInput = input;
    previousOutput = output;
  }
}

function softLimit(buffer, drive) {
  const divisor = Math.tanh(drive);
  for (const samples of [buffer.left, buffer.right]) {
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = Math.tanh(samples[i] * drive) / divisor;
    }
  }
}

function normalize(buffer, peak) {
  let max = 0;
  for (const samples of [buffer.left, buffer.right]) {
    for (const sample of samples) max = Math.max(max, Math.abs(sample));
  }
  if (max === 0) return;
  const gain = Math.min(12, peak / max);
  for (const samples of [buffer.left, buffer.right]) {
    for (let i = 0; i < samples.length; i += 1) samples[i] *= gain;
  }
}

function fadeEdges(buffer, seconds) {
  const frames = Math.min(
    Math.floor(seconds * SAMPLE_RATE),
    Math.floor(buffer.left.length / 2),
  );
  for (let i = 0; i < frames; i += 1) {
    const fadeIn = i / frames;
    const fadeOut = (frames - i) / frames;
    buffer.left[i] *= fadeIn;
    buffer.right[i] *= fadeIn;
    const end = buffer.left.length - i - 1;
    buffer.left[end] *= fadeOut;
    buffer.right[end] *= fadeOut;
  }
}

function encodeWav(buffer) {
  const frameCount = buffer.left.length;
  const dataBytes = frameCount * CHANNELS * BYTES_PER_SAMPLE;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(CHANNELS, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE, 28);
  wav.writeUInt16LE(CHANNELS * BYTES_PER_SAMPLE, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < frameCount; i += 1) {
    const offset = 44 + i * CHANNELS * BYTES_PER_SAMPLE;
    wav.writeInt16LE(toInt16(buffer.left[i]), offset);
    wav.writeInt16LE(toInt16(buffer.right[i]), offset + BYTES_PER_SAMPLE);
  }
  return wav;
}

function inspectWav(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("Missing RIFF header");
  }
  if (buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Missing WAVE signature");
  }
  if (buffer.toString("ascii", 12, 16) !== "fmt ") {
    throw new Error("Missing fmt chunk");
  }
  if (buffer.toString("ascii", 36, 40) !== "data") {
    throw new Error("Missing data chunk");
  }
  const channels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const bitsPerSample = buffer.readUInt16LE(34);
  const dataBytes = buffer.readUInt32LE(40);
  return {
    channels,
    sampleRate,
    bitsPerSample,
    durationSeconds: dataBytes / (sampleRate * channels * (bitsPerSample / 8)),
  };
}

function toInt16(sample) {
  const value = clamp(sample, -1, 1);
  return Math.round(value * 32767);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 1_000_000) / 1_000_000;
  };
}

function hashString(value) {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function isMainModule() {
  return (
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  );
}
