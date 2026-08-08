/**
 * Authoritative Critical Injury workflow.
 *
 * The active GM detects a PC recovering from 0 HP/dead, approves the table
 * roll, validates the owning player's d100 result, and owns every Actor,
 * ActiveEffect, inventory, and calendar mutation.
 */

import { SETTING_KEYS, getSetting } from "../settings.js";
import { isFullGM } from "../permissions.js";
import { isAuthoritativeGM, authoritativeGMId } from "../socket-authority.js";
import {
  CRITICAL_INJURY_EVENTS,
  emitCriticalInjuryEvent,
  subscribeCriticalInjury,
} from "./socket.js";
import {
  buildCriticalInjuryEffectText,
  findCriticalInjuryByRoll,
  getCriticalInjuryDefinition,
  getCriticalInjuryRecoveryFormula,
  resolveCriticalInjuryDetail,
  treatmentSkillLabel,
} from "./table.js";
import {
  buildCriticalInjuryEffectData,
  createCriticalInjuryEffect,
  effectiveRecoveryCalendarDays,
  findActorCriticalInjuryEffect,
  generateCriticalInjuryId,
  getActorCriticalInjuryEffects,
  getCriticalInjuryData,
  updateCriticalInjuryEffect,
} from "./effects.js";
import {
  buildHealersKitConsumptionPlan,
  consumeHealersKitPlan,
} from "./healers-kit.js";
import {
  addInjuryCalendarDays,
  formatInjuryTimestamp,
  getCurrentInjuryTimestamp,
  getRemainingInjuryCalendarDays,
  removeCriticalInjuryNote,
  scheduleCriticalInjuryNote,
} from "./calendar.js";

const MODULE_ID = "infinity-dnd5e";
const PENDING_FLAG = "criticalInjuryPending";
const RECOVERY_DEDUPE_MS = 2500;
const REST_DEDUPE_MS = 3000;

let registered = false;
const promptInFlight = new Set();
const rollInFlight = new Set();
const treatmentInFlight = new Set();
const recentRecovery = new Map();
const recentRest = new Map();
const processedCombats = new Set();

export function registerCriticalInjuryService() {
  if (registered) return true;
  registered = true;

  subscribeCriticalInjury(CRITICAL_INJURY_EVENTS.ROLL_REQUEST, (payload) => {
    void handleCriticalInjuryRollRequest(payload);
  });
  subscribeCriticalInjury(
    CRITICAL_INJURY_EVENTS.TREATMENT_REQUEST,
    (payload) => void handleCriticalInjuryTreatmentRequest(payload),
  );
  subscribeCriticalInjury(
    CRITICAL_INJURY_EVENTS.REST_COMPLETED,
    (payload) => void handleInfectionRest(payload),
  );

  const hooks = globalThis.Hooks;
  if (typeof hooks?.on !== "function") return true;
  hooks.on("preUpdateActor", onPreUpdateActor);
  hooks.on("updateActor", onUpdateActor);
  hooks.on("deleteActiveEffect", onDeleteActiveEffect);
  hooks.on("updateActiveEffect", onUpdateActiveEffect);
  hooks.on("updateCombatant", onUpdateCombatant);
  hooks.on("combatStart", (combat) => void processCombatStartInjuries(combat));
  hooks.on("deleteCombat", (combat) =>
    processedCombats.delete(String(combat?.id)),
  );
  hooks.on("updateWorldTime", () => void processExpiredCriticalInjuries());
  const calendarHook = globalThis.SimpleCalendar?.Hooks?.DateTimeChange;
  if (calendarHook) {
    hooks.on(calendarHook, () => void processExpiredCriticalInjuries());
  }
  void processExpiredCriticalInjuries();
  return true;
}

export function getActorPendingCriticalInjuries(actor) {
  const raw =
    actor?.getFlag?.(MODULE_ID, PENDING_FLAG) ??
    actor?.flags?.[MODULE_ID]?.[PENDING_FLAG] ??
    [];
  return Array.isArray(raw)
    ? raw.filter(
        (entry) =>
          entry && typeof entry === "object" && String(entry.id ?? "").trim(),
      )
    : [];
}

/** Pure recovery transition detector used by the Foundry hook and tests. */
export function detectHitPointRecovery(actor, changes) {
  const found = readChangedHitPoints(changes);
  if (!found.present) return null;
  const previousHp = Number(actor?.system?.attributes?.hp?.value);
  const nextHp = Number(found.value);
  if (!Number.isFinite(previousHp) || !Number.isFinite(nextHp)) return null;
  if (previousHp > 0 || nextHp <= 0) return null;
  return {
    previousHp,
    nextHp,
    wasDead: actorHasDeadState(actor),
    cause: actorHasDeadState(actor) ? "dead-state" : "zero-hit-points",
  };
}

