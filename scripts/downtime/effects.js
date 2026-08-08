import { merchantItemId } from "../merchant/write-verification.js";
import { sharpeningLifecycleAvailability } from "./socket.js";

const MODULE_ID = "infinity-dnd5e";
const FLAG_PATH = `flags.${MODULE_ID}.downtimeSharpen`;
const FLAG_SCOPE = MODULE_ID;
const FLAG_KEY = "downtimeSharpen";
const EFFECT_NAME = "Sharpened Edge";
const NATIVE_DAMAGE_PART_FIX = Object.freeze([4, 4, 3]);

function sourceOf(document) {
  return document?.toObject?.() ?? document ?? {};
}

function valuesOf(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  if (typeof collection.values === "function") return [...collection.values()];
  if (typeof collection === "object") return Object.values(collection);
  return Array.from(collection ?? []);
}

function documentId(document) {
  return String(document?.id ?? document?._id ?? "").trim();
}

function propertySet(item) {
  const raw = sourceOf(item).system?.properties;
  if (raw instanceof Set) return raw;
  if (Array.isArray(raw)) return new Set(raw);
  if (raw && typeof raw === "object") {
    return new Set(
      Object.entries(raw)
        .filter(([, enabled]) => enabled === true)
        .map(([key]) => key),
    );
  }
  return new Set();
}

function activityValues(item) {
  return valuesOf(
    item?.system?.activities ?? sourceOf(item).system?.activities,
  );
}

/** Return the first piercing/slashing type used by an eligible damage part. */
export function sharpenDamageType(item) {
  const allowed = new Set(["piercing", "slashing"]);
  for (const activity of activityValues(item)) {
    const parts = valuesOf(activity?.damage?.parts);
    for (const part of parts) {
      const types = valuesOf(part?.types ?? part?.type);
      for (const type of types) {
        const id = String(type ?? "").toLowerCase();
        if (allowed.has(id)) return id;
      }
    }
  }
  const legacyParts = sourceOf(item).system?.damage?.parts;
  for (const part of Array.isArray(legacyParts) ? legacyParts : []) {
    const type = String(
      Array.isArray(part) ? part[1] : (part?.type ?? ""),
    ).toLowerCase();
    if (allowed.has(type)) return type;
  }
  const baseTypes = valuesOf(
    item?.system?.damage?.base?.types ??
      sourceOf(item).system?.damage?.base?.types,
  );
  for (const type of baseTypes) {
    const id = String(type ?? "").toLowerCase();
    if (allowed.has(id)) return id;
  }
  return null;
}

/** Whether the item is a nonmagical melee piercing/slashing weapon. */
export function isSharpenableWeapon(item) {
  const data = sourceOf(item);
  if (data.type !== "weapon") return false;
  const properties = propertySet(item);
  if (properties.has("mgc") || properties.has("magic")) return false;
  const rarity = String(data.system?.rarity ?? "")
    .trim()
    .toLowerCase();
  if (
    rarity &&
    rarity !== "common" &&
    rarity !== "none" &&
    rarity !== "mundane"
  ) {
    return false;
  }

  const attacks = activityValues(item).filter((activity) => {
    const type = String(
      activity?.type ?? activity?.constructor?.type ?? "",
    ).toLowerCase();
    return type === "attack" || activity?.attack;
  });
  const explicitlyRanged = attacks.some((activity) => {
    const attackType = String(
      activity?.attack?.type?.value ?? activity?.attack?.type ?? "",
    ).toLowerCase();
    return attackType === "ranged";
  });
  const explicitlyMelee = attacks.some((activity) => {
    const attackType = String(
      activity?.attack?.type?.value ?? activity?.attack?.type ?? "",
    ).toLowerCase();
    return attackType === "melee";
  });
  const legacyAction = String(data.system?.actionType ?? "").toLowerCase();
  if (explicitlyRanged || legacyAction === "rwak") return false;
  if (!explicitlyMelee && attacks.length > 0 && legacyAction !== "mwak") {
    const rangeUnits = String(data.system?.range?.units ?? "").toLowerCase();
    if (["ft", "mi", "m", "km"].includes(rangeUnits)) return false;
  }
  return Boolean(sharpenDamageType(item));
}

