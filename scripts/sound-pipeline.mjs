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
  addFilteredNoise(buffer, rng, {
    start: 0,
    duration: 0.95,
    amp: 0.018,
    pan: -0.08,
    panEnd: 0.14,
    color: "shimmer",
    attack: 0.08,
    release: 1.7,
  });
  addBell(buffer, {
    start: 0.02,
    duration: 0.82,
    freq: 740,
    amp: 0.09,
    pan: -0.32,
  });
  addBell(buffer, {
    start: 0.14,
    duration: 0.66,
    freq: 1110,
    amp: 0.062,
    pan: 0.28,
  });
  addBell(buffer, {
    start: 0.31,
    duration: 0.42,
    freq: 1480,
    amp: 0.042,
    pan: 0.05,
  });
  addGlints(buffer, rng, {
    count: 6,
    start: 0.12,
    spread: 0.65,
    baseFreq: 1560,
    amp: 0.026,
  });
  addRoomTail(buffer, { amount: 0.12, delayMs: 45, feedback: 0.2 });
}

function renderRollStart(buffer, rng) {
  addImpact(buffer, rng, {
    start: 0.015,
    duration: 0.18,
    freq: 148,
    amp: 0.18,
    pan: -0.08,
    color: "wood",
  });
  addPitchSweep(buffer, {
    start: 0.04,
    duration: 0.5,
    fromFreq: 170,
    toFreq: 245,
    amp: 0.048,
    pan: 0,
    attack: 0.025,
    release: 1.35,
  });
  for (const start of [0.055, 0.12, 0.19, 0.29, 0.43]) {
    addCoinClick(buffer, rng, {
      start: start + rng() * 0.012,
      amp: 0.19 + rng() * 0.045,
      freq: 620 + rng() * 260,
      pan: -0.55 + rng() * 1.1,
    });
  }
  addRoomTail(buffer, { amount: 0.08, delayMs: 32, feedback: 0.12 });
}

function renderResultCascade(buffer, rng) {
  addFilteredNoise(buffer, rng, {
    start: 0.0,
    duration: 0.42,
    amp: 0.032,
    pan: -0.42,
    panEnd: 0.48,
    color: "paper",
    attack: 0.015,
    release: 1.25,
  });
  for (const [index, start] of [
    0.035, 0.095, 0.17, 0.245, 0.35, 0.47,
  ].entries()) {
    addCoinClick(buffer, rng, {
      start: start + rng() * 0.01,
      amp: 0.125 + index * 0.012,
      freq: 690 + index * 58 + rng() * 100,
      pan: index % 2 === 0 ? -0.34 : 0.34,
    });
  }
  addBell(buffer, {
    start: 0.24,
    duration: 0.34,
    freq: 520,
    amp: 0.042,
    pan: 0.08,
  });
  addRoomTail(buffer, { amount: 0.09, delayMs: 39, feedback: 0.14 });
}

function renderHoardCascade(buffer, rng) {
  addImpact(buffer, rng, {
    start: 0,
    duration: 0.32,
    freq: 86,
    amp: 0.25,
    pan: -0.12,
    color: "wood",
  });
  addFilteredNoise(buffer, rng, {
    start: 0.1,
    duration: 0.62,
    amp: 0.045,
    pan: -0.35,
    panEnd: 0.42,
    color: "coin",
    attack: 0.025,
    release: 1.8,
  });
  for (const start of [
    0.085, 0.13, 0.19, 0.25, 0.335, 0.43, 0.55, 0.69, 0.82,
  ]) {
    addCoinClick(buffer, rng, {
      start: start + rng() * 0.018,
      amp: 0.18 + rng() * 0.09,
      freq: 700 + rng() * 460,
      pan: -0.7 + rng() * 1.4,
    });
  }
  addBell(buffer, {
    start: 0.36,
    duration: 0.44,
    freq: 330,
    amp: 0.04,
    pan: 0.2,
  });
  addRoomTail(buffer, { amount: 0.13, delayMs: 52, feedback: 0.2 });
}

