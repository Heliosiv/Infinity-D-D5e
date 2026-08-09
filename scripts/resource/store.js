/**
 * Infinity D&D5e — Resource store
 *
 * Persistence + normalization for the Quartermaster's configuration and its
 * moving run-state. Both live in the restricted private-state Journal:
 *   - `resourceConfig`   — the GM-tunable structure (resources, environments,
 *                          modes). Rewritten only when the GM edits it.
 *   - `resourceRunState` — day/environment state, the latest report, active
 *                          safety lease, and bounded private run receipts.
 *
 * Pure shaping (normalize/create) is exported for node tests; the Foundry-
 * touching load/save use private-state.js. Legacy world-setting fallback is
 * retained only outside a live Foundry session so the pure Node harness and
 * old migration fixtures can run without constructing a Journal document.
 */

import {
  getPrivateState,
  isPrivilegedPrivateStateReady,
  setPrivateState,
} from "../private-state.js";
import { isFullGM } from "../permissions.js";
import { authoritativeGMId, isAuthoritativeGM } from "../socket-authority.js";
import {
  SETTING_KEYS,
  getSetting,
  getSettingDefault,
  setSetting,
} from "../settings.js";
import { persistedValuesEqual } from "../utils/persisted-data.js";
import { normalizeInfinityItemUuid } from "../item-uuid-compat.js";
import {
  getDefaultEnvironments,
  normalizeEnvironmentCatalog,
} from "./environment.js";
import {
  appendRecentRunReceipt,
  buildInterruptedRunReceipt,
  normalizeForageDestination,
  normalizeRecentRuns,
  normalizeRunActorSnapshots,
  normalizeRunEnvironmentSnapshot,
  normalizeRunInitiatorSnapshot,
  normalizeRunReceipt,
} from "./history.js";

export const RESOURCE_CONFIG_VERSION = 4;
export const RESOURCE_RUN_STATE_VERSION = 3;

/** Resource consumption scope. Food/water are per-character; light is party-wide. */
export const RESOURCE_SCOPES = Object.freeze(["per-character", "party"]);

const FORAGE_MODES = Object.freeze(["each", "best"]);
const LEGACY_DEFAULT_FOOD_KEYWORDS = Object.freeze([
  "ration",
  "rations",
  "trail ration",
  "food",
]);
const V3_DEFAULT_FOOD_KEYWORDS = Object.freeze([
  "rations",
  "trail ration",
  "food",
]);
const DEFAULT_FOOD_KEYWORDS = Object.freeze([
  "rations",
  "trail ration",
  "iron ration",
  "emergency ration",
  "field ration",
  "food ration",
]);
const DEFAULT_FOOD_EXCLUDES = Object.freeze(["water ration"]);
const LEGACY_DEFAULT_WATER_KEYWORDS = Object.freeze([
  "waterskin",
  "water ration",
  "water (1 day)",
]);
const DEFAULT_WATER_KEYWORDS = Object.freeze(["water ration", "water (1 day)"]);
const CORE_RATIONS_UUID = "Compendium.dnd5e.items.Item.f4w4GxBi0nYXmhX4";

/**
 * Runtime rules live in normal Foundry settings so the standard Module
 * Settings screen and the Quartermaster editor always change the same values.
 * v1 duplicated these fields inside resourceConfig, leaving the visible
 * settings inert. The v2 migration copies the legacy values once, then stores
 * only structural data (resources, roster, stash, and environments).
 */
export const RESOURCE_RULE_SETTINGS = Object.freeze({
  forageMode: SETTING_KEYS.RESOURCE_FORAGE_MODE,
  waterEnabled: SETTING_KEYS.RESOURCE_WATER_ENABLED,
  halfRations: SETTING_KEYS.RESOURCE_HALF_RATIONS,
  maxCatchUpDays: SETTING_KEYS.RESOURCE_MAX_CATCHUP_DAYS,
});

const RESOURCE_RULE_FIELDS = Object.freeze(Object.keys(RESOURCE_RULE_SETTINGS));

/** `drawFrom` sentinel: a member draws from their own sheet. */
export const DRAW_FROM_SELF = "self";

/** Food/water channels must stay per-character so shortage and exhaustion
 * accounting can identify which character went without a survival resource. */
export function isCanonicalPerCharacterResource(resource) {
  const id = toStr(resource?.id).toLowerCase();
  return (
    id === "food" ||
    id === "water" ||
    resource?.forageYields === "food" ||
    resource?.forageYields === "water"
  );
}

function toStr(value, fallback = "") {
  const s = String(value ?? "").trim();
  return s || fallback;
}