export function sharpeningEffects(item) {
  return valuesOf(item?.effects).filter(
    (effect) => sourceOf(effect).flags?.[MODULE_ID]?.downtimeSharpen,
  );
}

function isEffectActive(effect) {
  const data = sourceOf(effect);
  if (data.disabled === true || effect?.disabled === true) return false;
  if (data.isSuppressed === true || effect?.isSuppressed === true) return false;
  if (effect && "active" in effect && effect.active === false) return false;
  return true;
}

/** Active sharpening effects grant and spend their damage-roll benefit. */
export function activeSharpeningEffects(item) {
  return sharpeningEffects(item).filter(isEffectActive);
}

export function hasSharpening(item) {
  return sharpeningEffects(item).length > 0;
}

export function hasActiveSharpening(item) {
  return activeSharpeningEffects(item).length > 0;
}

function sharpeningReference(item, effect) {
  const marker = sourceOf(effect).flags?.[MODULE_ID]?.downtimeSharpen ?? {};
  return {
    itemId: documentId(item),
    effectId: documentId(effect),
    operationId: String(marker.operationId ?? "").trim(),
  };
}

export function sharpeningEffectReferences(actor) {
  const references = [];
  for (const item of valuesOf(actor?.items)) {
    for (const effect of sharpeningEffects(item)) {
      const reference = sharpeningReference(item, effect);
      if (reference.itemId && reference.effectId && reference.operationId) {
        references.push(reference);
      }
    }
  }
  return references;
}

/**
 * D&D5e did not safely prepare enchantments that add damage parts on Foundry
 * V13 until 4.4.3. Keep the module's hook-based compatibility path for older
 * releases and malformed/unknown versions rather than risking the weapon's
 * prepared data.
 */
export function supportsNativeDamagePartEnchantments(
  systemVersion = globalThis.game?.system?.version,
) {
  const value = String(systemVersion ?? "").trim();
  const match = value.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const actual = match.slice(1, 4).map(Number);
  for (let index = 0; index < NATIVE_DAMAGE_PART_FIX.length; index += 1) {
    if (actual[index] > NATIVE_DAMAGE_PART_FIX[index]) return true;
    if (actual[index] < NATIVE_DAMAGE_PART_FIX[index]) return false;
  }
  const suffix = value.slice((match.index ?? 0) + match[0].length).trim();
  return !suffix.startsWith("-");
}

export function buildSharpeningEffect({
  operationId,
  actorId,
  itemId,
  damageType,
  timestamp = Date.now(),
  nativeDamagePart = true,
} = {}) {
  const opId = String(operationId ?? "").trim();
  const type = ["piercing", "slashing"].includes(damageType)
    ? damageType
    : "slashing";
  const compatibilityFallback = nativeDamagePart !== true;
  return {
    _id: merchantItemId(`${opId}:sharpen-effect`),
    name: EFFECT_NAME,
    img: "icons/tools/hand/hammer-and-nail.webp",
    type: "enchantment",
    origin: `Actor.${String(actorId ?? "unknown")}`,
    disabled: false,
    transfer: false,
    changes: compatibilityFallback
      ? []
      : [
          {
            key: "system.damage.parts",
            mode: globalThis.CONST?.ACTIVE_EFFECT_MODES?.ADD ?? 2,
            priority: 20,
            value: JSON.stringify({ bonus: "1", types: [type] }),
          },
        ],
    flags: {
      [MODULE_ID]: {
        downtimeSharpen: {
          operationId: opId,
          actorId: String(actorId ?? ""),
          itemId: String(itemId ?? ""),
          charges: 3,
          rollIds: [],
          bonus: "1",
          types: [type],
          damageType: type,
          locked: true,
          enchantment: true,
          compatibilityFallback,
          timestamp: Number(timestamp) || 0,
        },
      },
    },
  };
}

