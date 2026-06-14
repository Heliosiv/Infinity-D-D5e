import { SETTING_KEYS, getSetting } from "./settings.js";

const MODULE_ID = "infinity-dnd5e";
const SOCKET_NAME = `module.${MODULE_ID}`;
const SOUND_DIR = "assets/sounds";
const MODULE_SOUND_DIR = `modules/${MODULE_ID}/${SOUND_DIR}`;
const DEFAULT_COOLDOWN_MS = 120;
const SOUND_SOCKET_TYPE = "sound-event";
const SOUND_AUDIENCE_ALL = "all";
const SOUND_AUDIENCE_LOCAL = "local";
const SEEN_SOUND_EVENT_LIMIT = 250;

export const SOUND_EVENTS = Object.freeze({
  LOADING_SHIMMER: "loading-shimmer",
  ROLL_START: "roll-start",
  RESULT_CASCADE: "result-cascade",
  HOARD_CASCADE: "hoard-cascade",
  RARE_CHIME: "rare-chime",
  LEGENDARY_CHIME: "legendary-chime",
  UI_OPEN: "ui-open",
  ITEM_OPEN: "item-open",
  PRESET_APPLY: "preset-apply",
  ROSTER_ADD: "roster-add",
  ROSTER_REMOVE: "roster-remove",
  LOCK_TOGGLE: "lock-toggle",
  CHAT_SEND: "chat-send",
  DEPOSIT: "deposit",
  CLEAR_RESET: "clear-reset",
  WARNING_MUTED: "warning-muted",
  MERCHANT_SESSION_OPEN: "merchant-session-open",
  MERCHANT_PURCHASE: "merchant-purchase",
  MERCHANT_SALE: "merchant-sale",
  MERCHANT_BARGAIN_WIN: "merchant-bargain-win",
  MERCHANT_BARGAIN_FAIL: "merchant-bargain-fail",
});

export const SOUND_REGISTRY = Object.freeze({
  [SOUND_EVENTS.LOADING_SHIMMER]: sound("loading-shimmer.wav", 0.35, 1400),
  [SOUND_EVENTS.ROLL_START]: sound("roll-start.wav", 0.55, 300),
  [SOUND_EVENTS.RESULT_CASCADE]: sound("result-cascade.wav", 0.42, 450),
  [SOUND_EVENTS.HOARD_CASCADE]: sound("hoard-cascade.wav", 0.48, 600),
  [SOUND_EVENTS.RARE_CHIME]: sound("rare-chime.wav", 0.38, 700),
  [SOUND_EVENTS.LEGENDARY_CHIME]: sound("legendary-chime.wav", 0.42, 900),
  [SOUND_EVENTS.UI_OPEN]: sound("ui-open.wav", 0.35, 220),
  [SOUND_EVENTS.ITEM_OPEN]: sound("item-open.wav", 0.32, 220),
  [SOUND_EVENTS.PRESET_APPLY]: sound("preset-apply.wav", 0.3, 160),
  [SOUND_EVENTS.ROSTER_ADD]: sound("roster-add.wav", 0.34, 120),
  [SOUND_EVENTS.ROSTER_REMOVE]: sound("roster-remove.wav", 0.3, 120),
  [SOUND_EVENTS.LOCK_TOGGLE]: sound("lock-toggle.wav", 0.42, 120),
  [SOUND_EVENTS.CHAT_SEND]: sound("chat-send.wav", 0.4, 250),
  [SOUND_EVENTS.DEPOSIT]: sound("deposit.wav", 0.5, 350),
  [SOUND_EVENTS.CLEAR_RESET]: sound("clear-reset.wav", 0.34, 200),
  [SOUND_EVENTS.WARNING_MUTED]: sound("warning-muted.wav", 0.36, 350),
  [SOUND_EVENTS.MERCHANT_SESSION_OPEN]: sound(
    "merchant-session-open.wav",
    0.4,
    250,
  ),
  [SOUND_EVENTS.MERCHANT_PURCHASE]: sound("merchant-purchase.wav", 0.45, 300),
  [SOUND_EVENTS.MERCHANT_SALE]: sound("merchant-sale.wav", 0.45, 300),
  [SOUND_EVENTS.MERCHANT_BARGAIN_WIN]: sound(
    "merchant-bargain-win.wav",
    0.45,
    400,
  ),
  [SOUND_EVENTS.MERCHANT_BARGAIN_FAIL]: sound(
    "merchant-bargain-fail.wav",
    0.45,
    400,
  ),
});

const lastPlayedAt = new Map();
const seenSocketSoundEvents = new Set();
let soundSocketRegistered = false;

export function registerSoundSocket() {
  const socket = globalThis.game?.socket;
  if (!socket || soundSocketRegistered) return false;
  if (typeof socket.on !== "function") return false;

  socket.on(SOCKET_NAME, receiveSoundEventPayload);
  soundSocketRegistered = true;
  return true;
}

