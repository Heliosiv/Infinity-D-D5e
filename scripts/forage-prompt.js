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

/** Map<runId, ForagePromptApp> */
const instances = new Map();

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

  /** Open (or focus) the window for a forage run. */
  static open({ runId, environment, actorName, day } = {}) {
    if (!runId) return null;
    let app = instances.get(runId);
    if (!app) {
      app = new ForagePromptApp({
        id: `infinity-dnd5e-forage-prompt-${runId}`,
        runId,
        environment,
        actorName,
        day,
      });
      instances.set(runId, app);
    } else {
      app._environment = environment ?? app._environment;
    }
    if (app.rendered) app.bringToFront();
    else app.render(true);
    return app;
  }

  /** Route a GM FORAGE_ACK to the matching window. */
  static handleAck(payload) {
    const app = instances.get(payload?.runId);
    if (app) app._onAck(payload);
  }

  constructor(options = {}) {
    super(options);
    this._runId = options.runId;
    this._environment = options.environment ?? null;
    this._actorName = options.actorName ?? null;
    this._day = options.day ?? null;
    this._state = "prompt"; // prompt | waiting | done
    this._result = null;
  }

  get title() {
    const env = this._environment;
    const label = env ? prettyEnvironment(env.id) || env.label : "";
    return label ? `Daily Foraging — ${label}` : "Daily Foraging";
  }

  _onClose(options) {
    super._onClose?.(options);
    this._clearWaitTimer();
    instances.delete(this._runId);
  }

  _clearWaitTimer() {
    if (this._waitTimer != null) {
      globalThis.clearTimeout?.(this._waitTimer);
      this._waitTimer = null;
    }
  }

  async _prepareContext() {
    const actor = resolvePlayerActor();
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
    this._state = "done";
    this._result = {
      success: payload?.success === true,
      food: Number(payload?.food) || 0,
      water: Number(payload?.water) || 0,
    };
    playModuleSound(
      this._result.success ? SOUND_EVENTS.DEPOSIT : SOUND_EVENTS.WARNING_MUTED,
    );
    this.render(false);
  }

  /* -------------------- actions -------------------- */

  /** @this {ForagePromptApp} */
  static async _onRoll(_event, _target) {
    const actor = resolvePlayerActor();
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
      actorId: actor.id,
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
    const actor = resolvePlayerActor();
    emitResourceEvent(RESOURCE_EVENTS.FORAGE_RESULT, {
      runId: this._runId,
      actorId: actor?.id ?? null,
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
    if (globalThis.game?.user?.isGM) return;
    if (payload.targetUserId !== globalThis.game?.user?.id) return;
    if (payload.environment?.forageable === false) return;
    ForagePromptApp.open({
      runId: payload.runId,
      environment: payload.environment,
      actorName: payload.actorName,
      day: payload.day,
    });
  });

  subscribe(RESOURCE_EVENTS.FORAGE_ACK, (payload) => {
    if (!payload) return;
    if (payload.targetUserId && payload.targetUserId !== globalThis.game?.user?.id) {
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
