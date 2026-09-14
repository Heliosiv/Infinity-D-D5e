import {
  readCriticalInjuryBleeding,
  writeCriticalInjuryBleeding,
} from "./workflow-store.js";
/** GM-private Bleeding plans plus atomic Actor HP/receipt writes. */
import { authoritativeGMId, isAuthoritativeGM } from "../socket-authority.js";
import {
  getActorCriticalInjuryEffects,
  getCriticalInjuryData,
} from "./effects.js";
import { persistedValuesEqual } from "../utils/persisted-data.js";

const MODULE = "infinity-dnd5e";
const inFlight = new Set();
const retryTimers = new Map();
const clock = () => Number(globalThis.game?.time?.serverTime ?? Date.now());
const active = (effect) => effect && !effect.disabled && !effect.isSuppressed;
const read = (combat) => readCriticalInjuryBleeding(combat.id);
const assertAuthority = () => {
  if (!isAuthoritativeGM()) throw Error("BleedingAuthorityChanged");
};
const hpSnapshot = (actor) => {
  const value = Number(actor.system?.attributes?.hp?.value);
  const temp = Number(actor.system?.attributes?.hp?.temp ?? 0);
  if (
    !Number.isFinite(value) ||
    !Number.isFinite(temp) ||
    value < 0 ||
    temp < 0
  )
    throw Error("BleedingInvalidHitPoints");
  return { value, temp };
};

export function bleedingDamageAfter(before, damage) {
  const absorbed = Math.min(before.temp, damage);
  return {
    temp: before.temp - absorbed,
    value: Math.max(0, before.value - damage + absorbed),
  };
}

function validateEvents(events) {
  if (!Array.isArray(events)) throw Error("BleedingInvalidEvents");
  const ids = new Set();
  for (const event of events) {
    if (
      !event?.id ||
      ids.has(event.id) ||
      !event.actorUuid ||
      !event.injuryId ||
      !event.effectId ||
      !["pending", "completed", "skipped"].includes(event.state) ||
      (event.check != null &&
        (!Number.isInteger(event.check) ||
          event.check < 1 ||
          event.check > 6)) ||
      (event.damage != null &&
        (!Number.isInteger(event.damage) ||
          event.damage < 1 ||
          event.damage > 4))
    )
      throw Error("BleedingInvalidEvent");
    ids.add(event.id);
    if (
      event.after &&
      (!event.before ||
        event.damage == null ||
        ![event.before.value, event.before.temp].every(
          (value) => Number.isFinite(value) && value >= 0,
        ) ||
        !persistedValuesEqual(
          event.after,
          bleedingDamageAfter(event.before, event.damage),
        ))
    )
      throw Error("BleedingInvalidDamagePlan");
  }
}

/** Explicit GM cancellation for an unapplied conflict; never changes HP. */
export async function skipPendingCombatBleeding(combat, eventId) {
  assertAuthority();
  if (inFlight.has(combat?.id)) throw Error("BleedingApplicationInProgress");
  const before = read(combat);
  if (!before || before.lease?.expires > clock())
    throw Error("BleedingReceiptUnavailableOrLeased");
  validateEvents(before.events);
  const state = structuredClone(before);
  const event = state.events.find((entry) => entry.id === eventId);
  if (!event || event.state !== "pending")
    throw Error("BleedingNoPendingEvent");
  const actor =
    Array.from(combat.combatants ?? []).find(
      (entry) => entry.id === event.combatantId,
    )?.actor ?? (await globalThis.fromUuid?.(event.actorUuid));
  if (!actor || (actor.uuid ?? actor.id) !== event.actorUuid)
    throw Error("BleedingActorUnavailable");
  const applied =
    actor.flags?.[MODULE]?.bleedingDamageReceipts?.[`${combat.id}_${event.id}`];
  if (event.after && persistedValuesEqual(applied, event.after))
    throw Error("BleedingAlreadyAppliedResumeInstead");
  event.state = "skipped";
  event.skippedBy = authoritativeGMId();
  await writeCriticalInjuryBleeding(combat.id, state, before);
}