export function playModuleSound(eventKey, options = {}) {
  const entry = SOUND_REGISTRY[eventKey];
  if (!entry || getSetting(SETTING_KEYS.SOUNDS_ENABLED) === false) return null;
  if (
    options.automation === true &&
    getSetting(SETTING_KEYS.AUTOMATION_SOUNDS_ENABLED) === false
  ) {
    return null;
  }

  const now = Date.now();
  const cooldownMs = Math.max(
    0,
    Number(options.cooldownMs ?? entry.cooldownMs ?? DEFAULT_COOLDOWN_MS),
  );
  const cooldownKey = soundCooldownKey(eventKey, options);
  const previous = lastPlayedAt.get(cooldownKey) ?? 0;
  if (cooldownMs > 0 && now - previous < cooldownMs) return null;
  lastPlayedAt.set(cooldownKey, now);
  pruneCooldownMap(now);

  const delayMs = Math.max(0, Number(options.delayMs ?? 0));
  const play = () => playFoundrySound(entry, options);
  if (delayMs > 0) {
    globalThis.setTimeout(play, delayMs);
    return null;
  }
  return play();
}

export function playSoundEvent(eventKey, options = {}) {
  const entry = SOUND_REGISTRY[eventKey];
  if (!entry) return null;

  // Automation cues (combat / activity / MIDI / animation) are opt-in. When
  // disabled, don't play locally AND don't broadcast — so a table running its
  // own combat audio and animation soundtracks gets zero interference and zero
  // socket noise, rather than just muting the local copy after the fact.
  if (
    options.automation === true &&
    getSetting(SETTING_KEYS.AUTOMATION_SOUNDS_ENABLED) === false
  ) {
    return null;
  }

  const audience = options.audience ?? SOUND_AUDIENCE_LOCAL;
  const playbackOptions = {
    ...options,
    audience: undefined,
  };

  if (audience !== SOUND_AUDIENCE_ALL) {
    return playModuleSound(eventKey, playbackOptions);
  }

  const eventId = options.eventId ?? createSoundEventId(eventKey);
  rememberSocketSoundEvent(eventId);
  const localResult = playModuleSound(eventKey, playbackOptions);
  const socket = globalThis.game?.socket;
  if (typeof socket?.emit === "function") {
    socket.emit(SOCKET_NAME, {
      type: SOUND_SOCKET_TYPE,
      id: eventId,
      eventKey,
      originUserId: globalThis.game?.user?.id ?? null,
      options: sanitizeSocketSoundOptions(playbackOptions),
    });
  }
  return localResult;
}

export function receiveSoundEventPayload(payload) {
  if (!isValidSoundSocketPayload(payload)) return null;
  if (seenSocketSoundEvents.has(payload.id)) return null;
  if (
    payload.originUserId &&
    payload.originUserId === globalThis.game?.user?.id
  ) {
    rememberSocketSoundEvent(payload.id);
    return null;
  }

  rememberSocketSoundEvent(payload.id);
  return playModuleSound(payload.eventKey, {
    ...payload.options,
    automation: true,
  });
}

export function playResultSound(result, options = {}) {
  const items = resultItems(result);
  const hasCoins = Number(result?.coinPileGp ?? 0) > 0;
  if (items.length === 0 && !hasCoins) {
    return playModuleSound(SOUND_EVENTS.WARNING_MUTED, options);
  }

  const cascadeKey =
    options.kind === "hoard"
      ? SOUND_EVENTS.HOARD_CASCADE
      : SOUND_EVENTS.RESULT_CASCADE;
  const sound = playModuleSound(cascadeKey, options);
  const rarity = highestRarity(items);
  if (rarity >= RARITY_RANK.legendary) {
    playModuleSound(SOUND_EVENTS.LEGENDARY_CHIME, {
      ...options,
      delayMs: options.chimeDelayMs ?? 260,
    });
  } else if (rarity >= RARITY_RANK.rare) {
    playModuleSound(SOUND_EVENTS.RARE_CHIME, {
      ...options,
      delayMs: options.chimeDelayMs ?? 220,
    });
  }
  return sound;
}

/**
 * Foundry's AudioHelper — namespaced under `foundry.audio.AudioHelper` in v13+.
 * Resolve that first, falling back to the legacy global only if needed, so we
 * don't trip the (noisy, v14-removed) "accessing the global AudioHelper"
 * deprecation warning on every single play.
 */
function audioHelper() {
  return (
    globalThis.foundry?.audio?.AudioHelper ?? globalThis.AudioHelper ?? null
  );
}

export async function preloadModuleSounds() {
  const sources = Object.values(SOUND_REGISTRY).map((entry) => entry.src);
  const helper = audioHelper();
  for (const src of sources) {
    try {
      if (typeof helper?.preloadSound === "function") {
        await helper.preloadSound(src);
      } else if (typeof globalThis.game?.audio?.preload === "function") {
        await globalThis.game.audio.preload(src);
      }
    } catch {
      // Browsers may keep audio locked until the first user gesture.
    }
  }
}

