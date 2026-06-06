/**
 * Infinity D&D5e — Settings catalog
 *
 * Every default I baked into the loot tools lives here so the GM can
 * override it in Foundry's *Configure Settings → Module Settings* panel.
 * The catalog is a plain data array; module.js registers each entry
 * with `game.settings.register()` on init, and any tool that wants a
 * tuned value reads it through `getSetting(key)` — which gracefully
 * falls back to the catalog default when game isn't initialized (e.g.
 * in node-only unit tests).
 */

const MODULE_ID = "infinity-dnd5e";

/* ------------------------------------------------------------------ *
 * Keys
 * ------------------------------------------------------------------ */

export const SETTING_KEYS = Object.freeze({
  DEFAULT_TIER: "defaultTier",
  DEFAULT_PARTY_SIZE: "defaultPartySize",
  DEFAULT_COUNT: "defaultCount",
  DEFAULT_RARITIES: "defaultRarities",
  DEFAULT_MAGIC_BIAS: "defaultMagicBias",
  DEFAULT_SCALE: "defaultScaleMultiplier",
  DEFAULT_GENEROSITY: "defaultGenerosityMultiplier",
  ANIMATIONS: "animations",
  RARITY_GLOW: "rarityGlow",
  LOADING_SKELETON: "loadingSkeleton",
  SOUNDS_ENABLED: "soundsEnabled",
  AUTOMATION_SOUNDS_ENABLED: "automationSoundsEnabled",
  SOUND_VOLUME: "soundVolume",
  KEYBOARD_SHORTCUTS: "keyboardShortcuts",
  PERSIST_STATE: "persistState",
  PACK_TTL_MINUTES: "packTtlMinutes",
  CHAT_MODE: "chatMode",
  MERCHANTS: "merchants",
  MERCHANT_DEFAULT_MARKUP: "merchantDefaultMarkup",
  MERCHANT_DEFAULT_SELL_RATIO: "merchantDefaultSellRatio",
  MERCHANT_DEFAULT_BARGAIN_DC: "merchantDefaultBargainDC",
  MERCHANT_BARGAIN_TIERS: "merchantBargainTiers",
  MERCHANT_CHAT_MODE: "merchantChatMode",
  MERCHANT_CONFIRM_TRANSACTIONS: "merchantConfirmTransactions",
  // Hidden stores (no config UI) — keyed-by-tool blobs of saved presets
  // and recent roll history. Managed by scripts/loot/loot-store.js.
  SAVED_PRESETS: "savedPresets",
  ROLL_HISTORY: "rollHistory",
});

/* ------------------------------------------------------------------ *
 * Catalog
 *
 * Each entry shape matches Foundry's `game.settings.register()` opts.
 * `config: true` surfaces the entry in the standard Module Settings
 * panel; entries that need a richer UI (e.g. multi-select) are kept
 * as plain strings + documented format for v0.2.
 * ------------------------------------------------------------------ */