function onPreUpdateActor(actor, changes, options = {}) {
  if (!criticalInjuriesEnabled() || !isAuthoritativeGM()) return;
  const recovery = detectHitPointRecovery(actor, changes);
  if (!recovery) return;
  options[`${MODULE_ID}.criticalInjuryRecovery`] = recovery;
}

function onUpdateActor(actor, _changes, options = {}) {
  if (!criticalInjuriesEnabled() || !isAuthoritativeGM()) return;
  const recovery = options?.[`${MODULE_ID}.criticalInjuryRecovery`];
  if (recovery) void considerRecoveryForInjury(actor, recovery);
}

function onDeleteActiveEffect(effect) {
  if (!isAuthoritativeGM()) return;
  const actor = effect?.parent;
  const injury = getCriticalInjuryData(effect);
  if (injury?.calendarEntryId) {
    void removeCriticalInjuryNote(injury.calendarEntryId);
  }
  if (
    criticalInjuriesEnabled() &&
    actor?.system?.attributes?.hp?.value > 0 &&
    effectIsDeadState(effect)
  ) {
    void considerRecoveryForInjury(actor, {
      previousHp: 0,
      nextHp: Number(actor.system.attributes.hp.value),
      wasDead: true,
      cause: "dead-state-removed",
    });
  }
}

function onUpdateActiveEffect(effect, changes) {
  if (!criticalInjuriesEnabled() || !isAuthoritativeGM()) return;
  if (
    changes?.disabled === true &&
    effect?.parent?.system?.attributes?.hp?.value > 0 &&
    effectIsDeadState(effect)
  ) {
    void considerRecoveryForInjury(effect.parent, {
      previousHp: 0,
      nextHp: Number(effect.parent.system.attributes.hp.value),
      wasDead: true,
      cause: "dead-state-disabled",
    });
  }
}

function onUpdateCombatant(combatant, changes) {
  if (!criticalInjuriesEnabled() || !isAuthoritativeGM()) return;
  if (
    changes?.defeated === false &&
    combatant?.actor?.system?.attributes?.hp?.value > 0
  ) {
    void considerRecoveryForInjury(combatant.actor, {
      previousHp: 0,
      nextHp: Number(combatant.actor.system.attributes.hp.value),
      wasDead: true,
      cause: "defeated-state-removed",
    });
  }
}

async function considerRecoveryForInjury(actor, recovery) {
  if (!isEligiblePlayerCharacter(actor)) return false;
  const actorId = String(actor.id ?? "");
  const now = Date.now();
  if (
    promptInFlight.has(actorId) ||
    now - Number(recentRecovery.get(actorId) ?? 0) < RECOVERY_DEDUPE_MS
  ) {
    return false;
  }
  promptInFlight.add(actorId);
  try {
    const approved = await requestGmInjuryApproval(actor, recovery);
    recentRecovery.set(actorId, Date.now());
    if (!approved || !isAuthoritativeGM()) return false;

    const targetUserId =
      resolveInjuryRollerUserId(actor) ?? authoritativeGMId() ?? game.user?.id;
    if (!targetUserId) return false;
    const pending = {
      id: generatePendingId(),
      actorId,
      actorName: String(actor.name ?? "Character"),
      targetUserId,
      createdAt: Date.now(),
      approvedBy: String(game.user?.id ?? ""),
      cause: String(recovery?.cause ?? "recovery"),
      previousHp: Number(recovery?.previousHp ?? 0),
      nextHp: Number(recovery?.nextHp ?? 1),
    };
    await appendPendingInjury(actor, pending);
    emitCriticalInjuryEvent(CRITICAL_INJURY_EVENTS.PROMPT, {
      actorId,
      pendingId: pending.id,
      targetUserId,
      actorName: pending.actorName,
      rollFormula: "1d100",
    });
    if (targetUserId === game.user?.id) {
      ui.notifications?.info?.(
        `${actor.name} has no available player owner; the GM can roll the critical injury.`,
      );
    }
    return true;
  } catch (error) {
    console.error(
      `${MODULE_ID} | critical injury recovery prompt failed`,
      error,
    );
    return false;
  } finally {
    promptInFlight.delete(actorId);
  }
}

