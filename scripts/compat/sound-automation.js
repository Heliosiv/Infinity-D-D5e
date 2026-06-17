import {
  SOUND_EVENTS,
  SOUND_REGISTRY,
  RARITY_RANK,
  playSoundEvent,
} from "../audio.js";

const MODULE_ID = "infinity-dnd5e";
const HOOK_MARKER = "__infinityDnd5eSoundAutomationHooksV1";
const DEFAULT_DEDUPE_MS = 650;
const RARITY_CHIME_DELAY_MS = 260;
const ANIMATION_SOUND_DELAY_MS = 140;

const ITEM_TYPES = new Set([
  "backpack",
  "class",
  "consumable",
  "equipment",
  "feat",
  "loot",
  "race",
  "spell",
  "subclass",
  "tool",
  "weapon",
]);

const ACTIVITY_TYPES = new Set([
  "attack",
  "check",
  "damage",
  "enchant",
  "heal",
  "save",
  "summon",
  "utility",
]);

const ANIMATION_MODULE_IDS = [
  "sequencer",
  "autoanimations",
  "automated-jb2a-animations",
  "automated-animations",
];

const DEFAULT_EVENT_BY_PHASE = Object.freeze({
  use: SOUND_EVENTS.ROLL_START,
  attack: SOUND_EVENTS.ROLL_START,
  damage: SOUND_EVENTS.RESULT_CASCADE,
  effect: SOUND_EVENTS.RESULT_CASCADE,
  animation: SOUND_EVENTS.LOADING_SHIMMER,
  midi: SOUND_EVENTS.ROLL_START,
  empty: SOUND_EVENTS.WARNING_MUTED,
});

const recentAutomationSoundKeys = new Map();

export function registerSoundAutomation({
  hooks = globalThis.Hooks,
  gameRef = globalThis.game,
} = {}) {
  if (!hooks || typeof hooks.on !== "function") return false;
  if (hooks[HOOK_MARKER]) return false;

  hooks.on("dnd5e.preUseActivity", (...args) => {
    const context = normalizeAutomationContext(args, { source: "dnd5e" });
    playAutomationSound("use", context);
    playRarityOverlay(context);
    playAnimationBridgeSound(context, gameRef);
  });
  hooks.on("dnd5e.rollAttack", (...args) =>
    playAutomationSound(
      "attack",
      normalizeAutomationContext(args, { source: "dnd5e" }),
    ),
  );
  hooks.on("dnd5e.rollDamage", (...args) =>
    playAutomationSound(
      "damage",
      normalizeAutomationContext(args, { source: "dnd5e" }),
    ),
  );
  hooks.on("dnd5e.renderChatMessage", (...args) => playDnd5eChatFallback(args));

  if (isModuleActive(gameRef, "midi-qol")) registerMidiSoundHooks(hooks);

  Object.defineProperty(hooks, HOOK_MARKER, {
    value: true,
    configurable: true,
  });
  return true;
}

export function playAutomationSound(phase, context, options = {}) {
  if (!context || isSoundProfileDisabled(context.soundProfile)) return null;

  const eventKey = resolveSoundEvent(phase, context.soundProfile);
  if (!eventKey) return null;

  const contextKey = context.contextKey ?? buildFallbackContextKey(phase);
  const dedupeKey = context.dedupeKey ?? contextKey;
  if (!rememberAutomationSound(dedupeKey, eventKey)) return null;

  return playSoundEvent(eventKey, {
    audience: "all",
    automation: true,
    contextKey,
    phase,
    delayMs: options.delayMs,
  });
}

export function normalizeAutomationContext(args, { source = "unknown" } = {}) {
  const candidates = collectCandidates(args);
  const workflow = candidates.find(isWorkflowLike) ?? null;
  const message = candidates.find(isChatMessageLike) ?? null;
  const activity =
    candidates.find(isActivityLike) ??
    workflow?.activity ??
    workflow?.activityData ??
    null;
  const item =
    itemFromActivity(activity) ??
    workflow?.item ??
    message?.item ??
    candidates.find(isItemLike) ??
    null;
  const actor =
    workflow?.actor ??
    activity?.actor ??
    item?.actor ??
    candidates.find(isTokenLike)?.actor ??
    null;

  const soundProfile = resolveSoundProfile(activity, item);
  const contextKey = buildContextKey({ actor, activity, item, message });
  const dedupeKey = buildDedupeKey({ activity, item, message });

  return {
    actor,
    activity,
    activityType: normalizeId(activity?.type ?? activity?.system?.type),
    contextKey,
    dedupeKey,
    item,
    itemType: normalizeId(item?.type),
    message,
    rarity: normalizeId(
      item?.system?.rarity ??
        item?.rarity ??
        item?.flags?.["infinity-dnd5e"]?.rarityNormalized ??
        item?.flags?.["party-operations"]?.rarityNormalized,
    ),
    soundProfile,
    source,
    workflow,
  };
}

export function resetSoundAutomationForTests(hooks) {
  recentAutomationSoundKeys.clear();
  if (hooks?.[HOOK_MARKER]) delete hooks[HOOK_MARKER];
}