export const SETTINGS = Object.freeze([
  {
    key: SETTING_KEYS.DEFAULT_TIER,
    name: "Default Tier",
    hint: "Tier preselected when the Per-Encounter window opens.",
    scope: "world",
    config: true,
    type: String,
    default: "t2",
    choices: {
      t1: "T1 — Lvl 1–4",
      t2: "T2 — Lvl 5–10",
      t3: "T3 — Lvl 11–16",
      t4: "T4 — Lvl 17–20",
      t5: "T5 — Epic",
    },
  },
  {
    key: SETTING_KEYS.DEFAULT_PARTY_SIZE,
    name: "Default Party Size",
    hint: "1–10. Overridden any time you click Use Party.",
    scope: "world",
    config: true,
    type: Number,
    default: 4,
    range: { min: 1, max: 10, step: 1 },
  },
  {
    key: SETTING_KEYS.DEFAULT_COUNT,
    name: "Default Item Limit",
    hint: "0 = automatic budget fill. 1-20 caps the number of items in a fresh bundle.",
    scope: "world",
    config: true,
    type: Number,
    default: 0,
    range: { min: 0, max: 20, step: 1 },
  },
  {
    key: SETTING_KEYS.DEFAULT_RARITIES,
    name: "Default Rarities",
    hint:
      "Comma-separated list of rarities checked on open. " +
      "Options: common, uncommon, rare, very-rare, legendary, artifact.",
    scope: "world",
    config: true,
    type: String,
    default: "uncommon,rare",
  },
  {
    key: SETTING_KEYS.DEFAULT_MAGIC_BIAS,
    name: "Default Magic vs. Mundane",
    hint:
      "−1.0 (all mundane) … 0 (neutral) … +1.0 (all magic). " +
      "Applied as a per-item weight multiplier in the roller.",
    scope: "world",
    config: true,
    type: Number,
    default: 0,
    range: { min: -1, max: 1, step: 0.05 },
  },
  {
    key: SETTING_KEYS.DEFAULT_SCALE,
    name: "Default Encounter Scale",
    hint: "Slider preset. 1.0 = standard encounter; 6.0 = hoard.",
    scope: "world",
    config: true,
    type: Number,
    default: 1.0,
    range: { min: 0.4, max: 6.0, step: 0.05 },
  },
  {
    key: SETTING_KEYS.DEFAULT_GENEROSITY,
    name: "Default Generosity",
    hint: "Slider preset. 0.6 = stingy, 1.0 = balanced, 1.6 = generous.",
    scope: "world",
    config: true,
    type: Number,
    default: 1.0,
    range: { min: 0.4, max: 2.0, step: 0.05 },
  },
  {
    key: SETTING_KEYS.ANIMATIONS,
    name: "Result Animations",
    hint: "Cascade-in animation when a new bundle is rolled.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
  },
  {
    key: SETTING_KEYS.RARITY_GLOW,
    name: "Rarity Glow",
    hint: "Subtle tinted shadow on rare / legendary / artifact result cards.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
  },
  {
    key: SETTING_KEYS.LOADING_SKELETON,
    name: "Loading Skeleton",
    hint: "Shimmering placeholder while the compendium index loads.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
  },
  {
    key: SETTING_KEYS.SOUNDS_ENABLED,
    name: "Module Sounds",
    hint: "Play subtle Infinity D&D5e sound effects for tools, activities, MIDI workflows, and animation-triggered actions.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
  },
  {
    key: SETTING_KEYS.AUTOMATION_SOUNDS_ENABLED,
    name: "Automation Sounds",
    hint: "Play Infinity D&D5e sounds triggered by D&D5e activities, MIDI-QOL workflows, and animation-adjacent actions.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
  },
  {
    key: SETTING_KEYS.SOUND_VOLUME,
    name: "Module Sound Volume",
    hint: "Client-side volume for Infinity D&D5e sound effects. 0 = muted, 1 = full.",
    scope: "client",
    config: true,
    type: Number,
    default: 0.35,
    range: { min: 0, max: 1, step: 0.05 },
  },
  {
    key: SETTING_KEYS.KEYBOARD_SHORTCUTS,
    name: "Keyboard Shortcuts",
    hint: "Enable Enter / R to trigger Generate inside the window.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
  },
  {
    key: SETTING_KEYS.PERSIST_STATE,
    name: "Persist Last Result",
    hint:
      "Remember the form values and last bundle across window closes " +
      "(until the page is reloaded).",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
  },
  {
    key: SETTING_KEYS.PACK_TTL_MINUTES,
    name: "Pack Cache TTL (minutes)",
    hint:
      "How long the compendium index stays cached before being re-read. " +
      "Lower means fresher results if you edit items mid-session; higher " +
      "is faster.",
    scope: "world",
    config: true,
    type: Number,
    default: 5,
    range: { min: 1, max: 60, step: 1 },
  },
  {
    key: SETTING_KEYS.CHAT_MODE,
    name: "Send-to-Chat Mode",
    hint:
      "Who sees the chat card when you click Send to Chat. " +
      "Whisper modes don't leak the loot to players who shouldn't see it.",
    scope: "world",
    config: true,
    type: String,
    default: "public",
    choices: {
      public: "Public — visible to everyone",
      "whisper-gm": "Whisper to GMs only",
      "whisper-players": "Whisper to active players (no GMs)",
    },
  },
  {
    key: SETTING_KEYS.MERCHANTS,
    name: "Merchant Records",
    hint:
      "Persistent merchant data. Managed by the Merchant Workspace; " +
      "edit through that window rather than this field.",
    scope: "world",
    config: false,
    type: Array,
    default: [],
  },
  {
    key: SETTING_KEYS.MERCHANT_DEFAULT_MARKUP,
    name: "Default Merchant Markup",
    hint:
      "Multiplier applied to item base price when a merchant doesn't set " +
      "a custom markup. 1.0 = at cost, 1.2 = +20%, 2.0 = double.",
    scope: "world",
    config: true,
    type: Number,
    default: 1.0,
    range: { min: 0.1, max: 5.0, step: 0.05 },
  },
  {
    key: SETTING_KEYS.MERCHANT_DEFAULT_SELL_RATIO,
    name: "Default Sell-Back Ratio",
    hint:
      "Multiplier applied to item base price when a player sells to a " +
      "merchant. 0.5 = half-price (standard 5e), 1.0 = full value.",
    scope: "world",
    config: true,
    type: Number,
    default: 0.5,
    range: { min: 0, max: 1.5, step: 0.05 },
  },
  {
    key: SETTING_KEYS.MERCHANT_DEFAULT_BARGAIN_DC,
    name: "Default Bargain DC",
    hint:
      "Skill-check DC used when a merchant doesn't set its own. " +
      "10 = trivial, 15 = medium, 20 = hard.",
    scope: "world",
    config: true,
    type: Number,
    default: 15,
    range: { min: 5, max: 30, step: 1 },
  },
  {
    key: SETTING_KEYS.MERCHANT_BARGAIN_TIERS,
    name: "Bargain Tier Schedule",
    hint:
      "Roll-margin tiers that decide bargain price deltas. Managed in code " +
      "(see merchant/bargain.js) — editable via macro for fine-tuning.",
    scope: "world",
    config: false,
    type: Array,
    default: [
      { id: "crit-success", minMargin: 10, deltaPct: -20 },
      { id: "success", minMargin: 0, deltaPct: -10 },
      { id: "failure", minMargin: -9, deltaPct: 10 },
      { id: "crit-failure", minMargin: -999, deltaPct: 20 },
    ],
  },
  {
    key: SETTING_KEYS.MERCHANT_CHAT_MODE,
    name: "Merchant Receipt Mode",
    hint:
      "Who sees the chat receipt after a buy/sell/bargain. Whisper keeps " +
      "deals between the GM and the involved player.",
    scope: "world",
    config: true,
    type: String,
    default: "whisper-gm-buyer",
    choices: {
      "whisper-gm-buyer": "Whisper to GM and buyer (recommended)",
      public: "Public — visible to everyone",
      "whisper-gm": "Whisper to GMs only",
    },
  },
  {
    key: SETTING_KEYS.MERCHANT_CONFIRM_TRANSACTIONS,
    name: "Confirm Merchant Purchases",
    hint:
      "Ask the player to confirm before a buy or sell goes through in a " +
      "merchant session. Off by default for quick shopping.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  },
  {
    key: SETTING_KEYS.SAVED_PRESETS,
    name: "Saved Loot Presets",
    hint: "Internal store for named tool presets. Not shown in the UI.",
    scope: "world",
    config: false,
    type: Object,
    default: {},
  },
  {
    key: SETTING_KEYS.ROLL_HISTORY,
    name: "Loot Roll History",
    hint: "Internal store for recent rolls. Not shown in the UI.",
    scope: "world",
    config: false,
    type: Object,
    default: {},
  },
]);

/* ------------------------------------------------------------------ *
 * Lookup helpers
 * ------------------------------------------------------------------ */

const SETTINGS_BY_KEY = Object.freeze(
  Object.fromEntries(SETTINGS.map((entry) => [entry.key, entry])),
);

/**
 * Read a setting value. Falls back to the registered default when
 * `game.settings` isn't available (e.g. node tests) or the key is
 * unrecognized. Always returns SOMETHING — never throws.
 */
export function getSetting(key) {
  const entry = SETTINGS_BY_KEY[key];
  const fallback = entry?.default;
  try {
    const live = globalThis.game?.settings?.get?.(MODULE_ID, key);
    return live === undefined ? fallback : live;
  } catch {
    return fallback;
  }
}

/**
 * Write a setting value. No-op (resolves false) when `game.settings`
 * isn't available — so callers in node tests don't throw. Returns true
 * when the write was attempted against a live game.
 */
export async function setSetting(key, value) {
  try {
    if (!globalThis.game?.settings?.set) return false;
    await globalThis.game.settings.set(MODULE_ID, key, value);
    return true;
  } catch (error) {
    console.warn(`${MODULE_ID} | failed to write setting "${key}"`, error);
    return false;
  }
}

/**
 * Parse the comma-separated rarities string into an array of valid
 * rarity ids. Used by the form-default loader; tolerant of extra
 * whitespace, casing, and unknown values (silently dropped).
 */
export function parseRaritiesSetting(raw, validRarities) {
  const valid = new Set(validRarities ?? []);
  const seen = new Set();
  const out = [];
  for (const piece of String(raw ?? "").split(",")) {
    const trimmed = piece.trim().toLowerCase();
    if (!trimmed) continue;
    if (valid.size > 0 && !valid.has(trimmed)) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** Module id, re-exported for callers that need to call into game.settings directly. */
export const SETTINGS_MODULE_ID = MODULE_ID;