/** Apply and canonically verify a module-owned sharpening enchantment. */
export async function applySharpeningEffect(
  item,
  { operationId, actorId, timestamp, authorizeWrite = null } = {},
) {
  if (!item || typeof item.createEmbeddedDocuments !== "function") {
    return { ok: false, reason: "invalid-weapon" };
  }
  if (!isSharpenableWeapon(item)) {
    return { ok: false, reason: "ineligible-weapon" };
  }
  if (hasSharpening(item)) {
    return { ok: false, reason: "already-sharpened" };
  }
  const damageType = sharpenDamageType(item);
  const effectData = buildSharpeningEffect({
    operationId,
    actorId,
    itemId: documentId(item),
    damageType,
    timestamp,
    nativeDamagePart: supportsNativeDamagePartEnchantments(),
  });
  let returned;
  let error = null;
  if (!writeAuthorized(authorizeWrite)) {
    return {
      ok: false,
      reason: "authority-lost",
      effectId: effectData._id,
      damageType,
      provenUnapplied: true,
    };
  }
  try {
    returned = await item.createEmbeddedDocuments(
      "ActiveEffect",
      [effectData],
      {
        keepId: true,
      },
    );
  } catch (caught) {
    error = caught;
  }
  const createdId = effectData._id;
  const canonical =
    item.effects?.get?.(createdId) ??
    valuesOf(item.effects).find((effect) => documentId(effect) === createdId) ??
    null;
  const returnedId = documentId(Array.isArray(returned) ? returned[0] : null);
  const flag = sourceOf(canonical).flags?.[MODULE_ID]?.downtimeSharpen;
  const ok =
    !error &&
    returnedId === createdId &&
    Boolean(canonical) &&
    flag?.operationId === String(operationId ?? "").trim() &&
    Number(flag?.charges) === 3 &&
    flag?.compatibilityFallback ===
      effectData.flags[MODULE_ID].downtimeSharpen.compatibilityFallback;
  return {
    ok,
    reason: ok ? "" : error ? "effect-create-failed" : "effect-unconfirmed",
    error,
    effectId: createdId,
    damageType,
    compatibilityFallback:
      effectData.flags[MODULE_ID].downtimeSharpen.compatibilityFallback,
  };
}

async function deleteEffectVerified(
  item,
  effect,
  { authorizeWrite = null } = {},
) {
  const effectId = documentId(effect);
  if (!effectId || typeof item?.deleteEmbeddedDocuments !== "function") {
    return { ok: false, reason: "effect-delete-unconfirmed" };
  }
  let returned;
  let error = null;
  if (!writeAuthorized(authorizeWrite)) {
    return {
      ok: false,
      reason: "authority-lost",
      effectId,
      provenUnapplied: true,
    };
  }
  try {
    returned = await item.deleteEmbeddedDocuments("ActiveEffect", [effectId]);
  } catch (caught) {
    error = caught;
  }
  const returnedIds = (Array.isArray(returned) ? returned : [])
    .map(documentId)
    .filter(Boolean);
  const canonical =
    item.effects?.get?.(effectId) ??
    valuesOf(item.effects).find(
      (candidate) => documentId(candidate) === effectId,
    );
  const ok = !error && returnedIds.includes(effectId) && !canonical;
  return {
    ok,
    reason: ok
      ? ""
      : error
        ? "effect-delete-failed"
        : "effect-delete-unconfirmed",
    error,
    effectId,
  };
}