function registerMidiSoundHooks(hooks) {
  hooks.on("midi-qol.preambleComplete", (workflow) => {
    const context = normalizeAutomationContext([workflow], { source: "midi" });
    playAutomationSound("midi", context);
    playRarityOverlay(context);
  });
  hooks.on("midi-qol.AttackRollComplete", (workflow) =>
    playAutomationSound(
      "attack",
      normalizeAutomationContext([workflow], { source: "midi" }),
    ),
  );
  hooks.on("midi-qol.damageRollComplete", (workflow) =>
    playAutomationSound(
      "damage",
      normalizeAutomationContext([workflow], { source: "midi" }),
    ),
  );
  hooks.on("midi-qol.preApplyDynamicEffects", (workflow) =>
    playAutomationSound(
      "effect",
      normalizeAutomationContext([workflow], { source: "midi" }),
    ),
  );
  hooks.on("midi-qol.RollComplete", (workflow) => {
    if (workflowHasResult(workflow)) return;
    playAutomationSound(
      "empty",
      normalizeAutomationContext([workflow], { source: "midi" }),
    );
  });
}

function playDnd5eChatFallback(args) {
  const context = normalizeAutomationContext(args, { source: "dnd5e-chat" });
  if (!context.item && !context.activity) return null;
  if (chatMessageHasRollResult(context.message)) return null;
  return playAutomationSound("empty", context);
}

function playAnimationBridgeSound(context, gameRef) {
  if (!isAnimationBridgeActive(gameRef)) return null;
  if (!isAnimationCandidate(context)) return null;
  return playAutomationSound("animation", context, {
    delayMs: ANIMATION_SOUND_DELAY_MS,
  });
}

function playRarityOverlay(context) {
  if (!context || isSoundProfileDisabled(context.soundProfile)) return null;
  const rank = RARITY_RANK[context.rarity] ?? 0;
  const eventKey =
    rank >= RARITY_RANK.legendary
      ? SOUND_EVENTS.LEGENDARY_CHIME
      : rank >= RARITY_RANK.rare
        ? SOUND_EVENTS.RARE_CHIME
        : null;
  if (!eventKey) return null;

  const contextKey = context.contextKey ?? buildFallbackContextKey("rarity");
  const dedupeKey = context.dedupeKey ?? contextKey;
  if (!rememberAutomationSound(dedupeKey, eventKey, 1000)) return null;
  return playSoundEvent(eventKey, {
    audience: "all",
    automation: true,
    contextKey,
    phase: "rarity",
    delayMs: RARITY_CHIME_DELAY_MS,
  });
}

function resolveSoundEvent(phase, soundProfile) {
  const override = soundProfile?.events?.[phase];
  return resolveEventKey(override) ?? DEFAULT_EVENT_BY_PHASE[phase] ?? null;
}

function resolveEventKey(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (SOUND_REGISTRY[raw]) return raw;
  if (SOUND_EVENTS[raw]) return SOUND_EVENTS[raw];

  const normalized = raw.toUpperCase().replaceAll("-", "_");
  return SOUND_EVENTS[normalized] ?? null;
}

function resolveSoundProfile(activity, item) {
  const itemProfile = normalizeSoundProfile(readSoundProfile(item));
  const activityProfile = normalizeSoundProfile(readSoundProfile(activity));
  const enabled = activityProfile?.enabled ?? itemProfile?.enabled ?? undefined;
  return {
    enabled,
    events: {
      ...(itemProfile?.events ?? {}),
      ...(activityProfile?.events ?? {}),
    },
  };
}

function readSoundProfile(document) {
  try {
    const flag = document?.getFlag?.(MODULE_ID, "soundProfile");
    if (flag !== undefined) return flag;
  } catch {
    // Fall through to raw flag data.
  }
  return document?.flags?.[MODULE_ID]?.soundProfile;
}

function normalizeSoundProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    return null;
  }
  const events =
    profile.events && typeof profile.events === "object" ? profile.events : {};
  return {
    enabled: typeof profile.enabled === "boolean" ? profile.enabled : undefined,
    events,
  };
}

function isSoundProfileDisabled(profile) {
  return profile?.enabled === false;
}

function rememberAutomationSound(contextKey, eventKey, dedupeMs) {
  const key = `${contextKey}:${eventKey}`;
  const now = Date.now();
  const previous = recentAutomationSoundKeys.get(key) ?? 0;
  if (now - previous < (dedupeMs ?? DEFAULT_DEDUPE_MS)) return false;

  recentAutomationSoundKeys.set(key, now);
  if (recentAutomationSoundKeys.size > 300) {
    for (const [storedKey, timestamp] of recentAutomationSoundKeys) {
      if (now - timestamp > 30_000) recentAutomationSoundKeys.delete(storedKey);
      if (recentAutomationSoundKeys.size <= 240) break;
    }
  }
  return true;
}

