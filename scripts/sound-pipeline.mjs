#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
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
const MAX_FOLEY_DURATION_SECONDS = 4;
const MAX_FOLEY_FILE_BYTES = 1_500_000;
const MIN_FOLEY_DURATION_SECONDS = 0.025;
const MIN_FOLEY_PEAK = 0.0005;
const MIN_FOLEY_RMS = 0.00002;
const MAX_FOLEY_DC_OFFSET = 0.01;
const MAX_FOLEY_CREST_DB = 34;
const MAX_FOLEY_STEREO_BALANCE_DB = 6;
const TAU = Math.PI * 2;

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const soundRoot = path.join(root, "assets", "sounds");
const foleyRoot = path.join(soundRoot, "foley");
const previewPath = path.join(
  root,
  "output",
  "infinity-dnd5e-sound-preview.wav",
);

const FOLEY_GROUPS = Object.freeze({
  page: Object.freeze(["page-01.wav", "page-02.wav", "page-03.wav"]),
  wood: Object.freeze(["wood-01.wav", "wood-02.wav", "wood-03.wav"]),
  metal: Object.freeze(["metal-01.wav", "metal-02.wav", "metal-03.wav"]),
  coin: Object.freeze(["coin-01.wav", "coin-02.wav", "coin-03.wav"]),
  cloth: Object.freeze(["cloth-01.wav", "cloth-02.wav"]),
});

// These are the normalized, redistributable source takes approved for this
// module. Pinning their bytes makes accidental replacement, format drift, and
// provenance mistakes fail before any committed output can be regenerated.
const FOLEY_SHA256 = Object.freeze({
  "page-01.wav":
    "c2efe256d0503dcb4c7cc552702c088c23982e5304ea88df5e6befab4135c6d5",
  "page-02.wav":
    "c509e67424fa4d94182e0fb6d9974f923c53d7404d79480242d83ced4a3a3773",
  "page-03.wav":
    "bb6764b98f55807bc6f918163d72a7a1469bf3f0df1f9e834b960bf1125ba81f",
  "wood-01.wav":
    "ae467980b7a733796a2a5ee2fb38ffbf145a7e3a958d3d43ab9983645bf12c50",
  "wood-02.wav":
    "7dcebe6090b7e88b47a1861d02766558804c590f547b6c6e79f52d12614c2a24",
  "wood-03.wav":
    "37efbc4ef953e897ea93b7c7afb6538f284bd5685de2b7cf247fd3d877a9efc6",
  "metal-01.wav":
    "8ed0c1f1de06c2a41a09b47e6152ca331c43308b0501fd832b60e1ba2ba7ef66",
  "metal-02.wav":
    "2ba43ecee330b9ad89a4664c1bde77c23090a0b9a56d3fdb990895dfa0e4c729",
  "metal-03.wav":
    "2b4b2f204c249c68c3aedf75af14aef14b18d2240a17eb0624d176750a1f030c",
  "coin-01.wav":
    "109cc7c4720678ecc3328083d6bb9de31b192965925518e0cfa86f01fdd94155",
  "coin-02.wav":
    "1ebdf9b0e84a3bd9d2a83718c50292d28aed7340b073c01861e267497e7e68dd",
  "coin-03.wav":
    "4d66fad9761008383abbe15100f40c71ea3adc06159572ac97171f1b0afdcaa9",
  "cloth-01.wav":
    "c6bf3fa7b66ace37dbbd3fd42a15a1c25343650ad00e9e394786900ca9665163",
  "cloth-02.wav":
    "ff22ce534f9751763c582f4aa521cf78c1027bc2bc596f561dd236cf88caaef1",
});

const MASTERING_PROFILES = Object.freeze({
  atmosphere: Object.freeze({
    targetPeak: 0.56,
    minimumRms: 0.018,
    maximumRms: 0.25,
    maximumCrestDb: 32,
    maximumStereoBalanceDb: 2.2,
    lowPassHz: 14_500,
    limiterDrive: 1.08,
    accentPeakRatio: 0.22,
  }),
  action: Object.freeze({
    targetPeak: 0.7,
    minimumRms: 0.01,
    maximumRms: 0.32,
    maximumCrestDb: 36,
    maximumStereoBalanceDb: 2.4,
    lowPassHz: 15_200,
    limiterDrive: 1.16,
    accentPeakRatio: 0.2,
  }),
  reward: Object.freeze({
    targetPeak: 0.66,
    minimumRms: 0.012,
    maximumRms: 0.3,
    maximumCrestDb: 35.5,
    maximumStereoBalanceDb: 2.5,
    lowPassHz: 15_800,
    limiterDrive: 1.12,
    accentPeakRatio: 0.26,
  }),
  chime: Object.freeze({
    targetPeak: 0.68,
    minimumRms: 0.014,
    maximumRms: 0.28,
    maximumCrestDb: 32,
    maximumStereoBalanceDb: 2.6,
    lowPassHz: 16_000,
    limiterDrive: 1.08,
    accentPeakRatio: 0.32,
  }),
  interface: Object.freeze({
    targetPeak: 0.55,
    minimumRms: 0.014,
    maximumRms: 0.3,
    maximumCrestDb: 33,
    maximumStereoBalanceDb: 2,
    lowPassHz: 13_800,
    limiterDrive: 1.15,
    accentPeakRatio: 0.18,
  }),
  transaction: Object.freeze({
    targetPeak: 0.63,
    minimumRms: 0.01,
    maximumRms: 0.32,
    maximumCrestDb: 36,
    maximumStereoBalanceDb: 2.4,
    lowPassHz: 15_000,
    limiterDrive: 1.16,
    accentPeakRatio: 0.2,
  }),
  warning: Object.freeze({
    targetPeak: 0.5,
    minimumRms: 0.009,
    maximumRms: 0.34,
    maximumCrestDb: 35,
    maximumStereoBalanceDb: 1.5,
    lowPassHz: 11_500,
    limiterDrive: 1.2,
    accentPeakRatio: 0.14,
  }),
});

const ROOM_PROFILES = Object.freeze({
  close: Object.freeze({
    amount: 0.04,
    spread: 0.78,
    taps: Object.freeze([
      [6, 0.62],
      [13, 0.34],
      [23, 0.16],
    ]),
  }),
  folio: Object.freeze({
    amount: 0.055,
    spread: 0.9,
    taps: Object.freeze([
      [8, 0.68],
      [17, 0.42],
      [31, 0.23],
      [47, 0.12],
    ]),
  }),
  desk: Object.freeze({
    amount: 0.07,
    spread: 0.84,
    taps: Object.freeze([
      [9, 0.72],
      [21, 0.46],
      [38, 0.26],
      [59, 0.13],
    ]),
  }),
  table: Object.freeze({
    amount: 0.09,
    spread: 1.02,
    taps: Object.freeze([
      [11, 0.72],
      [25, 0.5],
      [43, 0.3],
      [69, 0.15],
    ]),
  }),
  shop: Object.freeze({
    amount: 0.105,
    spread: 1.14,
    taps: Object.freeze([
      [13, 0.7],
      [29, 0.48],
      [51, 0.29],
      [83, 0.15],
    ]),
  }),
  hall: Object.freeze({
    amount: 0.14,
    spread: 1.28,
    taps: Object.freeze([
      [17, 0.72],
      [37, 0.52],
      [67, 0.33],
      [103, 0.18],
    ]),
  }),
  vault: Object.freeze({
    amount: 0.16,
    spread: 1.36,
    taps: Object.freeze([
      [19, 0.75],
      [43, 0.54],
      [79, 0.34],
      [119, 0.18],
    ]),
  }),
  muted: Object.freeze({
    amount: 0.035,
    spread: 0.72,
    taps: Object.freeze([
      [7, 0.58],
      [15, 0.28],
      [27, 0.11],
    ]),
  }),
});