function renderRareChime(buffer, rng) {
  addBell(buffer, {
    start: 0.0,
    duration: 0.76,
    freq: 880,
    amp: 0.13,
    pan: -0.16,
  });
  addBell(buffer, {
    start: 0.045,
    duration: 0.64,
    freq: 1320,
    amp: 0.078,
    pan: 0.24,
  });
  addBell(buffer, {
    start: 0.16,
    duration: 0.43,
    freq: 1760,
    amp: 0.046,
    pan: 0.04,
  });
  addFilteredNoise(buffer, rng, {
    start: 0.02,
    duration: 0.68,
    amp: 0.011,
    pan: 0.2,
    panEnd: -0.15,
    color: "shimmer",
    attack: 0.04,
    release: 2.1,
  });
  addRoomTail(buffer, { amount: 0.16, delayMs: 57, feedback: 0.24 });
}

function renderLegendaryChime(buffer, rng) {
  addPitchSweep(buffer, {
    start: 0.0,
    duration: 0.5,
    fromFreq: 130.81,
    toFreq: 146.83,
    amp: 0.048,
    pan: 0,
    attack: 0.09,
    release: 1.8,
  });
  addBell(buffer, {
    start: 0.02,
    duration: 1.02,
    freq: 523.25,
    amp: 0.108,
    pan: -0.24,
  });
  addBell(buffer, {
    start: 0.09,
    duration: 0.9,
    freq: 783.99,
    amp: 0.09,
    pan: 0.18,
  });
  addBell(buffer, {
    start: 0.19,
    duration: 0.76,
    freq: 1046.5,
    amp: 0.062,
    pan: 0.36,
  });
  addBell(buffer, {
    start: 0.35,
    duration: 0.52,
    freq: 1567.98,
    amp: 0.033,
    pan: -0.05,
  });
  addGlints(buffer, rng, {
    count: 7,
    start: 0.24,
    spread: 0.58,
    baseFreq: 1750,
    amp: 0.019,
  });
  addFilteredNoise(buffer, rng, {
    start: 0.1,
    duration: 0.88,
    amp: 0.014,
    pan: -0.18,
    panEnd: 0.2,
    color: "shimmer",
    attack: 0.08,
    release: 2.4,
  });
  addRoomTail(buffer, { amount: 0.18, delayMs: 64, feedback: 0.26 });
}

function renderUiOpen(buffer) {
  addBell(buffer, {
    start: 0.0,
    duration: 0.17,
    freq: 520,
    amp: 0.09,
    pan: -0.18,
  });
  addBell(buffer, {
    start: 0.075,
    duration: 0.16,
    freq: 780,
    amp: 0.064,
    pan: 0.2,
  });
  addRoomTail(buffer, { amount: 0.06, delayMs: 31, feedback: 0.08 });
}

function renderItemOpen(buffer, rng) {
  addFilteredNoise(buffer, rng, {
    start: 0.0,
    duration: 0.22,
    amp: 0.04,
    pan: -0.28,
    panEnd: 0.34,
    color: "paper",
    attack: 0.008,
    release: 1.1,
  });
  addBell(buffer, {
    start: 0.13,
    duration: 0.22,
    freq: 660,
    amp: 0.047,
    pan: 0.18,
  });
  addRoomTail(buffer, { amount: 0.06, delayMs: 34, feedback: 0.08 });
}

function renderPresetApply(buffer, rng) {
  addWoodClick(buffer, rng, {
    start: 0.006,
    duration: 0.045,
    freq: 430,
    amp: 0.13,
    pan: -0.1,
  });
  addBell(buffer, {
    start: 0.04,
    duration: 0.16,
    freq: 590,
    amp: 0.064,
    pan: -0.16,
  });
  addBell(buffer, {
    start: 0.12,
    duration: 0.16,
    freq: 790,
    amp: 0.048,
    pan: 0.18,
  });
  addRoomTail(buffer, { amount: 0.05, delayMs: 29, feedback: 0.07 });
}

function renderRosterAdd(buffer, rng) {
  addWoodClick(buffer, rng, {
    start: 0.004,
    duration: 0.05,
    freq: 360,
    amp: 0.12,
    pan: -0.18,
  });
  addBell(buffer, {
    start: 0.055,
    duration: 0.14,
    freq: 520,
    amp: 0.058,
    pan: 0.14,
  });
  addRoomTail(buffer, { amount: 0.045, delayMs: 28, feedback: 0.06 });
}