async function handleCriticalInjuryRollRequest(payload) {
  if (!isAuthoritativeGM() || !criticalInjuriesEnabled()) return;
  const pendingId = String(payload?.pendingId ?? "");
  if (!pendingId || rollInFlight.has(pendingId)) return;
  rollInFlight.add(pendingId);
  try {
    const actor = game.actors?.get?.(payload.actorId);
    if (!actor || !userCanOperateActor(actor, payload.originUserId)) return;
    const pending = getActorPendingCriticalInjuries(actor).find(
      (entry) => entry.id === pendingId,
    );
    if (!pending) return;
    if (
      !isFullGM(game.users?.get?.(payload.originUserId)) &&
      String(pending.targetUserId) !== String(payload.originUserId)
    ) {
      return;
    }

    let effect = getActorCriticalInjuryEffects(actor).find(
      (candidate) =>
        String(getCriticalInjuryData(candidate)?.pendingId ?? "") === pendingId,
    );
    let injury = effect ? { ...getCriticalInjuryData(effect) } : null;
    const now = getCurrentInjuryTimestamp();

    // A verified Actor effect is the idempotency marker. If an earlier pass
    // applied the injury but failed while clearing the pending flag, reuse the
    // exact result instead of rerolling duration or creating a duplicate.
    if (!injury) {
      const definition = findCriticalInjuryByRoll(payload.rollTotal);
      const recoveryFormula = getCriticalInjuryRecoveryFormula(definition);
      const recoveryDays = definition.permanent
        ? 0
        : await evaluateFormulaTotal(recoveryFormula);
      const detailTotal = definition.detailRoll
        ? await evaluateFormulaTotal(definition.detailRoll.formula)
        : null;
      const detail =
        detailTotal == null
          ? null
          : resolveCriticalInjuryDetail(definition, detailTotal);
      injury = {
        id: generateCriticalInjuryId(),
        pendingId,
        actorId: actor.id,
        injuryKey: definition.key,
        injuryName: definition.label,
        injuryRoll: Number(payload.rollTotal),
        effect: buildCriticalInjuryEffectText(definition, detail),
        recoveryRule: definition.recovery,
        recoveryFormula,
        remainingDays: recoveryDays,
        permanent: Boolean(definition.permanent),
        stabilized: false,
        kitCharges: Math.max(0, Number(definition.kitCharges ?? 0)),
        treatmentDc: Math.max(0, Number(definition.treatmentDc ?? 0)),
        treatmentSkill: String(definition.treatmentSkill ?? ""),
        canBecomePermanent: Boolean(definition.canBecomePermanent),
        downgradeTo: String(definition.downgradeTo ?? ""),
        downgradeHalfDays: Boolean(definition.downgradeHalfDays),
        detail,
        infectionHpLoss: 0,
        createdAt: Date.now(),
        createdBy: String(payload.originUserId ?? ""),
        recoveryDueTs: definition.permanent
          ? null
          : addInjuryCalendarDays(now, recoveryDays),
        calendarEntryId: "",
      };

      effect = await createCriticalInjuryEffect(actor, injury, {
        startTime: now,
        dueTimestamp: injury.recoveryDueTs,
      });
    }

    let calendar = {
      scheduled: Boolean(injury.calendarEntryId),
      entryId: String(injury.calendarEntryId ?? ""),
    };
    if (!calendar.entryId) {
      calendar = await scheduleCriticalInjuryNote({ actor, injury });
      if (calendar.entryId) {
        injury.calendarEntryId = calendar.entryId;
        try {
          effect = await updateCriticalInjuryEffect(effect, injury, {
            startTime: now,
            dueTimestamp: injury.recoveryDueTs,
          });
        } catch (error) {
          await removeCriticalInjuryNote(calendar.entryId);
          injury.calendarEntryId = "";
          throw error;
        }
      }
    }
    await removePendingInjury(actor, pendingId);

    const result = sanitizeInjuryForClient(injury, {
      calendarScheduled: calendar.scheduled,
      automatedChanges:
        effect?.changes?.length ??
        buildCriticalInjuryEffectData(injury).changes.length,
    });
    emitCriticalInjuryEvent(CRITICAL_INJURY_EVENTS.RESULT, {
      actorId: actor.id,
      pendingId,
      targetUserId: pending.targetUserId,
      result,
    });
    void postCriticalInjuryChat(actor, injury, pending.targetUserId).catch(
      (error) =>
        console.warn(`${MODULE_ID} | critical injury chat failed`, error),
    );
  } catch (error) {
    console.error(`${MODULE_ID} | could not apply critical injury`, error);
    ui.notifications?.error?.(
      `${MODULE_ID}: The critical injury could not be applied. The roll remains pending.`,
    );
  } finally {
    rollInFlight.delete(pendingId);
  }
}