/** Consume one sharpening charge exactly once for a unique damage-roll id. */
export async function consumeSharpeningCharge(
  item,
  rollId,
  { authorizeWrite = null, effectId = null, operationId = null } = {},
) {
  const expectedEffectId = String(effectId ?? "").trim();
  const expectedOperationId = String(operationId ?? "").trim();
  const effect =
    activeSharpeningEffects(item).find((candidate) => {
      const marker =
        sourceOf(candidate).flags?.[MODULE_ID]?.downtimeSharpen ?? {};
      return (
        (!expectedEffectId || documentId(candidate) === expectedEffectId) &&
        (!expectedOperationId || marker.operationId === expectedOperationId)
      );
    }) ?? null;
  if (!effect) return { ok: true, reason: "not-sharpened", consumed: false };
  const marker = sourceOf(effect).flags?.[MODULE_ID]?.downtimeSharpen ?? {};
  const uniqueRollId = String(rollId ?? "").trim();
  if (!uniqueRollId) return { ok: false, reason: "invalid-roll-id" };
  const priorIds = Array.isArray(marker.rollIds)
    ? marker.rollIds.map(String).slice(-3)
    : [];
  if (priorIds.includes(uniqueRollId)) {
    return { ok: true, reason: "duplicate", consumed: false };
  }
  const charges = Math.max(
    0,
    Math.min(3, Math.floor(Number(marker.charges) || 0)),
  );
  if (charges <= 1) {
    const deleted = await deleteEffectVerified(item, effect, {
      authorizeWrite,
    });
    return {
      ...deleted,
      consumed: deleted.ok,
      charges: deleted.ok ? 0 : charges,
    };
  }
  if (typeof effect.update !== "function") {
    return { ok: false, reason: "effect-update-unconfirmed" };
  }
  const nextIds = [...priorIds, uniqueRollId].slice(-3);
  let returned;
  let error = null;
  if (!writeAuthorized(authorizeWrite)) {
    return {
      ok: false,
      reason: "authority-lost",
      consumed: false,
      charges,
      provenUnapplied: true,
    };
  }
  try {
    returned = await effect.update({
      [`${FLAG_PATH}.charges`]: charges - 1,
      [`${FLAG_PATH}.rollIds`]: nextIds,
    });
  } catch (caught) {
    error = caught;
  }
  const canonical =
    item.effects?.get?.(documentId(effect)) ??
    valuesOf(item.effects).find(
      (candidate) => documentId(candidate) === documentId(effect),
    );
  const current = sourceOf(canonical).flags?.[FLAG_SCOPE]?.[FLAG_KEY];
  const ok =
    !error &&
    documentId(returned) === documentId(effect) &&
    Number(current?.charges) === charges - 1 &&
    Array.isArray(current?.rollIds) &&
    current.rollIds.includes(uniqueRollId);
  return {
    ok,
    reason: ok
      ? ""
      : error
        ? "effect-update-failed"
        : "effect-update-unconfirmed",
    error,
    consumed: ok,
    charges: ok ? charges - 1 : charges,
  };
}

/** Remove every downtime sharpening effect on an actor after a long rest. */
export async function clearSharpeningOnLongRest(
  actor,
  { authorizeWrite = null, references = null } = {},
) {
  const expected = Array.isArray(references)
    ? new Set(
        references.map(
          (reference) =>
            `${String(reference?.itemId ?? "")}:${String(reference?.effectId ?? "")}:${String(reference?.operationId ?? "")}`,
        ),
      )
    : null;
  const results = [];
  for (const item of valuesOf(actor?.items)) {
    for (const effect of sharpeningEffects(item)) {
      const reference = sharpeningReference(item, effect);
      if (
        expected &&
        !expected.has(
          `${reference.itemId}:${reference.effectId}:${reference.operationId}`,
        )
      ) {
        continue;
      }
      results.push(
        await deleteEffectVerified(item, effect, { authorizeWrite }),
      );
    }
  }
  return {
    ok: results.every((result) => result.ok),
    removed: results.filter((result) => result.ok).length,
    results,
  };
}

function writeAuthorized(authorizeWrite) {
  if (typeof authorizeWrite !== "function") return true;
  try {
    return authorizeWrite() === true;
  } catch {
    return false;
  }
}

let hooksRegistered = false;
let damageRollSequence = 0;
const damageRollIds = new WeakMap();
const fallbackDamageConfigs = new WeakSet();

function rollSubjectItem(subject) {
  return subject?.item ?? subject?.parent ?? null;
}