function renderRosterRemove(buffer, rng) {
  addWoodClick(buffer, rng, {
    start: 0.004,
    duration: 0.045,
    freq: 320,
    amp: 0.105,
    pan: 0.16,
  });
  addPitchSweep(buffer, {
    start: 0.045,
    duration: 0.18,
    fromFreq: 360,
    toFreq: 250,
    amp: 0.05,
    pan: -0.08,
    attack: 0.008,
    release: 1.9,
  });
  addFilteredNoise(buffer, rng, {
    start: 0.02,
    duration: 0.12,
    amp: 0.022,
    pan: 0.2,
    panEnd: -0.2,
    color: "cloth",
    attack: 0.006,
    release: 1.1,
  });
  addRoomTail(buffer, { amount: 0.035, delayMs: 25, feedback: 0.05 });
}

function renderLockToggle(buffer, rng) {
  addWoodClick(buffer, rng, {
    start: 0.005,
    duration: 0.07,
    freq: 390,
    amp: 0.26,
    pan: -0.2,
  });
  addWoodClick(buffer, rng, {
    start: 0.065,
    duration: 0.08,
    freq: 220,
    amp: 0.17,
    pan: 0.16,
  });
  addRoomTail(buffer, { amount: 0.045, delayMs: 24, feedback: 0.06 });
}

function renderChatSend(buffer, rng) {
  addFilteredNoise(buffer, rng, {
    start: 0.0,
    duration: 0.26,
    amp: 0.05,
    pan: -0.5,
    panEnd: 0.28,
    color: "paper",
    attack: 0.012,
    release: 1.15,
  });
  addBell(buffer, {
    start: 0.18,
    duration: 0.24,
    freq: 940,
    amp: 0.039,
    pan: 0.26,
  });
  addWoodClick(buffer, rng, {
    start: 0.31,
    duration: 0.055,
    freq: 500,
    amp: 0.11,
    pan: 0.06,
  });
  addRoomTail(buffer, { amount: 0.07, delayMs: 33, feedback: 0.1 });
}

function renderDeposit(buffer, rng) {
  addImpact(buffer, rng, {
    start: 0.0,
    duration: 0.2,
    freq: 118,
    amp: 0.19,
    pan: -0.12,
    color: "cloth",
  });
  for (const start of [0.09, 0.16, 0.27, 0.39, 0.48]) {
    addCoinClick(buffer, rng, {
      start: start + rng() * 0.012,
      amp: 0.13 + rng() * 0.065,
      freq: 660 + rng() * 360,
      pan: -0.45 + rng() * 0.9,
    });
  }
  addRoomTail(buffer, { amount: 0.08, delayMs: 36, feedback: 0.13 });
}

function renderClearReset(buffer, rng) {
  addFilteredNoise(buffer, rng, {
    start: 0.0,
    duration: 0.28,
    amp: 0.07,
    pan: 0.45,
    panEnd: -0.38,
    color: "paper",
    attack: 0.018,
    release: 1.05,
  });
  addPitchSweep(buffer, {
    start: 0.055,
    duration: 0.22,
    fromFreq: 240,
    toFreq: 145,
    amp: 0.055,
    pan: -0.08,
    attack: 0.02,
    release: 1.35,
  });
  addRoomTail(buffer, { amount: 0.045, delayMs: 29, feedback: 0.08 });
}

function renderWarningMuted(buffer, rng) {
  addImpact(buffer, rng, {
    start: 0.0,
    duration: 0.27,
    freq: 104,
    amp: 0.25,
    pan: 0,
    color: "cloth",
  });
  addWoodClick(buffer, rng, {
    start: 0.035,
    duration: 0.08,
    freq: 115,
    amp: 0.08,
    pan: -0.04,
  });
  addRoomTail(buffer, { amount: 0.035, delayMs: 27, feedback: 0.05 });
}

function renderMerchantSessionOpen(buffer, rng) {
  addWoodClick(buffer, rng, {
    start: 0.005,
    duration: 0.06,
    freq: 280,
    amp: 0.18,
    pan: -0.18,
  });
  addBell(buffer, {
    start: 0.06,
    duration: 0.22,
    freq: 540,
    amp: 0.09,
    pan: -0.1,
  });
  addBell(buffer, {
    start: 0.14,
    duration: 0.22,
    freq: 810,
    amp: 0.062,
    pan: 0.22,
  });
  addRoomTail(buffer, { amount: 0.07, delayMs: 34, feedback: 0.12 });
}