const SOUND_SPECS = Object.freeze({
  "loading-shimmer": {
    duration: 1.0,
    family: "atmosphere",
    room: "folio",
    primary: foleyLayer("page", [0, 1], 0.86, { width: 1.05 }),
    secondary: foleyLayer("cloth", [0, 1], 0.24, {
      start: 0.045,
      pan: -0.1,
    }),
    accentGain: 0.2,
    render: renderLoadingShimmer,
  },
  "roll-start": {
    duration: 0.62,
    family: "action",
    room: "table",
    primary: foleyLayer("wood", [0, 1, 2], 0.88),
    secondary: foleyLayer("coin", [2, 0, 1], 0.32, { start: 0.035 }),
    accentGain: 0.17,
    render: renderRollStart,
  },
  "result-cascade": {
    duration: 0.68,
    family: "reward",
    room: "shop",
    primary: foleyLayer("coin", [0, 1, 2], 0.86, { width: 1.08 }),
    secondary: foleyLayer("cloth", [0, 1, 0], 0.2),
    accentGain: 0.16,
    render: renderResultCascade,
  },
  "hoard-cascade": {
    duration: 1.0,
    family: "reward",
    room: "vault",
    peakScale: 1.06,
    primary: foleyLayer("coin", [1, 2], 0.92, { width: 1.15 }),
    secondary: foleyLayer("wood", [0, 2], 0.27, { start: 0.02 }),
    accentGain: 0.18,
    render: renderHoardCascade,
  },
  "rare-chime": {
    duration: 0.82,
    family: "chime",
    room: "hall",
    primary: foleyLayer("metal", [0, 1], 0.82, { width: 1.08 }),
    accentGain: 0.2,
    render: renderRareChime,
  },
  "legendary-chime": {
    duration: 1.12,
    family: "chime",
    room: "vault",
    peakScale: 1.03,
    primary: foleyLayer("metal", [1, 2], 0.86, { width: 1.14 }),
    secondary: foleyLayer("wood", [2, 1], 0.14, { start: 0.012 }),
    accentGain: 0.24,
    render: renderLegendaryChime,
  },
  "ui-open": {
    duration: 0.3,
    family: "interface",
    room: "folio",
    primary: foleyLayer("page", [0, 1, 2], 0.9, { width: 1.05 }),
    secondary: foleyLayer("wood", [2, 0, 1], 0.15),
    accentGain: 0.12,
    render: renderUiOpen,
  },
  "item-open": {
    duration: 0.42,
    family: "interface",
    room: "folio",
    primary: foleyLayer("page", [1, 2, 0], 0.92, { width: 1.08 }),
    secondary: foleyLayer("wood", [1, 2, 0], 0.12, { start: 0.11 }),
    accentGain: 0.1,
    render: renderItemOpen,
  },
  "preset-apply": {
    duration: 0.32,
    family: "interface",
    room: "desk",
    primary: foleyLayer("wood", [0, 1, 2], 0.9),
    secondary: foleyLayer("page", [2, 0, 1], 0.16),
    accentGain: 0.12,
    render: renderPresetApply,
  },
  "roster-add": {
    duration: 0.26,
    family: "interface",
    room: "close",
    primary: foleyLayer("coin", [0, 1], 0.84),
    secondary: foleyLayer("cloth", [0, 1], 0.23),
    accentGain: 0.11,
    render: renderRosterAdd,
  },
  "roster-remove": {
    duration: 0.28,
    family: "interface",
    room: "close",
    peakScale: 0.9,
    primary: foleyLayer("cloth", [0, 1], 0.92, { width: 1.04 }),
    secondary: foleyLayer("coin", [1, 2], 0.12, { start: 0.04 }),
    accentGain: 0.08,
    render: renderRosterRemove,
  },
  "lock-toggle": {
    duration: 0.22,
    family: "interface",
    room: "desk",
    peakScale: 1.08,
    primary: foleyLayer("metal", [0, 1], 0.9),
    secondary: foleyLayer("wood", [1, 2], 0.18),
    accentGain: 0.12,
    render: renderLockToggle,
  },
  "chat-send": {
    duration: 0.52,
    family: "interface",
    room: "folio",
    primary: foleyLayer("page", [1, 2], 0.9, { width: 1.12 }),
    secondary: foleyLayer("wood", [0, 2], 0.13, { start: 0.25 }),
    accentGain: 0.08,
    render: renderChatSend,
  },
  deposit: {
    duration: 0.6,
    family: "transaction",
    room: "table",
    primary: foleyLayer("coin", [0, 1, 2], 0.9, { width: 1.1 }),
    secondary: foleyLayer("cloth", [0, 1, 0], 0.23),
    accentGain: 0.14,
    render: renderDeposit,
  },
  "clear-reset": {
    duration: 0.38,
    family: "interface",
    room: "folio",
    primary: foleyLayer("page", [2, 0], 0.94, { width: 1.15 }),
    secondary: foleyLayer("cloth", [1, 0], 0.13),
    accentGain: 0.08,
    render: renderClearReset,
  },
  "warning-muted": {
    duration: 0.34,
    family: "warning",
    room: "muted",
    primary: foleyLayer("wood", [0, 1, 2], 0.94),
    secondary: foleyLayer("cloth", [0, 1, 0], 0.16),
    accentGain: 0.08,
    render: renderWarningMuted,
  },
  "merchant-session-open": {
    duration: 0.42,
    family: "transaction",
    room: "shop",
    primary: foleyLayer("metal", [0, 2], 0.82, { width: 1.06 }),
    secondary: foleyLayer("wood", [1, 0], 0.22),
    accentGain: 0.15,
    render: renderMerchantSessionOpen,
  },
  "merchant-purchase": {
    duration: 0.6,
    family: "transaction",
    room: "shop",
    primary: foleyLayer("coin", [0, 1, 2], 0.9, { width: 1.08 }),
    secondary: foleyLayer("wood", [2, 0, 1], 0.18),
    accentGain: 0.13,
    render: renderMerchantPurchase,
  },
  "merchant-sale": {
    duration: 0.58,
    family: "transaction",
    room: "shop",
    primary: foleyLayer("coin", [2, 0, 1], 0.88, { width: 1.1 }),
    secondary: foleyLayer("cloth", [1, 0, 1], 0.14),
    accentGain: 0.12,
    render: renderMerchantSale,
  },
  "merchant-bargain-win": {
    duration: 0.78,
    family: "reward",
    room: "shop",
    primary: foleyLayer("metal", [0, 2], 0.84, { width: 1.12 }),
    secondary: foleyLayer("coin", [1, 2], 0.28, { start: 0.035 }),
    accentGain: 0.18,
    render: renderMerchantBargainWin,
  },
  "merchant-bargain-fail": {
    duration: 0.5,
    family: "warning",
    room: "muted",
    primary: foleyLayer("wood", [1, 2], 0.94),
    secondary: foleyLayer("metal", [2, 0], 0.12, { start: 0.035 }),
    accentGain: 0.08,
    render: renderMerchantBargainFail,
  },
});

