/**
 * Infinity D&D5e — ForagePromptApp
 *
 * Player-facing window pushed when a new day begins in a forageable place. The
 * player can roll Wisdom (Survival) to gather, or skip. The roll runs on their
 * own client (their bonuses + dice apply); only the total is sent to the GM,
 * which resolves the yield and deposits it onto the character's sheet.
 *
 * Mirrors the merchant-session auto-open pattern: one window per runId, opened
 * by a DAY_PROMPT socket event targeted at this user.
 */

import {
  RESOURCE_EVENTS,
  emitResourceEvent,
  subscribe,
} from "./resource/socket.js";
import {
  rollSurvivalTotal,
  getSurvivalPassive,
  getWisMod,
} from "./resource/roll.js";
import { prettyEnvironment } from "./ui-util.js";
import { SOUND_EVENTS, playModuleSound } from "./audio.js";
import { SETTING_KEYS, getSetting } from "./settings.js";

const MODULE_ID = "infinity-dnd5e";
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/forage-prompt.hbs`;

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** Map<"runId::actorId", ForagePromptApp> — one window per GM-targeted actor.
 *  The GM emits a DAY_PROMPT per tracked actor (a player who owns several gets
 *  several), all sharing a runId, so keying by runId alone would collapse them
 *  into one window and strand the other actors' results. */
const instances = new Map();

/** Composite window key. Falls back to the bare runId when no actor is named. */
function instanceKey(runId, actorId) {
  const a = String(actorId ?? "").trim();
  return a ? `${runId}::${a}` : String(runId);
}

export class ForagePromptApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "infinity-dnd5e-forage-prompt",
    tag: "section",
    classes: ["infinity-dnd5e", "infinity-forage-prompt"],
    window: {
      title: "Daily Foraging",
      icon: "fa-solid fa-wheat-awn",
      resizable: false,
    },
    position: { width: 460, height: "auto" },
    actions: {
      rollSurvival: ForagePromptApp._onRoll,
      skip: ForagePromptApp._onSkip,
      dismiss: ForagePromptApp._onDismiss,
    },
  };

  static PARTS = {
    body: { template: TEMPLATE_PATH },
  };

  /** Open (or focus) the window for a forage run + a specific tracked actor. */
  static open({ runId, environment, actorName, day, actorId } = {}) {
    if (!runId) return null;
    const key = instanceKey(runId, actorId);
    let app = instances.get(key);
    if (!app) {
      app = new ForagePromptApp({
        id: `infinity-dnd5e-forage-prompt-${String(key).replace(/[^a-z0-9_-]/gi, "-")}`,
        runId,
        environment,
        actorName,
        day,
        actorId,
      });
      instances.set(key, app);
    } else {
      app._environment = environment ?? app._environment;
    }
    if (app.rendered) app.bringToFront();
    else app.render(true);
    return app;
  }

  /** Route a GM FORAGE_ACK to the matching window (by run + actor). */
  static handleAck(payload) {
    const app =
      instances.get(instanceKey(payload?.runId, payload?.actorId)) ??
      instances.get(String(payload?.runId));
    if (app) app._onAck(payload);
  }

  constructor(options = {}) {
    super(options);
    this._runId = options.runId;
    this._actorId = options.actorId ?? null; // the GM-targeted tracked actor
    this._instanceKey = instanceKey(options.runId, options.actorId);
    this._environment = options.environment ?? null;
    this._actorName = options.actorName ?? null;
    this._day = options.day ?? null;
    this._state = "prompt"; // prompt | waiting | done
    this._result = null;
  }

  /** The actor this prompt forages as: the GM-targeted one if this user owns
   *  it, else the user's assigned/owned character (legacy single-actor path). */
  _resolveActor() {
    const byId = this._actorId
      ? globalThis.game?.actors?.get?.(this._actorId)
      : null;
    const user = globalThis.game?.user;
    if (byId && (!user || byId.testUserPermission?.(user, "OWNER") !== false)) {
      return byId;
    }
    return resolvePlayerActor();
  }

  get title() {
    const env = this._environment;
    const label = env ? prettyEnvironment(env.id) || env.label : "";
    return label ? `Daily Foraging — ${label}` : "Daily Foraging";
  }

  _onClose(options) {
    super._onClose?.(options);
    this._clearWaitTimer();
    instances.delete(this._instanceKey);
  }

  _clearWaitTimer() {
    if (this._waitTimer != null) {
      globalThis.clearTimeout?.(this._waitTimer);
      this._waitTimer = null;
    }
  }

  async _prepareContext() {
    const actor = this._resolveActor();
    const env = this._environment ?? {};
    const passive = getSurvivalPassive(actor);
    const wisMod = actor ? getWisMod(actor) : 0;
    return {
      actorName: actor?.name ?? this._actorName ?? null,
      noActor: !actor,
      environmentLabel: prettyEnvironment(env.id) || env.label || "the wild",
      dc: env.dc ?? null,
      passiveLabel:
        passive == null ? "" : `Your passive Survival is ${passive}`,
      wisLabel: actor ? `Wisdom ${wisMod >= 0 ? "+" : ""}${wisMod}` : "",
      isPrompt: this._state === "prompt",
      isWaiting: this._state === "waiting",
      isDone: this._state === "done",
      result: this._result,
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const root = this.element;
    if (root) {
      root.classList.toggle(
        "fp-no-anim",
        getSetting(SETTING_KEYS.ANIMATIONS) === false,
      );
    }
    if (this._state === "prompt") {
      playModuleSound(SOUND_EVENTS.UI_OPEN);
    }
  }

  _onAck(payload) {
    this._clearWaitTimer();
    // The GM resolved the run without our input (timeout) while we were still
    // deciding — show a neutral "wrapped up" note, not "came up empty-handed".
    const noResponse = payload?.noResponse === true && this._state === "prompt";
    this._state = "done";
    this._result = {
      success: payload?.success === true,
      food: Number(payload?.food) || 0,
      water: Number(payload?.water) || 0,
      noResponse,
      // "best" mode: this forager gathered but a bigger haul was kept for the party.
      suppressed: payload?.suppressed === true,
    };
    playModuleSound(
      this._result.success ? SOUND_EVENTS.DEPOSIT : SOUND_EVENTS.WARNING_MUTED,
    );
    this.render(false);
  }

  /* -------------------- actions -------------------- */

  /** @this {ForagePromptApp} */
  static async _onRoll(_event, _target) {
    const actor = this._resolveActor();
    if (!actor) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      ui.notifications?.warn(
        "No character is assigned to you — ask your GM to assign one.",
      );
      return;
    }
    playModuleSound(SOUND_EVENTS.ROLL_START);
    const rolled = await rollSurvivalTotal(actor, { chatMessage: true });
    if (!rolled) {
      // Dialog dismissed — leave the window in the prompt state to retry.
      return;
    }
    emitResourceEvent(RESOURCE_EVENTS.FORAGE_RESULT, {
      runId: this._runId,
      // Report the GM-targeted actor id so the right run entry resolves, even
      // when this user's assigned character differs from the tracked actor.
      actorId: this._actorId ?? actor.id,
      rollTotal: rolled.total,
      wisMod: getWisMod(actor),
      skipped: false,
    });
    this._state = "waiting";
    this.render(false);
    // Fallback: if the GM never sends an ack (e.g. they disconnect mid-run),
    // don't spin forever — settle into a neutral "wrapped up" state.
    this._clearWaitTimer();
    this._waitTimer = globalThis.setTimeout?.(() => {
      if (this._state !== "waiting") return;
      this._state = "done";
      this._result = { success: false, food: 0, water: 0, timedOut: true };
      this.render(false);
    }, 130000);
  }

  /** @this {ForagePromptApp} */
  static _onSkip(_event, _target) {
    const actor = this._resolveActor();
    emitResourceEvent(RESOURCE_EVENTS.FORAGE_RESULT, {
      runId: this._runId,
      // Prefer the GM-targeted id so a skip always resolves the right run entry
      // (a null id would be dropped and stall the GM's window on the timeout).
      actorId: this._actorId ?? actor?.id ?? null,
      rollTotal: 0,
      wisMod: 0,
      skipped: true,
    });
    this.close();
  }

  /** @this {ForagePromptApp} */
  static _onDismiss(_event, _target) {
    this.close();
  }
}

/* ------------------------------------------------------------------ *
 * Auto-open wiring
 * ------------------------------------------------------------------ */

let autoOpenRegistered = false;

/**
 * Subscribe to DAY_PROMPT (open the window for this user) and FORAGE_ACK (update
 * it with the resolved yield). GMs never auto-open — they drive the Quartermaster.
 */
export function registerForagePromptAutoOpen() {
  if (autoOpenRegistered) return;
  autoOpenRegistered = true;

  subscribe(RESOURCE_EVENTS.DAY_PROMPT, (payload) => {
    if (!payload) return;
    // Target by user id, NOT by isGM: an Assistant-GM (role 3) who owns a tracked
    // character should still be prompted to forage. The active GM that drives the
    // run never targets itself, so this won't pop on the driving GM's screen.
    if (payload.targetUserId !== globalThis.game?.user?.id) return;
    if (payload.environment?.forageable === false) return;
    ForagePromptApp.open({
      runId: payload.runId,
      environment: payload.environment,
      actorName: payload.actorName,
      day: payload.day,
      actorId: payload.actorId,
    });
  });

  subscribe(RESOURCE_EVENTS.FORAGE_ACK, (payload) => {
    if (!payload) return;
    if (
      payload.targetUserId &&
      payload.targetUserId !== globalThis.game?.user?.id
    ) {
      return;
    }
    ForagePromptApp.handleAck(payload);
  });
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function resolvePlayerActor() {
  const assigned = globalThis.game?.user?.character;
  if (assigned) return assigned;
  const actors = globalThis.game?.actors;
  if (!actors) return null;
  return (
    actors.find?.(
      (a) =>
        a?.type === "character" &&
        a?.testUserPermission?.(globalThis.game?.user, "OWNER"),
    ) ?? null
  );
}
