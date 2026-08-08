/** Active Effect persistence for Version 2 Critical Injuries. */

import {
  CRITICAL_INJURY_TABLE_VERSION,
  buildCriticalInjuryChanges,
  buildCriticalInjuryEffectText,
  getCriticalInjuryDefinition,
} from "./table.js";

const MODULE_ID = "infinity-dnd5e";
const EFFECT_FLAG = "criticalInjury";

export function generateCriticalInjuryId() {
  const randomId = globalThis.foundry?.utils?.randomID;
  if (typeof randomId === "function") return `injury-${randomId(16)}`;
  const random = () =>
    Math.floor(Math.random() * 0x100000)
      .toString(16)
      .padStart(5, "0");
  return `injury-${random()}${random()}${random()}`;
}

export function generateCriticalInjuryEffectDocumentId() {
  const randomId = globalThis.foundry?.utils?.randomID;
  if (typeof randomId === "function") return String(randomId(16));
  return generateCriticalInjuryId()
    .replace(/^injury-/, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .padEnd(16, "0")
    .slice(0, 16);
}

export function getCriticalInjuryData(effect) {
  return (
    effect?.getFlag?.(MODULE_ID, EFFECT_FLAG) ??
    effect?.flags?.[MODULE_ID]?.[EFFECT_FLAG] ??
    null
  );
}

export function isCriticalInjuryEffect(effect) {
  return Boolean(getCriticalInjuryData(effect)?.id);
}

export function getActorCriticalInjuryEffects(actor) {
  const effects = actor?.effects?.contents ?? actor?.effects ?? [];
  return Array.from(effects ?? []).filter((effect) =>
    isCriticalInjuryEffect(effect),
  );
}

export function findActorCriticalInjuryEffect(actor, injuryId) {
  const id = String(injuryId ?? "").trim();
  if (!id) return null;
  return (
    getActorCriticalInjuryEffects(actor).find(
      (effect) => String(getCriticalInjuryData(effect)?.id) === id,
    ) ?? null
  );
}

export function effectiveRecoveryCalendarDays(injury) {
  if (injury?.permanent) return 0;
  const remaining = Math.max(0, Math.ceil(Number(injury?.remainingDays) || 0));
  if (remaining <= 0) return 0;
  return Math.max(1, Math.ceil(remaining / (injury?.stabilized ? 2 : 1)));
}

export function buildCriticalInjuryEffectData(
  injury,
  { startTime = 0, dueTimestamp = null, modes = {} } = {},
) {
  const definition =
    getCriticalInjuryDefinition(injury?.injuryKey) ??
    injury?.definition ??
    null;
  const permanent = Boolean(injury?.permanent || definition?.permanent);
  const due = Number(dueTimestamp ?? injury?.recoveryDueTs);
  const start = Number(startTime) || 0;
  const seconds = Number.isFinite(due) ? Math.max(1, due - start) : null;
  const detail = injury?.detail ?? null;
  const effectText = String(
    injury?.effect ?? buildCriticalInjuryEffectText(definition, detail),
  );
  const recoveryRule = String(
    injury?.recoveryRule ?? definition?.recovery ?? "",
  );
  const remaining = Math.max(0, Number(injury?.remainingDays) || 0);
  const recoveryLabel = permanent
    ? "Permanent"
    : `${remaining} recovery day(s)${injury?.stabilized ? " (stabilized)" : ""}`;
  const description = [effectText, `Recovery: ${recoveryLabel}`, recoveryRule]
    .filter(Boolean)
    .join(" | ");
  const changes = buildCriticalInjuryChanges(
    definition,
    {
      detail,
      infectionHpLoss: injury?.infectionHpLoss,
    },
    modes,
  );

  const duration = { startTime: start };
  // Untreated knee/nerve injuries convert to permanent at their deadline.
  // Keep those effects alive until the authoritative service performs that
  // transition; Times Up must not delete them as ordinary expiring effects.
  if (!permanent && !injury?.canBecomePermanent && seconds != null) {
    duration.seconds = seconds;
  }

  return {
    name: `Critical Injury — ${String(injury?.injuryName ?? definition?.label ?? "Injury")}`,
    img: permanent
      ? "icons/svg/skull.svg"
      : injury?.stabilized
        ? "icons/svg/regen.svg"
        : "icons/svg/hazard.svg",
    type: "base",
    system: {},
    disabled: false,
    transfer: false,
    description,
    duration,
    changes,
    statuses: [],
    flags: {
      [MODULE_ID]: {
        [EFFECT_FLAG]: {
          ...injury,
          schema: 1,
          tableVersion: CRITICAL_INJURY_TABLE_VERSION,
          permanent,
          effect: effectText,
          recoveryRule,
          recoveryDueTs: permanent ? null : due,
        },
      },
      dae: {
        disableIncapacitated: false,
        selfTarget: true,
        selfTargetAlways: true,
        dontApply: false,
        stackable: "multi",
        showIcon: true,
        durationExpression: "",
        macroRepeat: "none",
        specialDuration: [],
      },
      "times-up": { isPassive: false },
    },
  };
}

export async function createCriticalInjuryEffect(actor, injury, timing = {}) {
  if (!actor || typeof actor.createEmbeddedDocuments !== "function") {
    throw new Error("CriticalInjuryActorNotWritable");
  }
  const data = buildCriticalInjuryEffectData(injury, {
    ...timing,
    modes: activeEffectModes(),
  });
  const documentId = String(timing?.documentId ?? "").trim();
  if (documentId) data._id = documentId;
  if (actor.uuid) data.origin = actor.uuid;
  let created;
  try {
    created = await actor.createEmbeddedDocuments(
      "ActiveEffect",
      [data],
      documentId ? { keepId: true } : {},
    );
  } catch (error) {
    const existing = findActorEffectByDocumentId(actor, documentId);
    if (existing && criticalInjuryEffectMatches(existing, injury)) {
      return existing;
    }
    if (existing) {
      throw new Error("CriticalInjuryEffectDocumentCollision", {
        cause: error,
      });
    }
    throw error;
  }
  const effect =
    findActorEffectByDocumentId(actor, documentId) ?? created?.[0] ?? null;
  if (!effect || !criticalInjuryEffectMatches(effect, injury)) {
    throw new Error("CriticalInjuryEffectCreateVerificationFailed");
  }
  return effect;
}

function findActorEffectByDocumentId(actor, documentId) {
  const id = String(documentId ?? "").trim();
  if (!id) return null;
  const direct = actor?.effects?.get?.(id);
  if (direct) return direct;
  const effects = actor?.effects?.contents ?? actor?.effects ?? [];
  return (
    Array.from(effects ?? []).find(
      (effect) => String(effect?.id ?? effect?._id ?? "") === id,
    ) ?? null
  );
}

function criticalInjuryEffectMatches(effect, injury) {
  const existing = getCriticalInjuryData(effect);
  return Boolean(
    existing &&
    String(existing.id ?? "") === String(injury?.id ?? "") &&
    String(existing.pendingId ?? "") === String(injury?.pendingId ?? ""),
  );
}

export async function updateCriticalInjuryEffect(effect, injury, timing = {}) {
  if (!effect || typeof effect.update !== "function") {
    throw new Error("CriticalInjuryEffectNotWritable");
  }
  const data = buildCriticalInjuryEffectData(injury, {
    ...timing,
    modes: activeEffectModes(),
  });
  const update = {
    name: data.name,
    img: data.img,
    description: data.description,
    duration: data.duration,
    changes: data.changes,
    flags: data.flags,
  };
  await effect.update(update);
  return effect;
}

function activeEffectModes() {
  return (
    globalThis.CONST?.ACTIVE_EFFECT_MODES ?? {
      MULTIPLY: 1,
      ADD: 2,
      OVERRIDE: 5,
    }
  );
}