if (isMainModule()) {
  const command = process.argv[2] ?? "validate";
  if (command === "generate") {
    generateSounds();
  } else if (command === "validate") {
    validateSoundAssets();
  } else if (command === "preview") {
    generateSoundPreview();
  } else {
    console.error(
      "Usage: node scripts/sound-pipeline.mjs <generate|validate|preview>",
    );
    process.exit(1);
  }
}

export function generateSounds() {
  const contracts = validateRegistryContract();
  const foleyLibrary = loadFoleyLibrary();
  const outputs = buildSoundOutputs(contracts, foleyLibrary);
  for (const output of outputs) {
    const filePath = resolveOwnedPath(output.file, soundRoot, "sound output");
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, output.wav);
  }
  const prunedFiles = pruneUnexpectedOutputWavs(outputs);
  console.log(
    `generated ${outputs.length} hybrid recorded-foley sound variant(s)`,
  );
  if (prunedFiles.length > 0) {
    console.log(
      `pruned ${prunedFiles.length} obsolete top-level sound WAV(s): ${prunedFiles.join(", ")}`,
    );
  } else {
    console.log("pruned 0 obsolete top-level sound WAV(s)");
  }
  return {
    assetCount: outputs.length,
    eventCount: contracts.length,
    prunedCount: prunedFiles.length,
  };
}

export function validateSoundAssets() {
  const contracts = validateRegistryContract();
  const foleyLibrary = loadFoleyLibrary();
  const outputs = buildSoundOutputs(contracts, foleyLibrary);
  rejectUnexpectedOutputWavs(outputs);

  const outputHashes = new Map();
  for (const output of outputs) {
    const filePath = resolveOwnedPath(output.file, soundRoot, "sound output");
    if (!existsSync(filePath)) {
      throw new Error(
        `Generated sound output is missing: ${output.file}. Run npm run sound:generate.`,
      );
    }
    const stat = statSync(filePath);
    if (!stat.isFile()) throw new Error(`${output.file} is not a regular file`);
    if (stat.size <= 44) throw new Error(`${output.file} is too small`);
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(`${output.file} is too large (${stat.size} bytes)`);
    }

    const actualBytes = readFileSync(filePath);
    const wav = parsePcmWav(actualBytes, output.file);
    if (wav.sampleRate !== SAMPLE_RATE) {
      throw new Error(`${output.file} sample rate ${wav.sampleRate} != 44100`);
    }
    if (wav.channels !== CHANNELS) {
      throw new Error(`${output.file} channel count ${wav.channels} != 2`);
    }
    if (wav.bitsPerSample !== 16) {
      throw new Error(`${output.file} bit depth ${wav.bitsPerSample} != 16`);
    }
    if (
      wav.durationSeconds <= 0 ||
      wav.durationSeconds > MAX_DURATION_SECONDS
    ) {
      throw new Error(
        `${output.file} duration ${wav.durationSeconds.toFixed(3)}s is invalid`,
      );
    }
    if (wav.frameCount !== output.buffer.left.length) {
      throw new Error(
        `${output.file} frame count ${wav.frameCount} != ${output.buffer.left.length}`,
      );
    }

    const decoded = decodePcmWav(actualBytes, output.file, wav);
    validateOutputMetrics(output, analyzeStereo(decoded.left, decoded.right));
    if (!actualBytes.equals(output.wav)) {
      throw new Error(
        `${output.file} is not the byte-for-byte deterministic render. Run npm run sound:generate.`,
      );
    }

    const outputHash = sha256(actualBytes);
    const duplicate = outputHashes.get(outputHash);
    if (duplicate) {
      throw new Error(
        `Sound outputs must be acoustically distinct: ${duplicate} and ${output.file} have identical bytes`,
      );
    }
    outputHashes.set(outputHash, output.file);
  }

  console.log(
    `sound asset validation passed (${outputs.length} WAV variants, ${foleyLibrary.size} recorded foley sources)`,
  );
  return {
    assetCount: outputs.length,
    eventCount: contracts.length,
    sourceCount: foleyLibrary.size,
  };
}

export function generateSoundPreview() {
  const contracts = validateRegistryContract();
  const foleyLibrary = loadFoleyLibrary();
  const outputs = buildSoundOutputs(contracts, foleyLibrary);
  const preview = buildPreviewBuffer(contracts, outputs);
  mkdirSync(path.dirname(previewPath), { recursive: true });
  writeFileSync(previewPath, encodeWav(preview));
  console.log(
    `wrote ${path.relative(root, previewPath)} (${outputs.length} variants, ${(preview.left.length / SAMPLE_RATE).toFixed(2)}s)`,
  );
  return previewPath;
}

function foleyLayer(group, takes, gain, options = {}) {
  return Object.freeze({
    group,
    takes: Object.freeze([...takes]),
    gain,
    start: options.start ?? 0,
    pan: options.pan ?? 0,
    width: options.width ?? 1,
  });
}