function playFoundrySound(entry, options) {
  const masterVolume = clamp01(getSetting(SETTING_KEYS.SOUND_VOLUME) ?? 0.35);
  const eventVolume = clamp01(options.volume ?? entry.volume);
  const volume = clamp01(masterVolume * eventVolume);
  if (volume <= 0) return null;

  const data = {
    src: entry.src,
    volume,
    loop: false,
    autoplay: true,
    channel: globalThis.CONST?.AUDIO_CHANNELS?.INTERFACE,
  };

  try {
    const helper = audioHelper();
    if (typeof helper?.play === "function") {
      return helper.play(data, false);
    }
    if (typeof globalThis.game?.audio?.play === "function") {
      return globalThis.game.audio.play(entry.src, {
        volume,
        loop: false,
        context: globalThis.game.audio.interface,
      });
    }
  } catch (error) {
    console.debug(`${MODULE_ID} | sound playback failed`, {
      sound: entry.id,
      error,
    });
  }
  return null;
}

function soundCooldownKey(eventKey, options) {
  const contextKey = cleanSocketString(options.contextKey);
  const phase = cleanSocketString(options.phase);
  if (!contextKey && !phase) return eventKey;
  return [eventKey, contextKey, phase].filter(Boolean).join(":");
}

/**
 * Bound the cooldown map. Automation sounds key on contextKey (actor/item/
 * message — see compat/sound-automation.js), so without eviction `lastPlayedAt`
 * would grow for the life of a session. Every cooldown is sub-second, so any
 * entry older than the threshold can never block a future play and is safe to
 * drop. Mirrors the prune in rememberAutomationSound.
 */
function pruneCooldownMap(now) {
  if (lastPlayedAt.size <= 300) return;
  for (const [key, timestamp] of lastPlayedAt) {
    if (now - timestamp > 30_000) lastPlayedAt.delete(key);
    if (lastPlayedAt.size <= 240) break;
  }
}

function sanitizeSocketSoundOptions(options) {
  const sanitized = {
    automation: options.automation === true,
  };
  const contextKey = cleanSocketString(options.contextKey);
  const phase = cleanSocketString(options.phase);
  if (contextKey) sanitized.contextKey = contextKey;
  if (phase) sanitized.phase = phase;

  for (const numericKey of ["cooldownMs", "delayMs", "chimeDelayMs"]) {
    const value = Number(options[numericKey]);
    if (Number.isFinite(value) && value >= 0) sanitized[numericKey] = value;
  }
  return sanitized;
}

function isValidSoundSocketPayload(payload) {
  return (
    payload?.type === SOUND_SOCKET_TYPE &&
    typeof payload.id === "string" &&
    payload.id.length > 0 &&
    Boolean(SOUND_REGISTRY[payload.eventKey]) &&
    (!payload.options ||
      (typeof payload.options === "object" && !Array.isArray(payload.options)))
  );
}

function cleanSocketString(value) {
  const stringValue = String(value ?? "").trim();
  return stringValue.length > 0 ? stringValue.slice(0, 240) : "";
}

function createSoundEventId(eventKey) {
  const userId = cleanSocketString(globalThis.game?.user?.id) || "local";
  return `${MODULE_ID}.${userId}.${eventKey}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function rememberSocketSoundEvent(eventId) {
  if (!eventId) return;
  if (seenSocketSoundEvents.size >= SEEN_SOUND_EVENT_LIMIT) {
    const oldest = seenSocketSoundEvents.values().next().value;
    if (oldest) seenSocketSoundEvents.delete(oldest);
  }
  seenSocketSoundEvents.add(eventId);
}

function resultItems(result) {
  if (Array.isArray(result?.items)) return result.items;
  if (Array.isArray(result?.creatures)) {
    return result.creatures.flatMap((creature) => creature.items ?? []);
  }
  return [];
}

const RARITY_RANK = Object.freeze({
  common: 1,
  uncommon: 2,
  rare: 3,
  "very-rare": 4,
  veryRare: 4,
  legendary: 5,
  artifact: 6,
});

function highestRarity(items) {
  return items.reduce((max, entry) => {
    const rarity = entry?.rarity ?? entry?.item?.system?.rarity ?? "common";
    return Math.max(max, RARITY_RANK[rarity] ?? 0);
  }, 0);
}

function sound(fileName, volume, cooldownMs) {
  const id = fileName.replace(/\.wav$/i, "");
  return Object.freeze({
    id,
    file: `${SOUND_DIR}/${fileName}`,
    src: `${MODULE_SOUND_DIR}/${fileName}`,
    volume,
    cooldownMs,
  });
}

function clamp01(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(1, numeric));
}