async function handleCriticalInjuryTreatmentRequest(payload) {
  if (!isAuthoritativeGM() || !criticalInjuriesEnabled()) return;
  const key = `${payload.actorId}:${payload.injuryId}`;
  if (treatmentInFlight.has(key)) return;
  treatmentInFlight.add(key);
  let consumedCharges = 0;
  try {
    const actor = game.actors?.get?.(payload.actorId);
    if (!actor || !userCanOperateActor(actor, payload.originUserId)) return;
    const effect = findActorCriticalInjuryEffect(actor, payload.injuryId);
    const initial = getCriticalInjuryData(effect);
    if (!effect || !initial) return;
    if (
      initial.permanent ||
      initial.stabilized ||
      Number(initial.kitCharges) <= 0
    ) {
      sendTreatmentResult(payload, actor, false, {
        message: initial.stabilized
          ? "This injury has already been treated."
          : "This injury cannot be treated with a Healer's Kit.",
      });
      return;
    }
    const treatmentNow = getCurrentInjuryTimestamp();
    if (
      Number.isFinite(Number(initial.recoveryDueTs)) &&
      Number(initial.recoveryDueTs) <= treatmentNow
    ) {
      await processExpiredCriticalInjuries();
      sendTreatmentResult(payload, actor, false, {
        message:
          "This injury's recovery deadline has passed. Its healed or permanent state was resolved before treatment.",
      });
      return;
    }

    const partyActors = listPlayerCharacters();
    const previewPlan = buildHealersKitConsumptionPlan({
      actors: partyActors,
      preferredActorIds: [actor.id],
      requiredCharges: initial.kitCharges,
    });
    if (!previewPlan.ok) {
      sendTreatmentResult(payload, actor, false, {
        message: `The party is short ${previewPlan.missing} Healer's Kit charge(s).`,
      });
      return;
    }

    const healer = await promptGmForTreatmentHealer({
      actor,
      injury: initial,
      actors: partyActors,
      plan: previewPlan,
    });
    if (!healer) {
      sendTreatmentResult(payload, actor, false, {
        message: "The GM declined or cancelled the treatment.",
      });
      return;
    }

    const plan = buildHealersKitConsumptionPlan({
      actors: partyActors,
      preferredActorIds: [actor.id, healer.id],
      requiredCharges: initial.kitCharges,
    });
    const consumed = await consumeHealersKitPlan(plan);
    consumedCharges = Math.max(0, Number(consumed.consumed ?? 0));
    if (!consumed.ok) {
      sendTreatmentResult(payload, actor, false, {
        message:
          consumed.consumed > 0
            ? `Only ${consumed.consumed} charge(s) could be verified as consumed.`
            : "Healer's Kit charges changed before treatment could begin.",
      });
      return;
    }

    const check = await rollTreatmentCheck({ actor, healer, injury: initial });
    let injury = { ...initial };
    const now = getCurrentInjuryTimestamp();
    if (!check.passed) {
      if (injury.injuryKey === "nerve-damage" && injury.canBecomePermanent) {
        injury.permanent = true;
        injury.recoveryDueTs = null;
        await updateCriticalInjuryEffect(effect, injury, {
          startTime: now,
          dueTimestamp: null,
        });
        const calendar = await scheduleCriticalInjuryNote({
          actor,
          injury,
          existingEntryId: injury.calendarEntryId,
        });
        if (calendar.entryId) {
          injury.calendarEntryId = calendar.entryId;
          await updateCriticalInjuryEffect(effect, injury, {
            startTime: now,
            dueTimestamp: null,
          });
        }
      }
      const message = `Treatment failed after consuming ${consumed.consumed} Healer's Kit charge(s).`;
      sendTreatmentResult(payload, actor, false, {
        message,
        rollTotal: check.total,
        dc: initial.treatmentDc,
        consumed: consumed.consumed,
      });
      await postTreatmentChat(actor, injury, message, payload.originUserId);
      return;
    }

    injury.stabilized = true;
    const elapsedRemaining = getRemainingInjuryCalendarDays(
      injury.recoveryDueTs,
      now,
    );
    if (Number.isFinite(elapsedRemaining)) {
      injury.remainingDays = Math.max(
        1,
        Math.min(
          Math.max(1, Number(injury.remainingDays) || 1),
          elapsedRemaining,
        ),
      );
    }
    if (injury.injuryKey === "broken-arm" && injury.downgradeTo) {
      const next = getCriticalInjuryDefinition(injury.downgradeTo);
      if (next) {
        injury.injuryKey = next.key;
        injury.injuryName = next.label;
        injury.effect = buildCriticalInjuryEffectText(next, {
          type: "body-part",
          key: "injured-arm",
          label: "Injured arm",
          kind: "arm",
        });
        injury.detail = {
          type: "body-part",
          key: "injured-arm",
          label: "Injured arm",
          kind: "arm",
        };
        injury.recoveryRule = next.recovery;
        injury.kitCharges = Number(next.kitCharges ?? 0);
        injury.treatmentDc = Number(next.treatmentDc ?? 0);
        injury.treatmentSkill = String(next.treatmentSkill ?? "");
      }
      injury.remainingDays = Math.max(
        1,
        Math.ceil(Number(injury.remainingDays ?? 0) / 2),
      );
    }
    const calendarDays = effectiveRecoveryCalendarDays(injury);
    injury.recoveryDueTs = addInjuryCalendarDays(now, calendarDays);
    await updateCriticalInjuryEffect(effect, injury, {
      startTime: now,
      dueTimestamp: injury.recoveryDueTs,
    });
    const calendar = await scheduleCriticalInjuryNote({
      actor,
      injury,
      existingEntryId: injury.calendarEntryId,
    });
    if (calendar.entryId) {
      injury.calendarEntryId = calendar.entryId;
      await updateCriticalInjuryEffect(effect, injury, {
        startTime: now,
        dueTimestamp: injury.recoveryDueTs,
      });
    }

    const message = `Treatment succeeded. ${consumed.consumed} Healer's Kit charge(s) consumed; recovery is due ${formatInjuryTimestamp(injury.recoveryDueTs)}.`;
    sendTreatmentResult(payload, actor, true, {
      message,
      rollTotal: check.total,
      dc: initial.treatmentDc,
      consumed: consumed.consumed,
      result: sanitizeInjuryForClient(injury, {
        calendarScheduled: calendar.scheduled,
      }),
    });
    await postTreatmentChat(actor, injury, message, payload.originUserId);
  } catch (error) {
    console.error(`${MODULE_ID} | critical injury treatment failed`, error);
    const actor = game.actors?.get?.(payload.actorId);
    if (actor) {
      sendTreatmentResult(payload, actor, false, {
        message:
          consumedCharges > 0
            ? `Treatment could not be completed after ${consumedCharges} Healer's Kit charge(s) were consumed. The GM should review the injury and kit inventory.`
            : "Treatment could not be completed. No injury or kit change was applied.",
      });
    }
  } finally {
    treatmentInFlight.delete(key);
  }
}