async function save(combat, state, claiming = false, previous = undefined) {
  assertAuthority();
  if (!claiming && read(combat)?.lease?.id !== state.lease?.id)
    throw Error("BleedingLeaseLost");
  const expected = previous === undefined ? read(combat) : previous;
  state.lease.expires = clock() + 60000;
  try {
    await writeCriticalInjuryBleeding(combat.id, state, expected);
  } catch (error) {
    if (!persistedValuesEqual(read(combat), state)) throw error;
  }
  assertAuthority();
  if (!persistedValuesEqual(read(combat), state))
    throw Error("BleedingPlanWriteUnverified");
}

/** The same Combat document represents one start, including repeated hook delivery. */
export async function processCombatBleeding(
  combat,
  { roll, start = false } = {},
) {
  if (!isAuthoritativeGM() || !combat?.id || inFlight.has(combat.id)) return;
  if (!start && !read(combat)) return;
  inFlight.add(combat.id);
  let leaseId = null;
  try {
    let state = structuredClone(read(combat) ?? null);
    const claimedFrom = structuredClone(state);
    if (state && state.version !== 1)
      throw Error("BleedingUnsupportedReceiptVersion");
    if (state) validateEvents(state.events);
    if (
      state?.events?.every(
        (event) =>
          event.state === "skipped" ||
          (event.state === "completed" && event.chatDone),
      )
    )
      return;
    if (
      state?.lease?.owner === authoritativeGMId() &&
      state.lease.expires > clock()
    ) {
      if (!retryTimers.has(combat.id)) {
        const timer = setTimeout(
          () => {
            retryTimers.delete(combat.id);
            void processCombatBleeding(combat, { roll }).catch((error) =>
              console.warn("Bleeding recovery pending", error),
            );
          },
          Math.min(60000, state.lease.expires - clock() + 100),
        );
        timer.unref?.();
        retryTimers.set(combat.id, timer);
      }
      return;
    }
    if (!state) {
      const seen = new Set();
      const events = [];
      for (const combatant of combat.combatants ?? []) {
        const actor = combatant.actor;
        if (!actor) continue;
        const actorUuid = actor.uuid ?? actor.id;
        if (seen.has(actorUuid)) continue;
        seen.add(actorUuid);
        for (const effect of getActorCriticalInjuryEffects(actor)) {
          if (
            !active(effect) ||
            getCriticalInjuryData(effect)?.injuryKey !== "internal-bleeding"
          )
            continue;
          events.push({
            id: `b${events.length}`,
            actorUuid,
            combatantId: combatant.id,
            injuryId: getCriticalInjuryData(effect).id,
            effectId: effect.id,
            actorName: actor.name,
            state: "pending",
          });
        }
      }
      state = { version: 1, events };
    }
    leaseId =
      globalThis.foundry?.utils?.randomID?.() ?? globalThis.crypto.randomUUID();
    state.lease = {
      id: leaseId,
      owner: authoritativeGMId(),
      expires: clock() + 60000,
    };
    await save(combat, state, true, claimedFrom);
    for (const event of state.events) {
      if (event.state === "completed" || event.state === "skipped") continue;
      assertAuthority();
      const combatant = Array.from(combat.combatants ?? []).find(
        (entry) => entry.id === event.combatantId,
      );
      const actor =
        combatant?.actor &&
        (combatant.actor.uuid ?? combatant.actor.id) === event.actorUuid
          ? combatant.actor
          : await globalThis.fromUuid?.(event.actorUuid);
      if (!actor) throw Error("BleedingActorUnavailable");
      const receiptKey = `${combat.id}_${event.id}`;
      const existing =
        actor.flags?.[MODULE]?.bleedingDamageReceipts?.[receiptKey];
      if (event.after && persistedValuesEqual(existing, event.after)) {
        // The atomic receipt proves this damage already happened, even if HP changed later.
        event.state = "completed";
        await save(combat, state);
        continue;
      }
      const effect = getActorCriticalInjuryEffects(actor).find(
        (entry) =>
          entry.id === event.effectId &&
          getCriticalInjuryData(entry)?.id === event.injuryId &&
          getCriticalInjuryData(entry)?.injuryKey === "internal-bleeding",
      );
      if (!active(effect)) {
        event.state = "skipped";
        await save(combat, state);
        continue;
      }
      if (event.check == null) {
        const result = await roll("1d6");
        assertAuthority();
        const value = Number(result?.total);
        if (!Number.isInteger(value) || value < 1 || value > 6)
          throw Error("BleedingInvalidCheck");
        event.check = value;
        await save(combat, state);
      }
      if (event.check !== 1) {
        event.state = "completed";
        await save(combat, state);
        continue;
      }
      if (event.damage == null) {
        const result = await roll("1d4");
        assertAuthority();
        const value = Number(result?.total);
        if (!Number.isInteger(value) || value < 1 || value > 4)
          throw Error("BleedingInvalidDamage");
        event.damage = value;
        await save(combat, state);
      }
      if (!event.after) {
        event.before = hpSnapshot(actor);
        event.after = bleedingDamageAfter(event.before, event.damage);
        await save(combat, state);
      }
      assertAuthority();
      if (
        !active(
          getActorCriticalInjuryEffects(actor).find(
            (entry) =>
              entry.id === event.effectId &&
              getCriticalInjuryData(entry)?.id === event.injuryId,
          ),
        )
      ) {
        event.state = "skipped";
        await save(combat, state);
        continue;
      }
      if (!persistedValuesEqual(hpSnapshot(actor), event.before))
        throw Error("BleedingHitPointConflict");
      // HP and receipt are one document update, so a lost reply cannot repeat damage.
      try {
        await actor.update(
          {
            "system.attributes.hp.value": event.after.value,
            "system.attributes.hp.temp": event.after.temp,
            [`flags.${MODULE}.bleedingDamageReceipts.${receiptKey}`]:
              event.after,
          },
          { [`${MODULE}.criticalInjuryDamage`]: true },
        );
      } catch (error) {
        if (
          !persistedValuesEqual(
            actor.flags?.[MODULE]?.bleedingDamageReceipts?.[receiptKey],
            event.after,
          )
        )
          throw error;
      }
      assertAuthority();
      if (
        !persistedValuesEqual(
          actor.flags?.[MODULE]?.bleedingDamageReceipts?.[receiptKey],
          event.after,
        )
      )
        throw Error("BleedingDamageWriteUnverified");
      event.state = "completed";
      await save(combat, state);
    }
    for (const event of state.events) {
      if (
        event.state !== "completed" ||
        event.chatDone ||
        typeof globalThis.ChatMessage?.create !== "function"
      )
        continue;
      if (!event.chatId) {
        event.chatId =
          globalThis.foundry?.utils?.randomID?.() ??
          globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 16);
        await save(combat, state);
      }
      const existing = game.messages?.get?.(event.chatId);
      if (existing) {
        if (
          existing.flags?.[MODULE]?.bleedingEvent !== `${combat.id}:${event.id}`
        )
          throw Error("BleedingChatConflict");
        event.chatDone = true;
        await save(combat, state);
        continue;
      }
      const escape = (value) =>
        String(value ?? "").replace(
          /[&<>"']/g,
          (char) =>
            ({
              "&": "&amp;",
              "<": "&lt;",
              ">": "&gt;",
              '"': "&quot;",
              "'": "&#39;",
            })[char],
        );
      const outcome = event.damage
        ? `${event.damage} damage; ${event.before.temp - event.after.temp} absorbed by temporary HP.`
        : "No damage.";
      assertAuthority();
      try {
        await ChatMessage.create(
          {
            _id: event.chatId,
            content: `<p><strong>${escape(event.actorName)}: Internal Bleeding</strong> — d6: ${event.check}. ${outcome}</p>`,
            flags: { [MODULE]: { bleedingEvent: `${combat.id}:${event.id}` } },
          },
          { keepId: true },
        );
      } catch (error) {
        if (
          game.messages?.get?.(event.chatId)?.flags?.[MODULE]?.bleedingEvent !==
          `${combat.id}:${event.id}`
        )
          throw error;
      }
      event.chatDone = true;
      await save(combat, state);
    }
  } finally {
    try {
      if (
        leaseId &&
        isAuthoritativeGM() &&
        read(combat)?.lease?.id === leaseId
      ) {
        const current = read(combat);
        await writeCriticalInjuryBleeding(
          combat.id,
          { ...current, lease: null },
          current,
        );
      }
    } finally {
      inFlight.delete(combat.id);
    }
  }
}