function collectCandidates(args) {
  const queue = Array.isArray(args) ? [...args] : [args];
  const out = [];
  const seen = new WeakSet();

  while (queue.length > 0 && out.length < 80) {
    const value = queue.shift();
    if (!value || typeof value !== "object") continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);

    for (const key of [
      "activity",
      "activityData",
      "actor",
      "document",
      "item",
      "message",
      "parent",
      "token",
      "workflow",
    ]) {
      if (value[key] && typeof value[key] === "object") queue.push(value[key]);
    }
  }
  return out;
}

function itemFromActivity(activity) {
  return (
    activity?.item ?? (isItemLike(activity?.parent) ? activity.parent : null)
  );
}

function isItemLike(candidate) {
  if (!candidate || typeof candidate !== "object") return false;
  if (candidate.documentName === "Item") return true;
  return (
    ITEM_TYPES.has(candidate.type) &&
    (candidate.system || candidate.flags || candidate.uuid || candidate.id)
  );
}

function isActivityLike(candidate) {
  if (!candidate || typeof candidate !== "object") return false;
  if (isWorkflowLike(candidate) || isItemLike(candidate)) return false;
  if (isItemLike(candidate.parent)) return true;
  if (candidate.item && ACTIVITY_TYPES.has(candidate.type)) return true;
  if (
    candidate.item &&
    (candidate.activation || candidate.range || candidate.target)
  ) {
    return true;
  }
  if (ACTIVITY_TYPES.has(candidate.type)) {
    return Boolean(candidate.activation || candidate.range || candidate.target);
  }
  return false;
}

function isWorkflowLike(candidate) {
  return Boolean(
    candidate?.item &&
    (candidate.activity ||
      candidate.actor ||
      candidate.attackRoll ||
      candidate.damageRoll ||
      candidate.targets),
  );
}

function isChatMessageLike(candidate) {
  return Boolean(
    candidate?.documentName === "ChatMessage" ||
    candidate?.speaker ||
    candidate?.rolls ||
    candidate?.content,
  );
}

function isTokenLike(candidate) {
  return Boolean(candidate?.actor && (candidate.center || candidate.document));
}

function isModuleActive(gameRef, moduleId) {
  try {
    return gameRef?.modules?.get?.(moduleId)?.active === true;
  } catch {
    return false;
  }
}

function isAnimationBridgeActive(gameRef) {
  return (
    Boolean(globalThis.Sequencer) ||
    ANIMATION_MODULE_IDS.some((moduleId) => isModuleActive(gameRef, moduleId))
  );
}

function isAnimationCandidate(context) {
  const activity = context?.activity;
  const item = context?.item;
  const activityType = context?.activityType;
  const itemType = context?.itemType;

  if (itemType === "spell") return true;
  if (activityType === "attack" && isRangedActivity(activity, item))
    return true;
  if (hasTemplateTarget(activity) || hasTemplateTarget(item?.system))
    return true;
  return false;
}

function isRangedActivity(activity, item) {
  const attackType = normalizeId(
    activity?.attack?.type?.value ??
      activity?.system?.attack?.type?.value ??
      item?.system?.attack?.type?.value,
  );
  if (attackType.startsWith("r")) return true;

  const units = normalizeId(
    activity?.range?.units ??
      activity?.system?.range?.units ??
      item?.system?.range?.units,
  );
  const value = Number(
    activity?.range?.value ??
      activity?.system?.range?.value ??
      item?.system?.range?.value ??
      0,
  );
  return value > 0 && units !== "self" && units !== "touch";
}

function hasTemplateTarget(source) {
  return Boolean(
    source?.target?.template?.type ||
    source?.system?.target?.template?.type ||
    source?.target?.type === "template",
  );
}

function chatMessageHasRollResult(message) {
  return Array.isArray(message?.rolls) && message.rolls.length > 0;
}

function workflowHasResult(workflow) {
  return Boolean(
    workflow?.attackRoll ||
    workflow?.damageRoll ||
    workflow?.saveRoll ||
    (Array.isArray(workflow?.damageRolls) && workflow.damageRolls.length > 0) ||
    nonEmptyCollection(workflow?.hitTargets) ||
    nonEmptyCollection(workflow?.failedSaves),
  );
}

function nonEmptyCollection(value) {
  if (!value) return false;
  if (typeof value.size === "number") return value.size > 0;
  if (Array.isArray(value)) return value.length > 0;
  return false;
}

function buildContextKey({ actor, activity, item, message }) {
  const parts = [
    actor?.uuid ?? actor?.id,
    item?.uuid ?? item?.id ?? item?.name,
    activity?.id ?? activity?._id ?? activity?.name ?? activity?.type,
    message?.id,
  ]
    .map(normalizeContextPart)
    .filter(Boolean);
  return parts.length > 0 ? parts.join(":") : null;
}

function buildDedupeKey({ activity, item, message }) {
  const parts = [
    item?.uuid ?? item?.id ?? item?.name,
    activity?.id ?? activity?._id ?? activity?.name ?? activity?.type,
    message?.id,
  ]
    .map(normalizeContextPart)
    .filter(Boolean);
  return parts.length > 0 ? parts.join(":") : null;
}

function buildFallbackContextKey(phase) {
  return `unknown:${phase}`;
}

function normalizeContextPart(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80);
}

function normalizeId(value) {
  return String(value ?? "").trim();
}