function validateRegistryContract() {
  const seenIds = new Set();
  const seenFiles = new Set();
  const contracts = [];
  for (const [key, entry] of Object.entries(SOUND_REGISTRY)) {
    if (!entry || typeof entry !== "object") {
      throw new Error(`${key} has no sound registry entry`);
    }
    if (entry.id !== key || !/^[a-z][a-z0-9-]*$/.test(entry.id)) {
      throw new Error(
        `${key} has an invalid or mismatched sound id ${entry.id}`,
      );
    }
    if (seenIds.has(entry.id))
      throw new Error(`Duplicate sound id ${entry.id}`);
    seenIds.add(entry.id);
    if (!Array.isArray(entry.files) || entry.files.length === 0) {
      throw new Error(`${key} must declare at least one sound variant file`);
    }
    if (
      !Array.isArray(entry.srcs) ||
      entry.srcs.length !== entry.files.length
    ) {
      throw new Error(`${key} files/srcs variant counts do not match`);
    }
    if (entry.file !== entry.files[0] || entry.src !== entry.srcs[0]) {
      throw new Error(`${key} compatibility file/src must point to variant 01`);
    }
    if (
      !Number.isFinite(entry.volume) ||
      entry.volume < 0 ||
      entry.volume > 1
    ) {
      throw new Error(`${key} volume ${entry.volume} must be between 0 and 1`);
    }

    const spec = SOUND_SPECS[entry.id];
    if (!spec) throw new Error(`${key} has no hybrid sound spec`);
    validateSoundSpec(entry, spec);
    for (let index = 0; index < entry.files.length; index += 1) {
      const expectedFile = `assets/sounds/${entry.id}-${String(index + 1).padStart(2, "0")}.wav`;
      const expectedSrc = `modules/infinity-dnd5e/${expectedFile}`;
      if (entry.files[index] !== expectedFile) {
        throw new Error(
          `${key} variant ${index + 1} must be named ${expectedFile}; found ${entry.files[index]}`,
        );
      }
      if (entry.srcs[index] !== expectedSrc) {
        throw new Error(
          `${key} variant ${index + 1} source must be ${expectedSrc}; found ${entry.srcs[index]}`,
        );
      }
      resolveOwnedPath(entry.files[index], soundRoot, "sound output");
      if (seenFiles.has(entry.files[index])) {
        throw new Error(`Duplicate sound file ${entry.files[index]}`);
      }
      seenFiles.add(entry.files[index]);
    }

    const primaryFiles = entry.files.map((_, variantIndex) =>
      foleyFileForLayer(spec.primary, variantIndex),
    );
    if (new Set(primaryFiles).size !== entry.files.length) {
      throw new Error(
        `${key} must use a different recorded primary take for every variant`,
      );
    }
    contracts.push({ key, entry, spec });
  }

  const extraSpecs = Object.keys(SOUND_SPECS).filter((id) => !seenIds.has(id));
  if (extraSpecs.length > 0) {
    throw new Error(
      `Hybrid sound specs are not registered: ${extraSpecs.join(", ")}`,
    );
  }
  return contracts;
}

function validateSoundSpec(entry, spec) {
  if (
    !Number.isFinite(spec.duration) ||
    spec.duration <= 0 ||
    spec.duration > MAX_DURATION_SECONDS
  ) {
    throw new Error(`${entry.id} has invalid duration ${spec.duration}`);
  }
  if (typeof spec.render !== "function") {
    throw new Error(`${entry.id} has no synthesis-accent renderer`);
  }
  if (!MASTERING_PROFILES[spec.family]) {
    throw new Error(`${entry.id} has unknown mastering family ${spec.family}`);
  }
  if (!ROOM_PROFILES[spec.room]) {
    throw new Error(`${entry.id} has unknown room profile ${spec.room}`);
  }
  validateFoleyLayer(entry.id, spec.primary, entry.files.length, "primary");
  if (spec.secondary) {
    validateFoleyLayer(
      entry.id,
      spec.secondary,
      entry.files.length,
      "secondary",
    );
  }
  if (
    !Number.isFinite(spec.accentGain) ||
    spec.accentGain < 0 ||
    spec.accentGain > 0.35
  ) {
    throw new Error(`${entry.id} has invalid synthesis accent gain`);
  }
  if (
    spec.peakScale !== undefined &&
    (!Number.isFinite(spec.peakScale) ||
      spec.peakScale < 0.75 ||
      spec.peakScale > 1.1)
  ) {
    throw new Error(`${entry.id} has invalid peak scale ${spec.peakScale}`);
  }
}

function validateFoleyLayer(eventId, layer, variantCount, role) {
  if (!layer || !FOLEY_GROUPS[layer.group]) {
    throw new Error(
      `${eventId} has unknown ${role} foley group ${layer?.group}`,
    );
  }
  if (!Array.isArray(layer.takes) || layer.takes.length < variantCount) {
    throw new Error(
      `${eventId} does not declare enough ${role} recorded takes`,
    );
  }
  for (const take of layer.takes) {
    if (!Number.isInteger(take) || !FOLEY_GROUPS[layer.group][take]) {
      throw new Error(`${eventId} has invalid ${role} foley take ${take}`);
    }
  }
  for (const [label, value, minimum, maximum] of [
    ["gain", layer.gain, 0, 1.2],
    ["start", layer.start, 0, MAX_DURATION_SECONDS],
    ["pan", layer.pan, -1, 1],
    ["width", layer.width, 0, 1.5],
  ]) {
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
      throw new Error(`${eventId} has invalid ${role} ${label} ${value}`);
    }
  }
}

function loadFoleyLibrary() {
  const expectedFiles = new Set(Object.values(FOLEY_GROUPS).flat());
  const pinnedFiles = new Set(Object.keys(FOLEY_SHA256));
  if (
    expectedFiles.size !== pinnedFiles.size ||
    [...expectedFiles].some((fileName) => !pinnedFiles.has(fileName))
  ) {
    throw new Error(
      "Internal foley source list and SHA-256 manifest do not match",
    );
  }
  const manifestAssets = loadFoleyManifest(expectedFiles);
  if (!existsSync(foleyRoot)) {
    throw new Error(
      "Normalized foley directory is missing: assets/sounds/foley. Expected page-01.wav through cloth-02.wav.",
    );
  }
  const unexpectedWavs = readdirSync(foleyRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.wav$/i.test(entry.name))
    .map((entry) => entry.name)
    .filter((name) => !expectedFiles.has(name))
    .sort();
  if (unexpectedWavs.length > 0) {
    throw new Error(
      `Unexpected normalized foley WAV(s): ${unexpectedWavs.join(", ")}`,
    );
  }

  const library = new Map();
  const sourceHashes = new Map();
  for (const [group, files] of Object.entries(FOLEY_GROUPS)) {
    for (let takeIndex = 0; takeIndex < files.length; takeIndex += 1) {
      const fileName = files[takeIndex];
      const relativeFile = `assets/sounds/foley/${fileName}`;
      const filePath = path.join(foleyRoot, fileName);
      if (!existsSync(filePath)) {
        throw new Error(`Missing normalized foley source: ${relativeFile}`);
      }
      const stat = statSync(filePath);
      if (!stat.isFile()) {
        throw new Error(
          `Normalized foley source is not a file: ${relativeFile}`,
        );
      }
      if (stat.size <= 44 || stat.size > MAX_FOLEY_FILE_BYTES) {
        throw new Error(
          `Normalized foley source has unsafe byte size: ${relativeFile} (${stat.size})`,
        );
      }
      const manifestAsset = manifestAssets.get(fileName);
      if (stat.size !== manifestAsset.byteCount) {
        throw new Error(
          `Normalized foley source byte count differs from its provenance manifest: ${relativeFile} (${stat.size} != ${manifestAsset.byteCount})`,
        );
      }
      const payload = readFileSync(filePath);
      let wav;
      let decoded;
      try {
        wav = parsePcmWav(payload, relativeFile);
        decoded = decodePcmWav(payload, relativeFile, wav);
      } catch (error) {
        throw new Error(
          `Invalid normalized foley source ${relativeFile}: ${error.message}`,
          { cause: error },
        );
      }
      validateFoleySource(relativeFile, wav, decoded);
      if (
        Math.abs(wav.durationSeconds - manifestAsset.durationSeconds) >
        1 / SAMPLE_RATE
      ) {
        throw new Error(
          `Normalized foley source duration differs from its provenance manifest: ${relativeFile}`,
        );
      }
      const sourceHash = sha256(payload);
      const expectedHash = FOLEY_SHA256[fileName];
      if (sourceHash !== expectedHash) {
        throw new Error(
          `Normalized foley source hash mismatch for ${relativeFile}: expected ${expectedHash}, found ${sourceHash}`,
        );
      }
      const duplicate = sourceHashes.get(sourceHash);
      if (duplicate) {
        throw new Error(
          `Recorded foley takes must be different: ${duplicate} and ${relativeFile} have identical bytes`,
        );
      }
      sourceHashes.set(sourceHash, relativeFile);
      library.set(`${group}:${takeIndex}`, {
        ...decoded,
        file: relativeFile,
        metrics: analyzeStereo(decoded.left, decoded.right),
      });
    }
  }
  return library;
}