async function handleInfectionRest(payload) {
  if (!isAuthoritativeGM() || !payload?.longRest) return;
  const actor = game.actors?.get?.(payload.actorId);
  if (!actor || !userCanOperateActor(actor, payload.originUserId)) return;
  const now = Date.now();
  if (now - Number(recentRest.get(actor.id) ?? 0) < REST_DEDUPE_MS) return;
  recentRest.set(actor.id, now);

  const infections = getActorCriticalInjuryEffects(actor).filter(
    (effect) => getCriticalInjuryData(effect)?.injuryKey === "infection",
  );
  for (const effect of infections) {
    const injury = { ...getCriticalInjuryData(effect) };
    const roll = await rollAbilitySave(actor, "con", {
      flavor: `${actor.name}: Infection — DC 15 Constitution`,
    });
    if (Number(roll?.total) >= 15) continue;
    injury.infectionHpLoss = Math.max(
      0,
      Number(injury.infectionHpLoss ?? 0) + 1,
    );
    await updateCriticalInjuryEffect(effect, injury, {
      startTime: getCurrentInjuryTimestamp(),
      dueTimestamp: injury.recoveryDueTs,
    });
    await postTreatmentChat(
      actor,
      injury,
      `The infection worsened after the long rest: maximum HP is reduced by ${injury.infectionHpLoss}.`,
      payload.originUserId,
    );
  }
}

export async function processExpiredCriticalInjuries() {
  if (!isAuthoritativeGM() || !criticalInjuriesEnabled()) return 0;
  const now = getCurrentInjuryTimestamp();
  let processed = 0;
  for (const actor of game.actors?.contents ?? []) {
    for (const effect of getActorCriticalInjuryEffects(actor)) {
      const injury = { ...getCriticalInjuryData(effect) };
      const due = Number(injury.recoveryDueTs);
      if (injury.permanent || !Number.isFinite(due) || due > now) continue;
      processed += 1;
      if (injury.canBecomePermanent && !injury.stabilized) {
        injury.permanent = true;
        injury.recoveryDueTs = null;
        await updateCriticalInjuryEffect(effect, injury, {
          startTime: now,
          dueTimestamp: null,
        });
        const calendar = await scheduleCriticalInjuryNote({
          actor,
          injury,
          existingEntryId: injury.calendarEntryId,
        });
        if (calendar.entryId) {
          injury.calendarEntryId = calendar.entryId;
          await updateCriticalInjuryEffect(effect, injury, {
            startTime: now,
            dueTimestamp: null,
          });
        }
        await postTreatmentChat(
          actor,
          injury,
          `${injury.injuryName} became permanent because it was not stabilized before the recovery deadline.`,
          null,
        );
        continue;
      }
      if (injury.calendarEntryId) {
        await removeCriticalInjuryNote(injury.calendarEntryId);
      }
      await effect.delete();
      await postTreatmentChat(
        actor,
        injury,
        `${injury.injuryName} has healed and its automated penalties were removed.`,
        null,
      );
    }
  }
  return processed;
}