function renderMerchantPurchase(buffer, rng) {
  addImpact(buffer, rng, {
    start: 0.0,
    duration: 0.18,
    freq: 132,
    amp: 0.16,
    pan: -0.1,
    color: "cloth",
  });
  for (const start of [0.08, 0.16, 0.27, 0.38]) {
    addCoinClick(buffer, rng, {
      start: start + rng() * 0.012,
      amp: 0.16 + rng() * 0.06,
      freq: 680 + rng() * 320,
      pan: -0.4 + rng() * 0.8,
    });
  }
  addBell(buffer, {
    start: 0.45,
    duration: 0.12,
    freq: 720,
    amp: 0.04,
    pan: 0.1,
  });
  addRoomTail(buffer, { amount: 0.08, delayMs: 36, feedback: 0.13 });
}

function renderMerchantSale(buffer, rng) {
  for (const start of [0.02, 0.1, 0.19, 0.3]) {
    addCoinClick(buffer, rng, {
      start: start + rng() * 0.01,
      amp: 0.13 + rng() * 0.05,
      freq: 540 + rng() * 280,
      pan: -0.35 + rng() * 0.7,
    });
  }
  addPitchSweep(buffer, {
    start: 0.34,
    duration: 0.2,
    fromFreq: 360,
    toFreq: 520,
    amp: 0.06,
    pan: 0.08,
    attack: 0.012,
    release: 1.4,
  });
  addRoomTail(buffer, { amount: 0.06, delayMs: 30, feedback: 0.1 });
}

function renderMerchantBargainWin(buffer, rng) {
  addBell(buffer, {
    start: 0.0,
    duration: 0.55,
    freq: 660,
    amp: 0.11,
    pan: -0.18,
  });
  addBell(buffer, {
    start: 0.06,
    duration: 0.5,
    freq: 990,
    amp: 0.072,
    pan: 0.24,
  });
  addBell(buffer, {
    start: 0.18,
    duration: 0.4,
    freq: 1320,
    amp: 0.045,
    pan: 0.0,
  });
  addGlints(buffer, rng, {
    count: 4,
    start: 0.12,
    spread: 0.45,
    baseFreq: 1500,
    amp: 0.02,
  });
  addRoomTail(buffer, { amount: 0.12, delayMs: 45, feedback: 0.2 });
}

function renderMerchantBargainFail(buffer, rng) {
  addImpact(buffer, rng, {
    start: 0.0,
    duration: 0.24,
    freq: 96,
    amp: 0.2,
    pan: 0.04,
    color: "wood",
  });
  addPitchSweep(buffer, {
    start: 0.05,
    duration: 0.28,
    fromFreq: 280,
    toFreq: 160,
    amp: 0.055,
    pan: -0.06,
    attack: 0.018,
    release: 1.3,
  });
  addRoomTail(buffer, { amount: 0.04, delayMs: 26, feedback: 0.07 });
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
  fadeEdges(buffer, 0.004);
  softLimit(buffer, 1.18);
  normalize(buffer, peak);
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

function addWoodClick(buffer, rng, { start, duration, freq, amp, pan }) {
  addFilteredNoise(buffer, rng, {
    start,
    duration: duration * 0.52,
    amp: amp * 0.48,
    pan,
    color: "wood",
    attack: 0.001,
    release: 0.92,
  });
  addTone(buffer, {
    start: start + 0.002,
    duration,
    freq,
    amp: amp * 0.46,
    pan,
    attack: 0.001,
    release: 4.8,
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

function addRoomTail(buffer, { amount, delayMs, feedback }) {
  const delayLeft = Math.max(1, Math.round((delayMs / 1000) * SAMPLE_RATE));
  const delayRight = Math.max(
    1,
    Math.round(((delayMs * 1.31) / 1000) * SAMPLE_RATE),
  );
  for (let i = delayLeft; i < buffer.left.length; i += 1) {
    buffer.left[i] += buffer.right[i - delayLeft] * amount;
    buffer.left[i] += buffer.left[i - delayLeft] * feedback * 0.18;
  }
  for (let i = delayRight; i < buffer.right.length; i += 1) {
    buffer.right[i] += buffer.left[i - delayRight] * amount * 0.9;
    buffer.right[i] += buffer.right[i - delayRight] * feedback * 0.16;
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