function loadFoleyManifest(expectedFiles) {
  const manifestPath = path.join(foleyRoot, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      "Foley provenance manifest is missing: assets/sounds/foley/manifest.json",
    );
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Foley provenance manifest is invalid JSON: ${error.message}`,
      {
        cause: error,
      },
    );
  }
  if (manifest.schemaVersion !== 1) {
    throw new Error(
      `Unsupported foley provenance schema version ${manifest.schemaVersion}`,
    );
  }
  if (manifest.licensePolicy?.acceptedLicense !== "CC0-1.0") {
    throw new Error(
      "Foley provenance manifest must accept only CC0-1.0 sources",
    );
  }
  if (manifest.licensePolicy?.rawSourceArchivesCommitted !== false) {
    throw new Error(
      "Foley provenance manifest must record that raw source archives are not committed",
    );
  }
  if (
    manifest.normalization?.sampleRateHz !== SAMPLE_RATE ||
    manifest.normalization?.channels !== 1 ||
    manifest.normalization?.sampleWidthBits !== 16 ||
    manifest.normalization?.codec !== "pcm_s16le"
  ) {
    throw new Error("Foley provenance normalization contract has drifted");
  }

  if (
    !Array.isArray(manifest.sourcePackages) ||
    manifest.sourcePackages.length === 0
  ) {
    throw new Error("Foley provenance manifest has no source packages");
  }
  const packageIds = new Set();
  for (const sourcePackage of manifest.sourcePackages) {
    if (
      typeof sourcePackage?.id !== "string" ||
      !/^[a-z][a-z0-9-]*$/.test(sourcePackage.id) ||
      packageIds.has(sourcePackage.id)
    ) {
      throw new Error(
        `Foley provenance manifest has an invalid or duplicate source package id: ${sourcePackage?.id}`,
      );
    }
    if (sourcePackage.license !== "CC0-1.0") {
      throw new Error(
        `Foley source package ${sourcePackage.id} is not recorded as CC0-1.0`,
      );
    }
    if (!/^https:\/\//.test(sourcePackage.sourcePageUrl ?? "")) {
      throw new Error(
        `Foley source package ${sourcePackage.id} has no HTTPS source page`,
      );
    }
    if (!/^https:\/\//.test(sourcePackage.downloadUrl ?? "")) {
      throw new Error(
        `Foley source package ${sourcePackage.id} has no HTTPS download URL`,
      );
    }
    if (
      !Number.isSafeInteger(sourcePackage.archiveBytes) ||
      sourcePackage.archiveBytes <= 0
    ) {
      throw new Error(
        `Foley source package ${sourcePackage.id} has an invalid archive byte count`,
      );
    }
    if (!isSha256(sourcePackage.archiveSha256)) {
      throw new Error(
        `Foley source package ${sourcePackage.id} has an invalid archive SHA-256`,
      );
    }
    packageIds.add(sourcePackage.id);
  }

  if (!Array.isArray(manifest.assets)) {
    throw new Error("Foley provenance manifest has no asset records");
  }
  const assets = new Map();
  for (const asset of manifest.assets) {
    const fileName = path.basename(asset?.file ?? "");
    const expectedRelativeFile = `assets/sounds/foley/${fileName}`;
    if (
      asset?.file !== expectedRelativeFile ||
      !expectedFiles.has(fileName) ||
      assets.has(fileName)
    ) {
      throw new Error(
        `Foley provenance manifest has an invalid, unexpected, or duplicate asset path: ${asset?.file}`,
      );
    }
    if (!packageIds.has(asset.sourcePackageId)) {
      throw new Error(
        `Foley provenance asset ${asset.id} references unknown source package ${asset.sourcePackageId}`,
      );
    }
    if (!isSha256(asset.sourceSha256)) {
      throw new Error(
        `Foley provenance asset ${asset.id} has an invalid source-member SHA-256`,
      );
    }
    if (!isSha256(asset.sha256) || asset.sha256 !== FOLEY_SHA256[fileName]) {
      throw new Error(
        `Foley provenance asset ${asset.id} does not match the pinned normalized WAV SHA-256`,
      );
    }
    if (!Number.isSafeInteger(asset.byteCount) || asset.byteCount <= 44) {
      throw new Error(
        `Foley provenance asset ${asset.id} has an invalid normalized byte count`,
      );
    }
    if (!Number.isFinite(asset.durationSeconds) || asset.durationSeconds <= 0) {
      throw new Error(
        `Foley provenance asset ${asset.id} has an invalid normalized duration`,
      );
    }
    if (!Number.isFinite(asset.targetPeakDbfs) || asset.targetPeakDbfs > 0) {
      throw new Error(
        `Foley provenance asset ${asset.id} has an invalid target peak`,
      );
    }
    assets.set(fileName, asset);
  }
  if (
    assets.size !== expectedFiles.size ||
    [...expectedFiles].some((fileName) => !assets.has(fileName))
  ) {
    throw new Error(
      "Foley provenance manifest does not cover every pinned source WAV",
    );
  }
  return assets;
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validateFoleySource(relativeFile, wav, decoded) {
  if (wav.audioFormat !== 1) {
    throw new Error(`${relativeFile} must use integer PCM encoding`);
  }
  if (wav.sampleRate !== SAMPLE_RATE) {
    throw new Error(
      `${relativeFile} sample rate ${wav.sampleRate} must be ${SAMPLE_RATE}`,
    );
  }
  if (wav.channels !== 1 && wav.channels !== 2) {
    throw new Error(`${relativeFile} must be mono or stereo PCM`);
  }
  if (wav.bitsPerSample !== 16) {
    throw new Error(
      `${relativeFile} bit depth ${wav.bitsPerSample} must be 16`,
    );
  }
  if (
    wav.durationSeconds < MIN_FOLEY_DURATION_SECONDS ||
    wav.durationSeconds > MAX_FOLEY_DURATION_SECONDS
  ) {
    throw new Error(
      `${relativeFile} duration ${wav.durationSeconds.toFixed(3)}s is outside ${MIN_FOLEY_DURATION_SECONDS}..${MAX_FOLEY_DURATION_SECONDS}s`,
    );
  }
  const metrics = analyzeStereo(decoded.left, decoded.right);
  if (metrics.peak < MIN_FOLEY_PEAK || metrics.rms < MIN_FOLEY_RMS) {
    throw new Error(
      `${relativeFile} is silent or too quiet (peak=${metrics.peak.toFixed(5)}, rms=${metrics.rms.toFixed(5)})`,
    );
  }
  if (metrics.dcOffset > MAX_FOLEY_DC_OFFSET) {
    throw new Error(
      `${relativeFile} DC offset ${metrics.dcOffset.toFixed(6)} exceeds ${MAX_FOLEY_DC_OFFSET}`,
    );
  }
  if (metrics.crestDb > MAX_FOLEY_CREST_DB) {
    throw new Error(
      `${relativeFile} crest ${metrics.crestDb.toFixed(2)} dB exceeds ${MAX_FOLEY_CREST_DB} dB`,
    );
  }
  if (metrics.stereoBalanceDb > MAX_FOLEY_STEREO_BALANCE_DB) {
    throw new Error(
      `${relativeFile} stereo balance ${metrics.stereoBalanceDb.toFixed(2)} dB exceeds ${MAX_FOLEY_STEREO_BALANCE_DB} dB`,
    );
  }
}

function buildSoundOutputs(contracts, foleyLibrary) {
  return contracts.flatMap(({ entry, spec }) =>
    entry.files.map((file, variantIndex) => {
      const buffer = renderSoundVariant(
        entry.id,
        file,
        variantIndex,
        spec,
        foleyLibrary,
      );
      return {
        eventId: entry.id,
        family: spec.family,
        file,
        variantIndex,
        buffer,
        wav: encodeWav(buffer),
      };
    }),
  );
}

function renderSoundVariant(eventId, file, variantIndex, spec, foleyLibrary) {
  const buffer = createBuffer(spec.duration);
  addRecordedLayer(
    buffer,
    resolveFoleyTake(foleyLibrary, spec.primary, variantIndex),
    spec.primary,
  );
  if (spec.secondary) {
    addRecordedLayer(
      buffer,
      resolveFoleyTake(foleyLibrary, spec.secondary, variantIndex),
      spec.secondary,
    );
  }

  const accent = createBuffer(spec.duration);
  const rng = makeRng(hashString(`${eventId}\0${variantIndex + 1}\0${file}`));
  spec.render(accent, rng);
  const mastering = MASTERING_PROFILES[spec.family];
  addSubtleAccent(buffer, accent, spec.accentGain, mastering.accentPeakRatio);
  addRoomTail(buffer, { profile: spec.room });
  finishBuffer(buffer, spec);
  return buffer;
}

function resolveFoleyTake(library, layer, variantIndex) {
  const takeIndex = layer.takes[variantIndex];
  const source = library.get(`${layer.group}:${takeIndex}`);
  if (!source) {
    throw new Error(
      `Recorded foley source was not loaded: ${foleyFileForLayer(layer, variantIndex)}`,
    );
  }
  return source;
}

function foleyFileForLayer(layer, variantIndex) {
  const takeIndex = layer.takes[variantIndex];
  const fileName = FOLEY_GROUPS[layer.group]?.[takeIndex];
  return fileName ? `assets/sounds/foley/${fileName}` : "<invalid foley take>";
}

function addRecordedLayer(target, source, layer) {
  const startFrame = Math.round(layer.start * SAMPLE_RATE);
  const sourceBounds = activeSampleBounds(source.left, source.right);
  const availableFrames = Math.max(0, target.left.length - startFrame);
  const frameCount = Math.min(
    sourceBounds.end - sourceBounds.start,
    availableFrames,
  );
  if (frameCount <= 0) return;

  const fadeInFrames = Math.min(
    Math.round(0.004 * SAMPLE_RATE),
    frameCount >> 1,
  );
  const fadeOutFrames = Math.min(
    Math.round(0.025 * SAMPLE_RATE),
    frameCount >> 1,
  );
  const [leftPan, rightPan] = panGains(layer.pan);
  const panNormalization = Math.SQRT2;
  // Normalize each pinned recording before applying creative gain. The source
  // library contains both close, hot transients and deliberately quiet cloth
  // detail; this keeps every real take in charge of the rendered texture.
  const sourceNormalization = 0.62 / source.metrics.peak;
  for (let index = 0; index < frameCount; index += 1) {
    const sourceIndex = sourceBounds.start + index;
    const left = source.left[sourceIndex];
    const right = source.right[sourceIndex];
    const mid = (left + right) * 0.5;
    const side = (left - right) * 0.5 * layer.width;
    let envelope = 1;
    if (fadeInFrames > 0 && index < fadeInFrames) {
      envelope *= smoothstep(index / fadeInFrames);
    }
    const remaining = frameCount - index - 1;
    if (fadeOutFrames > 0 && remaining < fadeOutFrames) {
      envelope *= smoothstep(remaining / fadeOutFrames);
    }
    const outputIndex = startFrame + index;
    const gain = layer.gain * envelope * panNormalization * sourceNormalization;
    target.left[outputIndex] += (mid + side) * gain * leftPan;
    target.right[outputIndex] += (mid - side) * gain * rightPan;
  }
}

function activeSampleBounds(left, right) {
  let peak = 0;
  for (let index = 0; index < left.length; index += 1) {
    peak = Math.max(peak, Math.abs(left[index]), Math.abs(right[index]));
  }
  const threshold = Math.max(1 / 32768, peak * 0.018);
  let start = 0;
  while (
    start < left.length &&
    Math.max(Math.abs(left[start]), Math.abs(right[start])) < threshold
  ) {
    start += 1;
  }
  let end = left.length;
  while (
    end > start &&
    Math.max(Math.abs(left[end - 1]), Math.abs(right[end - 1])) < threshold
  ) {
    end -= 1;
  }
  const padding = Math.round(0.006 * SAMPLE_RATE);
  return {
    start: Math.max(0, start - padding),
    end: Math.min(left.length, end + padding),
  };
}

function addSubtleAccent(target, accent, requestedGain, maximumPeakRatio) {
  const targetPeak = stereoPeak(target);
  const accentPeak = stereoPeak(accent);
  if (targetPeak <= 0 || accentPeak <= 0 || requestedGain <= 0) return;
  const gain = Math.min(
    requestedGain,
    (targetPeak * maximumPeakRatio) / accentPeak,
  );
  for (let index = 0; index < target.left.length; index += 1) {
    target.left[index] += accent.left[index] * gain;
    target.right[index] += accent.right[index] * gain;
  }
}

function rejectUnexpectedOutputWavs(outputs) {
  const expectedNames = new Set(
    outputs.map((output) => path.basename(output.file)),
  );
  const unexpected = readdirSync(soundRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.wav$/i.test(entry.name))
    .map((entry) => entry.name)
    .filter((name) => !expectedNames.has(name))
    .sort();
  if (unexpected.length > 0) {
    throw new Error(
      `Unexpected top-level sound output WAV(s): ${unexpected.join(", ")}`,
    );
  }
}

function pruneUnexpectedOutputWavs(outputs) {
  const expectedNames = new Set(
    outputs.map((output) => path.basename(output.file)),
  );
  const obsoleteNames = readdirSync(soundRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.wav$/i.test(entry.name))
    .map((entry) => entry.name)
    .filter((name) => !expectedNames.has(name))
    .sort();
  for (const name of obsoleteNames) {
    const filePath = path.join(soundRoot, name);
    if (path.dirname(filePath) !== soundRoot) {
      throw new Error(
        `Refusing to prune sound WAV outside assets/sounds: ${name}`,
      );
    }
    unlinkSync(filePath);
  }
  return obsoleteNames;
}

function validateOutputMetrics(output, metrics) {
  const spec = SOUND_SPECS[output.eventId];
  const mastering = MASTERING_PROFILES[output.family];
  const targetPeak = mastering.targetPeak * (spec.peakScale ?? 1);
  if (metrics.rms < mastering.minimumRms) {
    throw new Error(
      `${output.file} is silent or too quiet (RMS ${metrics.rms.toFixed(5)} < ${mastering.minimumRms})`,
    );
  }
  if (metrics.rms > mastering.maximumRms) {
    throw new Error(
      `${output.file} RMS ${metrics.rms.toFixed(5)} exceeds ${mastering.maximumRms}`,
    );
  }
  if (Math.abs(metrics.peak - targetPeak) > 0.001) {
    throw new Error(
      `${output.file} peak ${metrics.peak.toFixed(5)} does not match family target ${targetPeak.toFixed(5)}`,
    );
  }
  if (metrics.dcOffset > 0.002) {
    throw new Error(
      `${output.file} DC offset ${metrics.dcOffset.toFixed(6)} exceeds 0.002`,
    );
  }
  if (metrics.crestDb > mastering.maximumCrestDb) {
    throw new Error(
      `${output.file} crest ${metrics.crestDb.toFixed(2)} dB exceeds ${mastering.maximumCrestDb} dB`,
    );
  }
  if (metrics.stereoBalanceDb > mastering.maximumStereoBalanceDb) {
    throw new Error(
      `${output.file} stereo balance ${metrics.stereoBalanceDb.toFixed(2)} dB exceeds ${mastering.maximumStereoBalanceDb} dB`,
    );
  }
}

function buildPreviewBuffer(contracts, outputs) {
  const variantGapFrames = Math.round(0.18 * SAMPLE_RATE);
  const eventGapFrames = Math.round(0.48 * SAMPLE_RATE);
  const outputByEvent = new Map();
  for (const output of outputs) {
    const variants = outputByEvent.get(output.eventId) ?? [];
    variants.push(output);
    outputByEvent.set(output.eventId, variants);
  }

  let totalFrames = 0;
  for (const [eventIndex, contract] of contracts.entries()) {
    const variants = outputByEvent.get(contract.entry.id) ?? [];
    for (const [variantIndex, output] of variants.entries()) {
      totalFrames += output.buffer.left.length;
      if (variantIndex < variants.length - 1) totalFrames += variantGapFrames;
    }
    if (eventIndex < contracts.length - 1) totalFrames += eventGapFrames;
  }

  const preview = {
    left: new Float32Array(totalFrames),
    right: new Float32Array(totalFrames),
  };
  let cursor = 0;
  for (const [eventIndex, contract] of contracts.entries()) {
    const variants = outputByEvent.get(contract.entry.id) ?? [];
    for (const [variantIndex, output] of variants.entries()) {
      preview.left.set(output.buffer.left, cursor);
      preview.right.set(output.buffer.right, cursor);
      cursor += output.buffer.left.length;
      if (variantIndex < variants.length - 1) cursor += variantGapFrames;
    }
    if (eventIndex < contracts.length - 1) cursor += eventGapFrames;
  }
  return preview;
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

function finishBuffer(buffer, spec) {
  const mastering = MASTERING_PROFILES[spec.family];
  if (!mastering) {
    throw new Error(`Unknown mastering family ${spec.family}`);
  }
  removeDc(buffer.left);
  removeDc(buffer.right);
  lowPass(buffer.left, mastering.lowPassHz);
  lowPass(buffer.right, mastering.lowPassHz);
  fadeEdges(buffer, 0.005);
  softLimit(buffer, mastering.limiterDrive);
  balanceStereo(buffer, mastering.maximumStereoBalanceDb);
  normalize(buffer, mastering.targetPeak * (spec.peakScale ?? 1));
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
function addRoomTail(buffer, { amount, room = 1, profile } = {}) {
  const roomProfile = profile ? ROOM_PROFILES[profile] : null;
  if (profile && !roomProfile)
    throw new Error(`Unknown room profile ${profile}`);
  const taps = roomProfile?.taps ?? [
    [9, 0.72],
    [17, 0.52],
    [26, 0.38],
    [37, 0.27],
    [50, 0.18],
    [65, 0.12],
    [83, 0.08],
  ];
  const wetAmount = amount ?? roomProfile?.amount ?? 0.1;
  const stereoSpread = roomProfile?.spread ?? 1.18;
  const srcLeft = buffer.left.slice();
  const srcRight = buffer.right.slice();
  const length = buffer.left.length;
  for (const [ms, gain] of taps) {
    const wet = gain * wetAmount;
    const delayLeft = Math.max(
      1,
      Math.round(((ms * room) / 1000) * SAMPLE_RATE),
    );
    const delayRight = Math.max(
      1,
      Math.round(((ms * room * stereoSpread) / 1000) * SAMPLE_RATE),
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
  const gain = peak / max;
  for (const samples of [buffer.left, buffer.right]) {
    for (let i = 0; i < samples.length; i += 1) samples[i] *= gain;
  }
}

function balanceStereo(buffer, maximumBalanceDb) {
  let leftSquareSum = 0;
  let rightSquareSum = 0;
  for (let index = 0; index < buffer.left.length; index += 1) {
    leftSquareSum += buffer.left[index] * buffer.left[index];
    rightSquareSum += buffer.right[index] * buffer.right[index];
  }
  const leftRms = Math.sqrt(leftSquareSum / buffer.left.length);
  const rightRms = Math.sqrt(rightSquareSum / buffer.right.length);
  if (leftRms <= Number.EPSILON || rightRms <= Number.EPSILON) return;

  const maximumRatio = 10 ** (maximumBalanceDb / 20);
  if (leftRms > rightRms * maximumRatio) {
    const gain = (rightRms * maximumRatio) / leftRms;
    for (let index = 0; index < buffer.left.length; index += 1) {
      buffer.left[index] *= gain;
    }
  } else if (rightRms > leftRms * maximumRatio) {
    const gain = (leftRms * maximumRatio) / rightRms;
    for (let index = 0; index < buffer.right.length; index += 1) {
      buffer.right[index] *= gain;
    }
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

function parsePcmWav(payload, label = "WAV") {
  if (!Buffer.isBuffer(payload))
    throw new Error(`${label} is not a byte buffer`);
  if (payload.length < 12)
    throw new Error(`${label} is shorter than a RIFF header`);
  if (payload.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error(`${label} is missing its RIFF header`);
  }
  if (payload.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${label} is missing its WAVE signature`);
  }
  const declaredBytes = payload.readUInt32LE(4) + 8;
  if (declaredBytes !== payload.length) {
    throw new Error(
      `${label} RIFF size declares ${declaredBytes} bytes but file has ${payload.length}`,
    );
  }

  let format = null;
  let data = null;
  let offset = 12;
  while (offset < payload.length) {
    if (offset + 8 > payload.length) {
      throw new Error(
        `${label} has a truncated chunk header at byte ${offset}`,
      );
    }
    const chunkId = payload.toString("ascii", offset, offset + 4);
    const chunkBytes = payload.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkBytes;
    if (chunkEnd > payload.length) {
      throw new Error(
        `${label} chunk ${JSON.stringify(chunkId)} overruns the file (${chunkBytes} bytes at ${chunkStart})`,
      );
    }

    if (chunkId === "fmt ") {
      if (format) throw new Error(`${label} has more than one fmt chunk`);
      if (chunkBytes < 16)
        throw new Error(`${label} fmt chunk is shorter than 16 bytes`);
      format = {
        audioFormat: payload.readUInt16LE(chunkStart),
        channels: payload.readUInt16LE(chunkStart + 2),
        sampleRate: payload.readUInt32LE(chunkStart + 4),
        byteRate: payload.readUInt32LE(chunkStart + 8),
        blockAlign: payload.readUInt16LE(chunkStart + 12),
        bitsPerSample: payload.readUInt16LE(chunkStart + 14),
      };
    } else if (chunkId === "data") {
      if (data) throw new Error(`${label} has more than one data chunk`);
      data = { dataOffset: chunkStart, dataBytes: chunkBytes };
    }

    offset = chunkEnd + (chunkBytes & 1);
    if (offset > payload.length) {
      throw new Error(
        `${label} is missing padding after chunk ${JSON.stringify(chunkId)}`,
      );
    }
  }
  if (!format) throw new Error(`${label} has no fmt chunk`);
  if (!data) throw new Error(`${label} has no data chunk`);
  if (format.audioFormat !== 1) {
    throw new Error(
      `${label} uses WAV format ${format.audioFormat}; only integer PCM is allowed`,
    );
  }
  if (format.channels !== 1 && format.channels !== 2) {
    throw new Error(
      `${label} has ${format.channels} channels; only mono or stereo is allowed`,
    );
  }
  if (format.bitsPerSample !== 16) {
    throw new Error(
      `${label} is ${format.bitsPerSample}-bit; only PCM16 is allowed`,
    );
  }
  if (!Number.isInteger(format.sampleRate) || format.sampleRate <= 0) {
    throw new Error(`${label} has invalid sample rate ${format.sampleRate}`);
  }
  const expectedBlockAlign = format.channels * BYTES_PER_SAMPLE;
  if (format.blockAlign !== expectedBlockAlign) {
    throw new Error(
      `${label} block alignment ${format.blockAlign} does not match ${expectedBlockAlign}`,
    );
  }
  const expectedByteRate = format.sampleRate * expectedBlockAlign;
  if (format.byteRate !== expectedByteRate) {
    throw new Error(
      `${label} byte rate ${format.byteRate} does not match ${expectedByteRate}`,
    );
  }
  if (data.dataBytes === 0 || data.dataBytes % expectedBlockAlign !== 0) {
    throw new Error(
      `${label} data size ${data.dataBytes} is empty or not aligned to ${expectedBlockAlign} bytes`,
    );
  }
  const frameCount = data.dataBytes / expectedBlockAlign;
  return {
    ...format,
    ...data,
    frameCount,
    durationSeconds: frameCount / format.sampleRate,
  };
}