async function processCombatStartInjuries(combat) {
  if (!isAuthoritativeGM() || !criticalInjuriesEnabled()) return;
  const combatId = String(combat?.id ?? "");
  if (!combatId || processedCombats.has(combatId)) return;
  processedCombats.add(combatId);
  const actorIds = new Set(
    Array.from(combat?.combatants ?? [])
      .map((combatant) => String(combatant?.actor?.id ?? ""))
      .filter(Boolean),
  );
  for (const actorId of actorIds) {
    const actor = game.actors?.get?.(actorId);
    if (!actor) continue;
    const bleeding = getActorCriticalInjuryEffects(actor).filter(
      (effect) =>
        getCriticalInjuryData(effect)?.injuryKey === "internal-bleeding",
    );
    for (const effect of bleeding) {
      const check = await evaluateFormula("1d6", {
        flavor: `${actor.name}: Internal Bleeding`,
        speaker: actor,
        chatMessage: true,
      });
      if (Number(check.total) !== 1) continue;
      const damage = await evaluateFormula("1d4", {
        flavor: `${actor.name}: Internal Bleeding damage`,
        speaker: actor,
        chatMessage: true,
      });
      const currentHp = Number(actor.system?.attributes?.hp?.value) || 0;
      await actor.update(
        {
          "system.attributes.hp.value": Math.max(
            0,
            currentHp - Math.max(0, Number(damage.total) || 0),
          ),
        },
        { [`${MODULE_ID}.criticalInjuryDamage`]: true },
      );
    }
  }
}

async function requestGmInjuryApproval(actor, recovery) {
  const DialogV2 = globalThis.foundry?.applications?.api?.DialogV2;
  const stateLabel = recovery?.wasDead ? "the dead state" : "0 hit points";
  const content = `
    <div class="infinity-dnd5e">
      <p><strong>${escapeHtml(actor.name)}</strong> recovered from ${escapeHtml(stateLabel)} (${Number(recovery?.previousHp ?? 0)} → ${Number(recovery?.nextHp ?? 1)} HP).</p>
      <p>Ask the owning player to roll on Critical Injury Table V2?</p>
    </div>`;
  if (typeof DialogV2?.confirm !== "function") {
    ui.notifications?.warn?.(
      `${MODULE_ID}: ${actor.name} recovered; DialogV2 is unavailable, so no injury roll was queued.`,
    );
    return false;
  }
  return await DialogV2.confirm({
    window: {
      title: "Critical Injury?",
      icon: "fa-solid fa-heart-crack",
    },
    content,
    yes: { label: "Yes — ask for roll", icon: "fa-solid fa-dice-d20" },
    no: { label: "No injury", icon: "fa-solid fa-xmark" },
    rejectClose: false,
  }).catch(() => false);
}

async function promptGmForTreatmentHealer({ actor, injury, actors, plan }) {
  const DialogV2 = globalThis.foundry?.applications?.api?.DialogV2;
  if (typeof DialogV2?.prompt !== "function") return null;
  const options = actors
    .map(
      (candidate) =>
        `<option value="${escapeHtml(candidate.id)}">${escapeHtml(candidate.name)}</option>`,
    )
    .join("");
  const sources = plan.steps
    .map(
      (step) =>
        `${escapeHtml(step.actorName)} — ${escapeHtml(step.itemName)} (-${step.spend})`,
    )
    .join("<br>");
  const check = injury.treatmentDc
    ? `DC ${injury.treatmentDc} ${treatmentSkillLabel(injury.treatmentSkill)}`
    : "No treatment check";
  try {
    const healerId = await DialogV2.prompt({
      window: {
        title: `Treat ${actor.name}'s ${injury.injuryName}`,
        icon: "fa-solid fa-kit-medical",
      },
      content: `
        <div class="infinity-dnd5e">
          <p>This treatment consumes <strong>${injury.kitCharges}</strong> Healer's Kit charge(s), even if the check fails.</p>
          <p>${sources}</p>
          <p><strong>${escapeHtml(check)}</strong></p>
          <label style="display:grid;gap:4px;"><span>Healer</span><select name="healerId">${options}</select></label>
        </div>`,
      ok: {
        label: "Treat injury",
        icon: "fa-solid fa-kit-medical",
        callback: (_event, button) =>
          button?.form?.elements?.healerId?.value ?? null,
      },
      rejectClose: false,
    });
    return actors.find((candidate) => candidate.id === healerId) ?? null;
  } catch {
    return null;
  }
}