function fallbackMarker(item) {
  for (const effect of activeSharpeningEffects(item)) {
    const data = sourceOf(effect);
    const marker = data.flags?.[MODULE_ID]?.downtimeSharpen;
    const damageType = String(
      marker?.types?.[0] ?? marker?.damageType ?? "",
    ).toLowerCase();
    if (
      data.type === "enchantment" &&
      marker?.compatibilityFallback === true &&
      marker?.bonus === "1" &&
      marker?.locked === true &&
      marker?.enchantment === true &&
      Number(marker?.charges) > 0 &&
      ["piercing", "slashing"].includes(damageType)
    ) {
      const reference = sharpeningReference(item, effect);
      const availability = sharpeningLifecycleAvailability({
        actorId: item?.parent?.id ?? item?.actor?.id,
        ...reference,
        charges: Number(marker.charges),
        rollIds: marker.rollIds,
      });
      if (!availability.available) continue;
      return { effect, marker, damageType, reference };
    }
  }
  return null;
}

function availableSharpening(item) {
  for (const effect of activeSharpeningEffects(item)) {
    const marker = sourceOf(effect).flags?.[MODULE_ID]?.downtimeSharpen ?? {};
    const reference = sharpeningReference(item, effect);
    const availability = sharpeningLifecycleAvailability({
      actorId: item?.parent?.id ?? item?.actor?.id,
      ...reference,
      charges: Number(marker.charges),
      rollIds: marker.rollIds,
    });
    if (availability.available) return { effect, marker, reference };
  }
  return null;
}

/** Append one compatibility damage part to a D&D5e 4.0.4 roll config. */
export function injectSharpeningDamageBonus(rollConfig = {}) {
  if (!rollConfig || typeof rollConfig !== "object") return false;
  if (fallbackDamageConfigs.has(rollConfig)) return false;
  const item = rollSubjectItem(rollConfig.subject);
  const fallback = fallbackMarker(item);
  if (!item || !fallback) return false;
  if (!Array.isArray(rollConfig.rolls)) rollConfig.rolls = [];
  rollConfig.rolls.push({
    data: {},
    parts: ["1"],
    options: {
      type: fallback.damageType,
      types: [fallback.damageType],
      properties: [],
    },
  });
  fallbackDamageConfigs.add(rollConfig);
  return true;
}

function damageRollId(roll) {
  const explicit = String(roll?.id ?? roll?._id ?? "").trim();
  if (explicit) return explicit;
  const canCache = Boolean(
    roll && (typeof roll === "object" || typeof roll === "function"),
  );
  if (canCache && damageRollIds.has(roll)) return damageRollIds.get(roll);
  damageRollSequence += 1;
  const generated = String(
    globalThis.foundry?.utils?.randomID?.(16) ??
      `damage-${Date.now().toString(36)}-${damageRollSequence.toString(36)}`,
  );
  if (canCache) damageRollIds.set(roll, generated);
  return generated;
}

/** Wire D&D5e roll/rest hooks; authoritative mutation is supplied by caller. */
export function registerSharpeningHooks({ onDamage, onLongRest } = {}) {
  if (hooksRegistered || typeof globalThis.Hooks?.on !== "function") {
    return hooksRegistered;
  }
  globalThis.Hooks.on("dnd5e.preRollDamageV2", (rollConfig = {}) => {
    injectSharpeningDamageBonus(rollConfig);
  });
  globalThis.Hooks.on("dnd5e.rollDamageV2", (rolls, data = {}) => {
    const item = rollSubjectItem(data?.subject);
    const sharpening = item ? availableSharpening(item) : null;
    if (!item || !sharpening) return;
    const ids = (Array.isArray(rolls) ? rolls : [rolls])
      .map(damageRollId)
      .filter(Boolean);
    const rollId = ids.join(":") || `${documentId(item)}:${Date.now()}`;
    void onDamage?.({
      item,
      rollId,
      effectId: sharpening.reference.effectId,
      operationId: sharpening.reference.operationId,
    });
  });
  globalThis.Hooks.on(
    "dnd5e.restCompleted",
    (actor, result = {}, config = {}) => {
      if (result?.longRest !== true && config?.longRest !== true) return;
      if (!valuesOf(actor?.items).some(hasSharpening)) return;
      void onLongRest?.({
        actor,
        references: sharpeningEffectReferences(actor),
      });
    },
  );
  hooksRegistered = true;
  return true;
}