function toInt(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

function toNum(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toStrArray(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    const s = String(entry ?? "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function toItemUuidArray(value) {
  return toStrArray(value).reduce((uuids, uuid) => {
    const canonicalUuid = normalizeInfinityItemUuid(uuid);
    if (!uuids.includes(canonicalUuid)) uuids.push(canonicalUuid);
    return uuids;
  }, []);
}

/** Default per-resource matching + rates. Keys stay stable; labels are friendly. */
function defaultResources() {
  return [
    {
      id: "food",
      label: "Food (Rations)",
      scope: "per-character",
      perDay: 1,
      forageYields: "food",
      matching: {
        nameKeywords: [...DEFAULT_FOOD_KEYWORDS],
        excludeNameKeywords: [...DEFAULT_FOOD_EXCLUDES],
        flagTag: "food",
        itemUuids: [CORE_RATIONS_UUID],
      },
    },
    {
      id: "water",
      label: "Water",
      scope: "per-character",
      perDay: 1,
      forageYields: "water",
      // Deliberately NOT a bare "water" keyword — that would snag "Holy Water",
      // "Water Elemental" figurines, etc. The GM can tag a specific item or add
      // keywords in the Resource Manager.
      matching: {
        nameKeywords: [...DEFAULT_WATER_KEYWORDS],
        excludeNameKeywords: [],
        flagTag: "water",
        itemUuids: [],
      },
    },
    {
      id: "light",
      label: "Light (Torches)",
      scope: "party",
      perDay: 2,
      forageYields: null,
      matching: {
        nameKeywords: ["torch", "torches"],
        excludeNameKeywords: [],
        flagTag: "light",
        itemUuids: [],
      },
    },
  ];
}

/** Normalize one resource definition; drops malformed entries (null). */
export function normalizeResource(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = toStr(raw.id);
  if (!id) return null;
  const matching =
    raw.matching && typeof raw.matching === "object" ? raw.matching : {};
  const forageYields =
    raw.forageYields === "food" || raw.forageYields === "water"
      ? raw.forageYields
      : null;
  const requestedScope = RESOURCE_SCOPES.includes(raw.scope)
    ? raw.scope
    : "per-character";
  const scope = isCanonicalPerCharacterResource({ id, forageYields })
    ? "per-character"
    : requestedScope;
  return {
    id,
    label: toStr(raw.label, id),
    scope,
    perDay: Math.max(0, toNum(raw.perDay, 1)),
    forageYields,
    matching: {
      nameKeywords: toStrArray(matching.nameKeywords),
      excludeNameKeywords: toStrArray(matching.excludeNameKeywords),
      // Every resource needs a stable module-owned identity for stacks that
      // Quartermaster creates. The id is the collision-safe fallback.
      flagTag: toStr(matching.flagTag, id),
      itemUuids: toItemUuidArray(matching.itemUuids),
    },
  };
}

/**
 * Normalize one roster entry — a tracked party character and where it draws its
 * per-character supplies from. Drops entries with no actorId (returns null).
 *   - actorId : the tracked character's id.
 *   - isStash : the character's pack is a shared source other members can draw from.
 *   - consumes: explicit consumer override; null preserves legacy/unspecified intent.
 *   - drawFrom: "self" (own sheet) or another roster member's actorId. Cross-entry
 *               validity (must point at a real stash) is enforced in normalizeRoster.
 */
export function normalizeRosterEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const actorId = toStr(raw.actorId);
  if (!actorId) return null;
  return {
    actorId,
    isStash: raw.isStash === true,
    consumes:
      raw.consumes === true ? true : raw.consumes === false ? false : null,
    drawFrom: toStr(raw.drawFrom) || DRAW_FROM_SELF,
  };
}

/**
 * Normalize the curated roster: dedupe by actorId, drop malformed entries, and
 * resolve each `drawFrom` to a valid target. A stash is always its own source
 * (so stashes are roots and no draw-from cycle is possible); a member may draw
 * from any *other* stash, and falls back to "self" when its target isn't a real
 * stash in the roster. An empty roster means "auto-track every player character"
 * — the Foundry layer fills that in; this stays pure.
 */
export function normalizeRoster(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const entries = [];
  for (const e of list) {
    const n = normalizeRosterEntry(e);
    if (!n || seen.has(n.actorId)) continue;
    seen.add(n.actorId);
    entries.push(n);
  }
  const stashIds = new Set(
    entries.filter((e) => e.isStash).map((e) => e.actorId),
  );
  for (const e of entries) {
    if (e.isStash) {
      e.drawFrom = DRAW_FROM_SELF;
    } else if (
      e.drawFrom !== DRAW_FROM_SELF &&
      (e.drawFrom === e.actorId || !stashIds.has(e.drawFrom))
    ) {
      e.drawFrom = DRAW_FROM_SELF;
    }
  }
  return entries;
}

/** The source actor id a roster entry actually draws from ("self" → own id). */
export function resolveDrawSourceId(entry) {
  if (!entry || typeof entry !== "object") return null;
  return entry.drawFrom && entry.drawFrom !== DRAW_FROM_SELF
    ? entry.drawFrom
    : entry.actorId;
}

/**
 * Normalize the whole config. Idempotent; fills missing fields, drops malformed
 * resources, and guarantees a non-empty environment catalog + resource list.
 */
export function normalizeResourceConfig(input) {
  const raw = input && typeof input === "object" ? input : {};
  const resourcesRaw = Array.isArray(raw.resources) ? raw.resources : [];
  const seenResourceIds = new Set();
  const resources = resourcesRaw.map(normalizeResource).filter((resource) => {
    if (!resource || seenResourceIds.has(resource.id)) return false;
    seenResourceIds.add(resource.id);
    return true;
  });
  repairLegacyDefaultMatchers(resources, raw.version);
  return {
    version: RESOURCE_CONFIG_VERSION,
    forageMode: FORAGE_MODES.includes(raw.forageMode) ? raw.forageMode : "each",
    halfRations: raw.halfRations === true,
    waterEnabled: raw.waterEnabled !== false,
    maxCatchUpDays: Math.max(1, toInt(raw.maxCatchUpDays, 7)),
    forageTimeoutSeconds: Math.max(0, toInt(raw.forageTimeoutSeconds, 120)),
    resources: resources.length > 0 ? resources : defaultResources(),
    roster: normalizeRoster(raw.roster),
    // A single shared stash the WHOLE party draws every per-character supply
    // from — the quartermaster's pack. "" = each member draws from their own
    // sheet (or their per-row nomination). When set, it overrides per-member
    // `drawFrom` so the GM can run one communal pile with one pick.
    partyStashId: toStr(raw.partyStashId),
    environments: normalizeEnvironmentCatalog(raw.environments),
  };
}

/**
 * Older defaults treated every name containing "food" as a ration, treated a
 * reusable Waterskin as disposable water, and allowed plural Water Rations to
 * overlap food. Repair only the exact former defaults; customized keyword
 * lists remain untouched.
 */
function repairLegacyDefaultMatchers(resources, rawVersion) {
  const version = Math.max(0, Math.floor(Number(rawVersion) || 0));
  if (version >= RESOURCE_CONFIG_VERSION) return false;
  let changed = false;
  const food = resources.find(
    (resource) => resource.id === "food" || resource.forageYields === "food",
  );
  const foodWasDefault =
    food &&
    (sameKeywordList(
      food.matching?.nameKeywords,
      LEGACY_DEFAULT_FOOD_KEYWORDS,
    ) ||
      sameKeywordList(food.matching?.nameKeywords, V3_DEFAULT_FOOD_KEYWORDS));
  if (foodWasDefault) {
    food.matching.nameKeywords = [...DEFAULT_FOOD_KEYWORDS];
    if ((food.matching.excludeNameKeywords ?? []).length === 0) {
      food.matching.excludeNameKeywords = [...DEFAULT_FOOD_EXCLUDES];
    }
    if ((food.matching.itemUuids ?? []).length === 0) {
      food.matching.itemUuids = [CORE_RATIONS_UUID];
    }
    changed = true;
  }
  const water = resources.find(
    (resource) => resource.id === "water" || resource.forageYields === "water",
  );
  if (
    water &&
    sameKeywordList(water.matching?.nameKeywords, LEGACY_DEFAULT_WATER_KEYWORDS)
  ) {
    water.matching.nameKeywords = [...DEFAULT_WATER_KEYWORDS];
    changed = true;
  }
  return changed;
}

function sameKeywordList(actual, expected) {
  const normalized = (values) =>
    [
      ...new Set(
        (Array.isArray(values) ? values : [])
          .map((value) =>
            String(value ?? "")
              .trim()
              .toLowerCase(),
          )
          .filter(Boolean),
      ),
    ].sort();
  const left = normalized(actual);
  const right = normalized(expected);
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/** Build a fresh config with all defaults (used on first run). */
export function createDefaultResourceConfig() {
  return normalizeResourceConfig({
    resources: defaultResources(),
    environments: getDefaultEnvironments(),
  });
}

/**
 * Project a normalized runtime config down to the current structural shape.
 * Rule fields deliberately do not persist here; their canonical values live in
 * the four visible settings listed in RESOURCE_RULE_SETTINGS.
 */
export function serializeResourceConfig(input) {
  const config = normalizeResourceConfig(input);
  return {
    version: RESOURCE_CONFIG_VERSION,
    forageTimeoutSeconds: config.forageTimeoutSeconds,
    resources: config.resources,
    roster: config.roster,
    partyStashId: config.partyStashId,
    environments: config.environments,
  };
}

function normalizeActiveUpkeep(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const runId = toStr(input.runId);
  if (!runId) return null;
  const rawDay = input.day;
  const day =
    rawDay == null || !Number.isFinite(Number(rawDay))
      ? null
      : Math.floor(Number(rawDay));
  const rawClaimedAt = Number(input.claimedAt);
  const claimedAt =
    Number.isSafeInteger(rawClaimedAt) && rawClaimedAt >= 0 ? rawClaimedAt : 0;
  const rawStartedAt = Number(input.startedAt);
  const startedAt =
    Number.isSafeInteger(rawStartedAt) && rawStartedAt >= 0
      ? rawStartedAt
      : claimedAt;
  const trigger =
    input.trigger === "calendar"
      ? "calendar"
      : input.trigger === "forage"
        ? "forage"
        : "manual";
  return {
    runId,
    trigger,
    day,
    days: Math.max(1, toInt(input.days, 1)),
    startedAt,
    claimedAt,
    environment: normalizeRunEnvironmentSnapshot(input.environment),
    initiator: normalizeRunInitiatorSnapshot(input.initiator),
    actors: normalizeRunActorSnapshots(input.actors),
    forageTarget:
      trigger === "forage" &&
      ["food-water", "food", "water"].includes(input.forageTarget)
        ? input.forageTarget
        : null,
    forageDestination:
      trigger === "forage"
        ? normalizeForageDestination(input.forageDestination)
        : null,
  };
}

/** Normalize the run-state. lastSeenDay null means "never processed". */
export function normalizeRunState(input) {
  const raw = input && typeof input === "object" ? input : {};
  const lastSeenRaw = raw.lastSeenDay;
  const lastSeenDay =
    lastSeenRaw == null || !Number.isFinite(Number(lastSeenRaw))
      ? null
      : Math.floor(Number(lastSeenRaw));
  const result =
    raw.lastUpkeepResult && typeof raw.lastUpkeepResult === "object"
      ? raw.lastUpkeepResult
      : null;
  return {
    lastSeenDay,
    currentEnvironmentId: toStr(raw.currentEnvironmentId) || null,
    lastUpkeepResult: result,
    activeUpkeep: normalizeActiveUpkeep(raw.activeUpkeep),
    recentRuns: normalizeRecentRuns(raw.recentRuns),
  };
}

function isPersistedRunState(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  if (Number(raw.version) !== RESOURCE_RUN_STATE_VERSION) return false;
  const revision = Number(raw.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) return false;
  if (!toStr(raw.authorityId)) return false;
  if (!toStr(raw.authorityEpoch)) return false;
  if (
    raw.lastSeenDay !== null &&
    (!Number.isInteger(Number(raw.lastSeenDay)) ||
      !Number.isFinite(Number(raw.lastSeenDay)))
  ) {
    return false;
  }
  if (
    raw.currentEnvironmentId !== null &&
    typeof raw.currentEnvironmentId !== "string"
  ) {
    return false;
  }
  if (
    raw.lastUpkeepResult !== null &&
    (!raw.lastUpkeepResult ||
      typeof raw.lastUpkeepResult !== "object" ||
      Array.isArray(raw.lastUpkeepResult))
  ) {
    return false;
  }
  if (raw.activeUpkeep !== null) {
    const activeUpkeep = normalizeActiveUpkeep(raw.activeUpkeep);
    if (
      !activeUpkeep ||
      !persistedValuesEqual(raw.activeUpkeep, activeUpkeep)
    ) {
      return false;
    }
  }
  if (
    !Array.isArray(raw.recentRuns) ||
    !persistedValuesEqual(raw.recentRuns, normalizeRecentRuns(raw.recentRuns))
  ) {
    return false;
  }
  return true;
}

function persistedRunStateRevision(raw) {
  const revision = Number(raw?.revision);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

function serializeRunState(state, { revision, authorityId, authorityEpoch }) {
  const safeRevision = Number(revision);
  if (!Number.isSafeInteger(safeRevision) || safeRevision < 0) {
    throw new Error("ResourceRunStateRevisionInvalid");
  }
  return {
    version: RESOURCE_RUN_STATE_VERSION,
    revision: safeRevision,
    authorityId: toStr(authorityId) || null,
    authorityEpoch: toStr(authorityEpoch) || null,
    ...normalizeRunState(state),
  };
}

function runStateValuesEqual(left, right) {
  return persistedValuesEqual(
    normalizeRunState(left),
    normalizeRunState(right),
  );
}

/* ------------------------------------------------------------------ *
 * Foundry-touching CRUD (graceful via settings.js)
 * ------------------------------------------------------------------ */

export function loadResourceConfig() {
  const raw = readPrivateResourceValue(
    SETTING_KEYS.RESOURCE_CONFIG,
    SETTING_KEYS.RESOURCE_CONFIG,
  );
  const config = normalizeResourceConfig(raw);
  const rawVersion = Math.floor(Number(raw?.version) || 0);
  const hasLegacyRuleValues =
    rawVersion < RESOURCE_CONFIG_VERSION &&
    RESOURCE_RULE_FIELDS.some((field) =>
      Object.prototype.hasOwnProperty.call(raw ?? {}, field),
    );

  // Preserve the behavior of an unmigrated v1 world until the active GM runs
  // the ready migration. v2/current worlds resolve rules from Module Settings.
  if (hasLegacyRuleValues) return config;
  return {
    ...config,
    forageMode: normalizeRuleValue(
      "forageMode",
      getSetting(RESOURCE_RULE_SETTINGS.forageMode),
    ),
    waterEnabled: normalizeRuleValue(
      "waterEnabled",
      getSetting(RESOURCE_RULE_SETTINGS.waterEnabled),
    ),
    halfRations: normalizeRuleValue(
      "halfRations",
      getSetting(RESOURCE_RULE_SETTINGS.halfRations),
    ),
    maxCatchUpDays: normalizeRuleValue(
      "maxCatchUpDays",
      getSetting(RESOURCE_RULE_SETTINGS.maxCatchUpDays),
    ),
  };
}

/**
 * Automation must not run against safe defaults or an unmigrated private
 * payload. Node harnesses remain ready because they intentionally use the
 * legacy settings fallback instead of a live restricted Journal.
 */
export function isResourceAutomationReady() {
  if (!isLiveFoundrySession()) return true;
  if (!isPrivilegedPrivateStateReady()) return false;
  const rawConfig = getPrivateState(SETTING_KEYS.RESOURCE_CONFIG);
  if (Math.floor(Number(rawConfig?.version) || 0) < RESOURCE_CONFIG_VERSION) {
    return false;
  }
  const rawRunState = getPrivateState(SETTING_KEYS.RESOURCE_RUNSTATE);
  const currentUserId = toStr(globalThis.game?.user?.id);
  const authority = observeResourceAuthorityTransition();
  const revisionIsCurrent = isAcceptedRunStateRevision(rawRunState);
  return Boolean(
    isPersistedRunState(rawRunState) &&
    currentUserId &&
    rawRunState.authorityId === currentUserId &&
    rawRunState.authorityEpoch === authority.authorityEpoch &&
    authority.authorityId === currentUserId &&
    revisionIsCurrent,
  );
}

export async function saveResourceConfig(config) {
  await setPrivateState(
    SETTING_KEYS.RESOURCE_CONFIG,
    serializeResourceConfig(config),
  );
  return true;
}

/** Save one canonical runtime rule from the Quartermaster UI. */
export async function setResourceRule(field, value) {
  const settingKey = RESOURCE_RULE_SETTINGS[field];
  if (!settingKey) return false;
  return setSetting(settingKey, normalizeRuleValue(field, value));
}

/** Restore the four canonical runtime rules to their registered defaults. */
export async function resetResourceRules() {
  const writes = RESOURCE_RULE_FIELDS.map((field) => {
    const settingKey = RESOURCE_RULE_SETTINGS[field];
    return setSetting(settingKey, getSettingDefault(settingKey));
  });
  const results = await Promise.all(writes);
  return results.every(Boolean);
}

/**
 * One-time migration to the current structural schema. Private-state
 * initialization first copies the legacy world-setting object into the
 * restricted Journal. This step moves v1 runtime rules into visible settings,
 * repairs the former overlapping default food matcher, then replaces the
 * private payload with the current structural shape.
 */
export async function migrateResourceConfig() {
  const game = globalThis.game;
  if (!isFullGM(game?.user)) return false;
  const activeGM = game.users?.activeGM;
  if (activeGM?.id && activeGM.id !== game.user.id) return false;

  let raw;
  try {
    raw = readPrivateResourceValue(
      SETTING_KEYS.RESOURCE_CONFIG,
      SETTING_KEYS.RESOURCE_CONFIG,
    );
  } catch {
    return false;
  }
  const rawVersion = Math.floor(Number(raw?.version) || 0);
  let changed = false;
  if (rawVersion < RESOURCE_CONFIG_VERSION) {
    const legacy = normalizeResourceConfig(raw);
    for (const field of RESOURCE_RULE_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(raw ?? {}, field)) continue;
      const wroteRule = await setResourceRule(field, legacy[field]);
      if (!wroteRule) return false;
    }
    await saveResourceConfig(legacy);
    changed = true;
  }
  const runStateChanged = await ensurePersistedRunStateForAuthority();
  return changed || runStateChanged;
}

export function loadRunState() {
  return normalizeRunState(readRawRunState());
}

let runStatePatchQueue = Promise.resolve();
let authorityObservationStarted = false;
let observedAuthorityId = null;
let runStateAuthorityEpoch = 0;
let observedAuthorityEpoch = null;
let highestObservedRunStateRevision = -1;
let lastAcceptedRunStateSnapshot = null;
const retiredAuthorityEpochs = new Set();

function createAuthorityEpoch(authorityId) {
  const id = toStr(authorityId);
  if (!id) return null;
  return `${id}:${runStateAuthorityEpoch}:${Date.now()}:${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function currentUserOwnsAuthority(authorityId) {
  const currentUserId = toStr(globalThis.game?.user?.id);
  return Boolean(
    currentUserId &&
    authorityId === currentUserId &&
    isFullGM(globalThis.game?.user),
  );
}

function clonePersistedRunState(raw) {
  return globalThis.foundry?.utils?.deepClone?.(raw) ?? structuredClone(raw);
}

function isAcceptedRunStateRevision(raw) {
  if (!isPersistedRunState(raw)) return false;
  const revision = persistedRunStateRevision(raw);
  const currentUserId = toStr(globalThis.game?.user?.id);
  if (
    isLiveFoundrySession() &&
    (raw.authorityId !== currentUserId ||
      raw.authorityEpoch !== observedAuthorityEpoch)
  ) {
    return false;
  }
  if (revision < highestObservedRunStateRevision) return false;
  if (revision === highestObservedRunStateRevision) {
    return Boolean(
      isPersistedRunState(lastAcceptedRunStateSnapshot) &&
      rawRunStatesEqual(raw, lastAcceptedRunStateSnapshot),
    );
  }
  highestObservedRunStateRevision = revision;
  lastAcceptedRunStateSnapshot = clonePersistedRunState(raw);
  return true;
}

function recoveryRunStateBase(raw, fence) {
  const accepted = lastAcceptedRunStateSnapshot;
  if (!isPersistedRunState(accepted)) return raw;
  const acceptedRevision = persistedRunStateRevision(accepted);
  const rawRevision = persistedRunStateRevision(raw);
  if (!fence.live) {
    return acceptedRevision >= rawRevision ? accepted : raw;
  }
  const acceptedIsCurrent =
    accepted.authorityId === fence.userId &&
    accepted.authorityEpoch === fence.authorityEpoch;
  const rawIsCurrent =
    raw?.authorityId === fence.userId &&
    raw?.authorityEpoch === fence.authorityEpoch;
  if (
    toStr(raw?.authorityEpoch) &&
    retiredAuthorityEpochs.has(raw.authorityEpoch)
  ) {
    return accepted;
  }
  if (acceptedIsCurrent && !rawIsCurrent) return accepted;
  if (acceptedIsCurrent && acceptedRevision >= rawRevision) return accepted;
  if (acceptedRevision > rawRevision) return accepted;
  return raw;
}

/**
 * Observe the designated-GM identity. Module lifecycle hooks call this for
 * every user role/connection change so an away-and-back handoff still
 * invalidates work that was queued under the earlier authority generation.
 */
export function observeResourceAuthorityTransition() {
  const authorityId = authoritativeGMId();
  if (!authorityObservationStarted) {
    authorityObservationStarted = true;
    observedAuthorityId = authorityId;
    observedAuthorityEpoch = currentUserOwnsAuthority(authorityId)
      ? createAuthorityEpoch(authorityId)
      : null;
    return {
      changed: false,
      authorityId,
      epoch: runStateAuthorityEpoch,
      authorityEpoch: observedAuthorityEpoch,
      newlyAuthoritative: false,
    };
  }
  const changed = authorityId !== observedAuthorityId;
  if (changed) {
    if (observedAuthorityEpoch) {
      retiredAuthorityEpochs.add(observedAuthorityEpoch);
    }
    observedAuthorityId = authorityId;
    runStateAuthorityEpoch += 1;
    observedAuthorityEpoch = currentUserOwnsAuthority(authorityId)
      ? createAuthorityEpoch(authorityId)
      : null;
  }
  const currentUserId = toStr(globalThis.game?.user?.id) || null;
  return {
    changed,
    authorityId,
    epoch: runStateAuthorityEpoch,
    authorityEpoch: observedAuthorityEpoch,
    newlyAuthoritative:
      changed &&
      currentUserId !== null &&
      authorityId === currentUserId &&
      isFullGM(),
  };
}

function captureRunStateAuthorityFence() {
  if (!isLiveFoundrySession()) return { live: false };
  const observation = observeResourceAuthorityTransition();
  return {
    live: true,
    authorityId: observation.authorityId,
    authorityEpoch: observation.authorityEpoch,
    epoch: observation.epoch,
    userId: toStr(globalThis.game?.user?.id) || null,
  };
}

function isRunStateAuthorityFenceCurrent(fence) {
  if (!fence?.live) return true;
  const observation = observeResourceAuthorityTransition();
  return Boolean(
    fence.userId &&
    fence.authorityId === fence.userId &&
    observation.authorityId === fence.authorityId &&
    observation.authorityEpoch === fence.authorityEpoch &&
    observation.epoch === fence.epoch &&
    isAuthoritativeGM(),
  );
}

function assertRunStateAuthorityFence(fence) {
  if (isRunStateAuthorityFenceCurrent(fence)) return;
  if (
    fence?.live &&
    (!fence.userId ||
      fence.authorityId !== fence.userId ||
      !isFullGM(globalThis.game?.user))
  ) {
    throw new Error(
      "PermissionDenied: only the authoritative GM may write resource run state",
    );
  }
  throw new Error("ResourceRunStateAuthorityChanged");
}

function rotateRunStateAuthorityForRevisionOverflow(fence, raw) {
  if (fence.live) assertRunStateAuthorityFence(fence);
  const previousEpoch = toStr(raw?.authorityEpoch);
  if (previousEpoch) retiredAuthorityEpochs.add(previousEpoch);
  runStateAuthorityEpoch += 1;
  highestObservedRunStateRevision = -1;

  if (!fence.live) {
    const authorityId =
      toStr(raw?.authorityId) ||
      toStr(globalThis.game?.user?.id) ||
      "node-test";
    return {
      fence,
      revision: 0,
      authorityId,
      authorityEpoch: `${authorityId}:overflow:${runStateAuthorityEpoch}`,
    };
  }

  observedAuthorityEpoch = createAuthorityEpoch(fence.userId);
  const rotatedFence = {
    ...fence,
    epoch: runStateAuthorityEpoch,
    authorityEpoch: observedAuthorityEpoch,
  };
  assertRunStateAuthorityFence(rotatedFence);
  return {
    fence: rotatedFence,
    revision: 0,
    authorityId: rotatedFence.userId,
    authorityEpoch: rotatedFence.authorityEpoch,
  };
}

function nextRunStateWriteIdentity(fence, raw, ...additionalSnapshots) {
  const maximumRevision = Math.max(
    persistedRunStateRevision(raw),
    ...additionalSnapshots.map((snapshot) =>
      persistedRunStateRevision(snapshot),
    ),
    highestObservedRunStateRevision,
  );
  if (maximumRevision < Number.MAX_SAFE_INTEGER) {
    return {
      fence,
      revision: maximumRevision + 1,
      authorityId: fence.live
        ? fence.userId
        : toStr(raw?.authorityId) ||
          toStr(globalThis.game?.user?.id) ||
          "node-test",
      authorityEpoch: fence.live
        ? fence.authorityEpoch
        : toStr(raw?.authorityEpoch) || "node-test:0",
    };
  }
  return rotateRunStateAuthorityForRevisionOverflow(fence, raw);
}

function readRawRunState() {
  return readPrivateResourceValue(
    SETTING_KEYS.RESOURCE_RUNSTATE,
    SETTING_KEYS.RESOURCE_RUNSTATE,
  );
}

function rawRunStatesEqual(left, right) {
  return persistedValuesEqual(left, right);
}

function cloneRunState(state) {
  const normalized = normalizeRunState(state);
  return (
    globalThis.foundry?.utils?.deepClone?.(normalized) ??
    structuredClone(normalized)
  );
}

function enqueueRunStateOperation(operation) {
  const fence = captureRunStateAuthorityFence();
  const pending = runStatePatchQueue.then(() => operation(fence));
  runStatePatchQueue = pending.catch(() => {});
  return pending;
}

async function commitRunState(state, { fence, expectedRaw }) {
  assertRunStateAuthorityFence(fence);
  const before = readRawRunState();
  if (!rawRunStatesEqual(before, expectedRaw)) {
    throw new Error("ResourceRunStateStaleWrite");
  }
  if (fence.live) {
    if (!isPersistedRunState(before) || !isAcceptedRunStateRevision(before)) {
      throw new Error("ResourceRunStateUnavailable");
    }
    if (
      before.authorityId !== fence.userId ||
      before.authorityEpoch !== fence.authorityEpoch
    ) {
      throw new Error("ResourceRunStateAuthorityMismatch");
    }
  }

  const writeIdentity = nextRunStateWriteIdentity(fence, before);
  fence = writeIdentity.fence;
  const next = serializeRunState(state, {
    revision: writeIdentity.revision,
    authorityId: writeIdentity.authorityId,
    authorityEpoch: writeIdentity.authorityEpoch,
  });
  const beforeWrite = () =>
    isRunStateAuthorityFenceCurrent(fence) &&
    rawRunStatesEqual(readRawRunState(), expectedRaw);
  const afterWrite = () =>
    isRunStateAuthorityFenceCurrent(fence) &&
    rawRunStatesEqual(readRawRunState(), next);
  await setPrivateState(SETTING_KEYS.RESOURCE_RUNSTATE, next, {
    beforeWrite,
    afterWrite,
  });
  assertRunStateAuthorityFence(fence);
  const stored = readRawRunState();
  if (
    !rawRunStatesEqual(stored, next) ||
    (fence.live && !isPersistedRunState(stored)) ||
    !runStateValuesEqual(stored, state)
  ) {
    throw new Error("ResourceRunStateWriteVerificationFailed");
  }
  if (!isAcceptedRunStateRevision(stored)) {
    throw new Error("ResourceRunStateRevisionRegression");
  }
  return true;
}

async function ensurePersistedRunStateForAuthority() {
  if (isLiveFoundrySession() && !isAuthoritativeGM()) return false;
  let fence = captureRunStateAuthorityFence();
  assertRunStateAuthorityFence(fence);
  const raw = readRawRunState();
  const currentUserId = toStr(globalThis.game?.user?.id) || null;
  if (
    isPersistedRunState(raw) &&
    (!fence.live ||
      (raw.authorityId === currentUserId &&
        raw.authorityEpoch === fence.authorityEpoch &&
        isAcceptedRunStateRevision(raw)))
  ) {
    return false;
  }

  const recoveryBase = recoveryRunStateBase(raw, fence);
  const writeIdentity = nextRunStateWriteIdentity(fence, raw, recoveryBase);
  fence = writeIdentity.fence;
  const next = serializeRunState(recoveryBase, {
    revision: writeIdentity.revision,
    authorityId: writeIdentity.authorityId,
    authorityEpoch: writeIdentity.authorityEpoch,
  });
  const beforeWrite = () =>
    isRunStateAuthorityFenceCurrent(fence) &&
    rawRunStatesEqual(readRawRunState(), raw);
  const afterWrite = () =>
    isRunStateAuthorityFenceCurrent(fence) &&
    rawRunStatesEqual(readRawRunState(), next);
  await setPrivateState(SETTING_KEYS.RESOURCE_RUNSTATE, next, {
    beforeWrite,
    afterWrite,
  });
  assertRunStateAuthorityFence(fence);
  const stored = readRawRunState();
  if (
    !isPersistedRunState(stored) ||
    !rawRunStatesEqual(stored, next) ||
    (fence.live &&
      (stored.authorityId !== currentUserId ||
        stored.authorityEpoch !== fence.authorityEpoch))
  ) {
    throw new Error("ResourceRunStateMigrationVerificationFailed");
  }
  if (!isAcceptedRunStateRevision(stored)) {
    throw new Error("ResourceRunStateRevisionRegression");
  }
  return true;
}

export function saveRunState(state) {
  const requested = cloneRunState(state);
  return enqueueRunStateOperation(async (fence) => {
    const expectedRaw = readRawRunState();
    return commitRunState(requested, { fence, expectedRaw });
  });
}

/**
 * Serialize same-client read-modify-write patches. Each updater reads only after
 * the preceding write has settled, while the detached queue tail absorbs a
 * rejection so one failed write cannot poison later updates.
 */
function updateRunState(updater) {
  return enqueueRunStateOperation(async (fence) => {
    const expectedRaw = readRawRunState();
    const state = normalizeRunState(expectedRaw);
    updater(state);
    return commitRunState(state, { fence, expectedRaw });
  });
}

/** Patch-style helpers so frequent writes preserve adjacent run-state fields. */
export async function setLastSeenDay(day) {
  const value =
    day == null || !Number.isFinite(Number(day))
      ? null
      : Math.floor(Number(day));
  return updateRunState((state) => {
    state.lastSeenDay = value;
  });
}

export async function setCurrentEnvironment(environmentId) {
  const value = toStr(environmentId) || null;
  return updateRunState((state) => {
    state.currentEnvironmentId = value;
  });
}

export async function setLastUpkeepResult(result) {
  const value =
    result && typeof result === "object"
      ? (globalThis.foundry?.utils?.deepClone?.(result) ??
        structuredClone(result))
      : null;
  return updateRunState((state) => {
    state.lastUpkeepResult = value;
  });
}

/**
 * Persist the single cross-client upkeep lease immediately before Actor writes.
 * Calendar claims reserve their day in the same verified run-state patch, so a
 * failure after inventory mutation can never replay that day automatically.
 */
export async function claimUpkeepRun(claim) {
  const value = normalizeActiveUpkeep(claim);
  if (!value) throw new Error("ResourceUpkeepClaimInvalid");
  if (value.trigger === "calendar" && value.day === null) {
    throw new Error("ResourceUpkeepClaimInvalid");
  }
  return updateRunState((state) => {
    if (state.activeUpkeep) {
      throw new Error(
        `ResourceUpkeepAlreadyActive: ${state.activeUpkeep.runId}`,
      );
    }
    if (value.trigger === "calendar" && value.day !== null) {
      if (state.lastSeenDay !== null && value.day <= state.lastSeenDay) {
        throw new Error(
          `ResourceUpkeepCalendarDayReserved: ${value.day} <= ${state.lastSeenDay}`,
        );
      }
      state.lastSeenDay = value.day;
    }
    state.activeUpkeep = value;
  });
}

/**
 * Assert that this client still owns the canonical upkeep lease. This is
 * intentionally read-only and is called immediately before every Actor write.
 */
export function assertUpkeepClaimCurrent(runId) {
  const expectedRunId = toStr(runId);
  if (!expectedRunId) throw new Error("ResourceUpkeepClaimInvalid");
  const fence = captureRunStateAuthorityFence();
  assertRunStateAuthorityFence(fence);
  const raw = readRawRunState();
  const state = normalizeRunState(raw);
  if (
    !isPersistedRunState(raw) ||
    state.activeUpkeep?.runId !== expectedRunId
  ) {
    throw new Error("ResourceUpkeepClaimLost");
  }
  return true;
}

/**
 * Atomically append a private receipt, optionally store the latest upkeep
 * report, and release the matching lease.
 */
export async function completeUpkeepRun({
  runId,
  result,
  receipt,
  persistResult = true,
} = {}) {
  const expectedRunId = toStr(runId);
  if (!expectedRunId) throw new Error("ResourceUpkeepClaimInvalid");
  const requestedReceipt = normalizeRunReceipt(receipt);
  if (!requestedReceipt || requestedReceipt.runId !== expectedRunId) {
    throw new Error("ResourceRunReceiptInvalid");
  }
  const value =
    result && typeof result === "object"
      ? (globalThis.foundry?.utils?.deepClone?.(result) ??
        structuredClone(result))
      : null;
  return updateRunState((state) => {
    const activeUpkeep = state.activeUpkeep;
    if (activeUpkeep?.runId !== expectedRunId) {
      throw new Error("ResourceUpkeepClaimLost");
    }
    const expectedKind =
      activeUpkeep.trigger === "forage" ? "forage" : "upkeep";
    if (requestedReceipt.kind !== expectedKind) {
      throw new Error("ResourceRunReceiptInvalid");
    }
    const completedReceipt = normalizeRunReceipt({
      ...requestedReceipt,
      runId: activeUpkeep.runId,
      trigger: activeUpkeep.trigger,
      day: activeUpkeep.day ?? requestedReceipt.day,
      days: activeUpkeep.days,
      startedAt: activeUpkeep.startedAt,
      claimedAt: activeUpkeep.claimedAt,
      environment: activeUpkeep.environment ?? requestedReceipt.environment,
      initiator: activeUpkeep.initiator ?? requestedReceipt.initiator,
      forageContext:
        activeUpkeep.trigger === "forage"
          ? {
              target:
                activeUpkeep.forageTarget ??
                requestedReceipt.forageContext?.target,
              destination:
                activeUpkeep.forageDestination ??
                requestedReceipt.forageContext?.destination,
            }
          : null,
    });
    if (!completedReceipt) throw new Error("ResourceRunReceiptInvalid");
    state.recentRuns = appendRecentRunReceipt(
      state.recentRuns,
      completedReceipt,
    );
    if (persistResult) state.lastUpkeepResult = value;
    state.activeUpkeep = null;
  });
}

/**
 * Explicitly acknowledge an interrupted run without replaying it. Calendar
 * claims have already reserved their day, so clearing only releases the lock.
 */
export async function clearUpkeepClaim(
  runId,
  { recordedAt = Date.now() } = {},
) {
  const expectedRunId = toStr(runId);
  if (!expectedRunId) throw new Error("ResourceUpkeepClaimInvalid");
  return updateRunState((state) => {
    if (state.activeUpkeep?.runId !== expectedRunId) {
      throw new Error("ResourceUpkeepClaimLost");
    }
    const receipt = buildInterruptedRunReceipt(state.activeUpkeep, recordedAt);
    if (!receipt) throw new Error("ResourceRunReceiptInvalid");
    state.recentRuns = appendRecentRunReceipt(state.recentRuns, receipt);
    state.activeUpkeep = null;
  });
}

function normalizeRuleValue(field, value) {
  if (field === "forageMode")
    return FORAGE_MODES.includes(value) ? value : "each";
  if (field === "waterEnabled") return value !== false;
  if (field === "halfRations") return value === true;
  if (field === "maxCatchUpDays") return Math.max(1, toInt(value, 7));
  return value;
}

/**
 * Private-state reads stay synchronous for the existing calculation pipeline.
 * Ready initialization hydrates the cache before resource services register.
 * If that invariant breaks in a live Foundry session, throw instead of silently
 * replacing a world's private configuration with defaults.
 */
function readPrivateResourceValue(privateKey, legacySettingKey) {
  const privateValue = getPrivateState(privateKey);
  if (privateValue !== undefined) return privateValue;
  if (isLiveFoundrySession()) {
    throw new Error(`PrivateStateUnavailable: ${privateKey}`);
  }
  return getSetting(legacySettingKey);
}

function isLiveFoundrySession() {
  return Boolean(globalThis.game?.ready && globalThis.JournalEntry?.create);
}

/** Test-only reset for authority generations and the detached patch queue. */
export function resetResourceStoreForTests() {
  runStatePatchQueue = Promise.resolve();
  authorityObservationStarted = false;
  observedAuthorityId = null;
  observedAuthorityEpoch = null;
  runStateAuthorityEpoch = 0;
  highestObservedRunStateRevision = -1;
  lastAcceptedRunStateSnapshot = null;
  retiredAuthorityEpochs.clear();
}