function decodePcmWav(
  payload,
  label = "WAV",
  parsed = parsePcmWav(payload, label),
) {
  const left = new Float32Array(parsed.frameCount);
  const right = new Float32Array(parsed.frameCount);
  for (let frame = 0; frame < parsed.frameCount; frame += 1) {
    const frameOffset = parsed.dataOffset + frame * parsed.blockAlign;
    left[frame] = payload.readInt16LE(frameOffset) / 32768;
    right[frame] =
      parsed.channels === 1
        ? left[frame]
        : payload.readInt16LE(frameOffset + BYTES_PER_SAMPLE) / 32768;
  }
  return { left, right };
}

function analyzeStereo(left, right) {
  if (
    !(left instanceof Float32Array) ||
    !(right instanceof Float32Array) ||
    left.length === 0 ||
    left.length !== right.length
  ) {
    throw new Error(
      "Stereo analysis requires equal, non-empty Float32 channels",
    );
  }
  let peak = 0;
  let leftSum = 0;
  let rightSum = 0;
  let leftSquareSum = 0;
  let rightSquareSum = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftSample = left[index];
    const rightSample = right[index];
    peak = Math.max(peak, Math.abs(leftSample), Math.abs(rightSample));
    leftSum += leftSample;
    rightSum += rightSample;
    leftSquareSum += leftSample * leftSample;
    rightSquareSum += rightSample * rightSample;
  }
  const leftRms = Math.sqrt(leftSquareSum / left.length);
  const rightRms = Math.sqrt(rightSquareSum / right.length);
  const rms = Math.sqrt((leftSquareSum + rightSquareSum) / (left.length * 2));
  const dcOffset = Math.max(
    Math.abs(leftSum / left.length),
    Math.abs(rightSum / right.length),
  );
  let stereoBalanceDb = 0;
  if (leftRms > Number.EPSILON || rightRms > Number.EPSILON) {
    stereoBalanceDb =
      leftRms > Number.EPSILON && rightRms > Number.EPSILON
        ? Math.abs(20 * Math.log10(leftRms / rightRms))
        : Number.POSITIVE_INFINITY;
  }
  return {
    peak,
    rms,
    leftRms,
    rightRms,
    dcOffset,
    crestDb:
      rms > Number.EPSILON
        ? 20 * Math.log10(peak / rms)
        : Number.POSITIVE_INFINITY,
    stereoBalanceDb,
  };
}

function stereoPeak(buffer) {
  let peak = 0;
  for (let index = 0; index < buffer.left.length; index += 1) {
    peak = Math.max(
      peak,
      Math.abs(buffer.left[index]),
      Math.abs(buffer.right[index]),
    );
  }
  return peak;
}

function sha256(payload) {
  return createHash("sha256").update(payload).digest("hex");
}

function resolveOwnedPath(relativePath, ownedRoot, label) {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw new Error(`${label} path must be a non-empty string`);
  }
  if (path.isAbsolute(relativePath)) {
    throw new Error(`${label} path must be relative: ${relativePath}`);
  }
  const resolved = path.resolve(root, relativePath);
  const relativeToOwnedRoot = path.relative(path.resolve(ownedRoot), resolved);
  if (
    relativeToOwnedRoot === "" ||
    relativeToOwnedRoot.startsWith(`..${path.sep}`) ||
    relativeToOwnedRoot === ".." ||
    path.isAbsolute(relativeToOwnedRoot)
  ) {
    throw new Error(`${label} path escapes assets/sounds: ${relativePath}`);
  }
  return resolved;
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