async function rollTreatmentCheck({ actor, healer, injury }) {
  const dc = Math.max(0, Number(injury?.treatmentDc ?? 0));
  const skill = String(injury?.treatmentSkill ?? "");
  if (!dc || !skill) return { passed: true, total: null };
  const roll =
    skill === "con"
      ? await rollAbilitySave(actor, "con", {
          flavor: `${actor.name}: Nerve Damage treatment — DC ${dc}`,
        })
      : await rollSkill(healer, skill === "ins" ? "ins" : "med", {
          flavor: `${healer.name}: Treat ${actor.name}'s ${injury.injuryName} — DC ${dc}`,
        });
  const total = Number(roll?.total);
  return { passed: Number.isFinite(total) && total >= dc, total };
}

async function rollSkill(actor, skillId, { flavor = "" } = {}) {
  if (typeof actor?.rollSkill !== "function") return { total: 0 };
  return await actor.rollSkill(skillId, {
    fastForward: true,
    chatMessage: true,
    flavor,
  });
}

async function rollAbilitySave(actor, abilityId, { flavor = "" } = {}) {
  if (typeof actor?.rollAbilitySave === "function") {
    return await actor.rollAbilitySave(abilityId, {
      fastForward: true,
      chatMessage: true,
      flavor,
    });
  }
  if (typeof actor?.rollSavingThrow === "function") {
    return await actor.rollSavingThrow({ ability: abilityId, flavor });
  }
  return { total: 0 };
}

async function appendPendingInjury(actor, pending) {
  const queue = [...getActorPendingCriticalInjuries(actor), pending].slice(-10);
  await actor.setFlag(MODULE_ID, PENDING_FLAG, queue);
}

async function removePendingInjury(actor, pendingId) {
  const queue = getActorPendingCriticalInjuries(actor).filter(
    (entry) => entry.id !== pendingId,
  );
  if (queue.length > 0) await actor.setFlag(MODULE_ID, PENDING_FLAG, queue);
  else await actor.unsetFlag(MODULE_ID, PENDING_FLAG);
}

function sendTreatmentResult(payload, actor, success, details) {
  emitCriticalInjuryEvent(CRITICAL_INJURY_EVENTS.TREATMENT_RESULT, {
    actorId: actor.id,
    injuryId: payload.injuryId,
    targetUserId: payload.originUserId,
    success,
    ...details,
  });
}

async function postCriticalInjuryChat(actor, injury, ownerUserId) {
  if (typeof globalThis.ChatMessage?.create !== "function") return;
  const detail = injury.detail?.label
    ? `<li><strong>Detail:</strong> ${escapeHtml(injury.detail.label)}</li>`
    : "";
  const recovery = injury.permanent
    ? "Permanent"
    : `${injury.remainingDays} day(s), due ${escapeHtml(formatInjuryTimestamp(injury.recoveryDueTs))}`;
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker?.({ actor, alias: "Critical Injuries" }),
    whisper: whisperRecipients(ownerUserId),
    content: `
      <div class="infinity-dnd5e critical-injury-chat">
        <h3>${escapeHtml(actor.name)} — ${escapeHtml(injury.injuryName)}</h3>
        <p><strong>d100 ${injury.injuryRoll}</strong></p>
        <ul>${detail}<li>${escapeHtml(injury.effect)}</li><li><strong>Recovery:</strong> ${recovery}</li><li><strong>Treatment:</strong> ${escapeHtml(injury.recoveryRule)}</li></ul>
      </div>`,
  });
}

async function postTreatmentChat(actor, injury, message, ownerUserId) {
  if (typeof globalThis.ChatMessage?.create !== "function") return;
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker?.({ actor, alias: "Critical Injuries" }),
    whisper: whisperRecipients(ownerUserId),
    content: `<div class="infinity-dnd5e critical-injury-chat"><h3>${escapeHtml(actor.name)} — ${escapeHtml(injury.injuryName)}</h3><p>${escapeHtml(message)}</p></div>`,
  });
}

function whisperRecipients(ownerUserId) {
  const ids = new Set();
  if (ownerUserId) ids.add(String(ownerUserId));
  for (const user of game.users?.contents ?? []) {
    if (isFullGM(user)) ids.add(String(user.id));
  }
  return [...ids];
}

function sanitizeInjuryForClient(injury, extras = {}) {
  return {
    id: injury.id,
    injuryKey: injury.injuryKey,
    injuryName: injury.injuryName,
    injuryRoll: injury.injuryRoll,
    effect: injury.effect,
    recoveryRule: injury.recoveryRule,
    recoveryFormula: injury.recoveryFormula,
    remainingDays: injury.remainingDays,
    permanent: injury.permanent,
    stabilized: injury.stabilized,
    kitCharges: injury.kitCharges,
    treatmentDc: injury.treatmentDc,
    treatmentSkill: injury.treatmentSkill,
    detail: injury.detail,
    recoveryDueTs: injury.recoveryDueTs,
    ...extras,
  };
}

function criticalInjuriesEnabled() {
  return getSetting(SETTING_KEYS.CRITICAL_INJURIES_ENABLED) !== false;
}

function readChangedHitPoints(changes) {
  if (
    changes &&
    Object.prototype.hasOwnProperty.call(changes, "system.attributes.hp.value")
  ) {
    return { present: true, value: changes["system.attributes.hp.value"] };
  }
  if (
    changes?.system?.attributes?.hp &&
    Object.prototype.hasOwnProperty.call(changes.system.attributes.hp, "value")
  ) {
    return { present: true, value: changes.system.attributes.hp.value };
  }
  return { present: false, value: null };
}

function actorHasDeadState(actor) {
  const statuses = actor?.statuses;
  if (statuses?.has?.("dead") || statuses?.has?.("unconscious")) return true;
  return Array.from(actor?.effects?.contents ?? actor?.effects ?? []).some(
    (effect) => effectIsDeadState(effect),
  );
}

function effectIsDeadState(effect) {
  const statuses = Array.from(effect?.statuses ?? []).map((entry) =>
    String(entry).toLowerCase(),
  );
  const name = String(effect?.name ?? "")
    .trim()
    .toLowerCase();
  return (
    statuses.includes("dead") ||
    statuses.includes("unconscious") ||
    name === "dead" ||
    name === "unconscious"
  );
}

function isEligiblePlayerCharacter(actor) {
  return actor?.type === "character" && listActorOwners(actor).length > 0;
}

function listPlayerCharacters() {
  return (game.actors?.contents ?? [])
    .filter((actor) => isEligiblePlayerCharacter(actor))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function listActorOwners(actor) {
  const users = game.users?.contents ?? [];
  return users.filter((user) => {
    if (!user || isFullGM(user)) return false;
    const characterId =
      typeof user.character === "string"
        ? user.character
        : String(user.character?.id ?? "");
    return characterId === actor.id || hasDirectOwnerPermission(actor, user.id);
  });
}

function resolveInjuryRollerUserId(actor) {
  const owners = listActorOwners(actor);
  const assigned = owners.find((user) => {
    const characterId =
      typeof user.character === "string" ? user.character : user.character?.id;
    return user.active && characterId === actor.id;
  });
  return (
    assigned?.id ??
    owners.find((user) => user.active)?.id ??
    owners.find((user) => {
      const characterId =
        typeof user.character === "string"
          ? user.character
          : user.character?.id;
      return characterId === actor.id;
    })?.id ??
    owners[0]?.id ??
    null
  );
}

function userCanOperateActor(actor, userId) {
  const user = game.users?.get?.(userId);
  if (!user) return false;
  if (isFullGM(user)) return true;
  const characterId =
    typeof user.character === "string" ? user.character : user.character?.id;
  return characterId === actor.id || hasDirectOwnerPermission(actor, user.id);
}

function hasDirectOwnerPermission(actor, userId) {
  const id = String(userId ?? "");
  if (!id) return false;
  const ownership = actor?.ownership ?? {};
  const level = Object.hasOwn(ownership, id)
    ? ownership[id]
    : ownership.default;
  const OWNER = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  return Number(level) >= Number(OWNER);
}

function generatePendingId() {
  return `pending-${generateCriticalInjuryId().replace(/^injury-/, "")}`;
}

async function evaluateFormulaTotal(formula) {
  const result = await evaluateFormula(formula);
  return Math.max(0, Math.floor(Number(result.total) || 0));
}

async function evaluateFormula(
  formula,
  { flavor = "", speaker = null, chatMessage = false } = {},
) {
  const RollClass = globalThis.Roll;
  if (typeof RollClass === "function") {
    const roll = await new RollClass(String(formula)).evaluate();
    if (chatMessage && typeof roll.toMessage === "function") {
      await roll.toMessage({
        speaker: globalThis.ChatMessage?.getSpeaker?.({ actor: speaker }),
        flavor,
      });
    }
    return roll;
  }
  return { total: fallbackFormulaRoll(formula) };
}

function fallbackFormulaRoll(formula) {
  const match = /^(\d+)d(\d+)(?:\+(\d+))?$/.exec(
    String(formula ?? "").replaceAll(" ", ""),
  );
  if (!match) return Math.max(0, Number(formula) || 0);
  const count = Number(match[1]);
  const sides = Number(match[2]);
  let total = Number(match[3] ?? 0);
  for (let index = 0; index < count; index += 1) {
    total += 1 + Math.floor(Math.random() * sides);
  }
  return total;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
