/**
 * Infinity D&D5e — permission-scoped player launcher and exceptional recovery
 *
 * `InfinityDashboardApp` remains the compatibility class name, but the window
 * now serves players and Assistant GMs with fixed, permission-scoped local
 * surfaces. Full-GM primary access routes directly to the Workbench.
 */

import { SOUND_EVENTS, playModuleSound } from "./audio.js";
import { isFullGM } from "./permissions.js";
import {
  getPlayerSurfaceAvailability,
  openPlayerSurface,
  PLAYER_SURFACE_LABELS,
  PLAYER_SURFACES,
} from "./player-surface.js";
import {
  confirmInfinityDialog,
  promptInfinityDialog,
} from "./dialog-contract.js";
import {
  applyEmptyPrivateStateReplacement,
  applyPrivateStateCandidateAdoption,
  applyPrivateStateSnapshotRecovery,
  getPrivateStateRecoveryOverview,
  onPrivateStateChanged,
  previewEmptyPrivateStateReplacement,
  previewPrivateStateCandidateAdoption,
  previewPrivateStateSnapshotRecovery,
  PRIVATE_STATE_CHANGED_HOOK,
} from "./private-state.js";
import * as settingsApi from "./settings.js";
import { isAuthoritativeGM } from "./socket-authority.js";
import { getTool, getTools, TOOL_INTENTS } from "./tool-registry.js";
import { escapeHtml, prettyCategory, notify } from "./ui-util.js";
import { bindFullGmWindowGuard, openSingleton } from "./infinity-app.js";

const MODULE_ID = "infinity-dnd5e";
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/dashboard.hbs`;
const RECOVERY_TEMPLATE_PATH = `modules/${MODULE_ID}/templates/private-state-recovery.hbs`;
const { SETTING_KEYS, getSetting, setSetting } = settingsApi;

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const PRIVATE_STATE_RECOVERY_SERVICE = Object.freeze({
  getOverview: getPrivateStateRecoveryOverview,
  previewCandidate: previewPrivateStateCandidateAdoption,
  applyCandidate: applyPrivateStateCandidateAdoption,
  previewSnapshot: previewPrivateStateSnapshotRecovery,
  applySnapshot: applyPrivateStateSnapshotRecovery,
  previewEmpty: previewEmptyPrivateStateReplacement,
  applyEmpty: applyEmptyPrivateStateReplacement,
});

const PRIVATE_STATE_REASON_LABELS = Object.freeze({
  "candidate-review-required":
    "A marked store is available, but a Game Master must review it before making it canonical.",
  "authoritative-gm-required":
    "Only the active Game Master can confirm campaign-data recovery actions.",
  corrupt:
    "The selected store is incomplete or corrupt, so campaign tools remain locked.",
  "future-schema":
    "The selected store was written by a newer module version and cannot be opened safely.",
  "full-gm-required":
    "Only a full Game Master can inspect campaign-data recovery status.",
  "initialization-error":
    "Campaign data could not be verified. Refresh this status before choosing a recovery action.",
  "invalid-schema":
    "The selected store has an invalid schema marker and cannot be opened safely.",
  "missing-store":
    "The selected private-state Journal is not currently available in this world.",
  "not-started": "Campaign data has not finished its first verification.",
  "role-promotion":
    "Campaign data is being verified for the new Game Master role.",
  "store-missing":
    "The selected private-state Journal is not currently available in this world.",
  "store-unavailable":
    "The selected private-state Journal is still unavailable or loading.",
  "unsafe-ownership":
    "This Journal is not restricted to full Game Masters and cannot be adopted safely.",
});

const CANDIDATE_REASON_LABELS = Object.freeze({
  "already-canonical": "This is already the selected campaign-data store.",
  canonical: "This is already the selected campaign-data store.",
  corrupt: "This candidate is incomplete or corrupt.",
  "future-schema": "This candidate was written by a newer module version.",
  "incomplete-payload": "This candidate does not contain every required field.",
  "invalid-schema": "This candidate has an invalid schema marker.",
  "invalid-payload": "This candidate does not have a valid data shape.",
  "legacy-schema":
    "This candidate uses an older supported schema and will follow normal migration after adoption.",
  "not-private-state-store":
    "This Journal is not marked as an Infinity private-state store.",
  "unsupported-schema": "This candidate uses an unsupported schema marker.",
  "unsafe-ownership": "This candidate is not restricted to full Game Masters.",
});

const HOME_INTENTS = Object.freeze([
  {
    id: TOOL_INTENTS.PREPARE,
    label: "Prepare",
    description: "Set up the people, places, and supplies the session needs.",
    icon: "fa-solid fa-list-check",
  },
  {
    id: TOOL_INTENTS.RUN_SESSION,
    label: "Run the Session",
    description: "Open the tools you use while play is moving.",
    icon: "fa-solid fa-dice-d20",
  },
  {
    id: TOOL_INTENTS.TRACK_CAMPAIGN,
    label: "Track the Campaign",
    description: "Review persistent party state and longer-term progress.",
    icon: "fa-solid fa-map-location-dot",
  },
]);

const PLAYER_HOME_DESTINATIONS = Object.freeze([
  {
    surface: PLAYER_SURFACES.SHOPS,
    intent: TOOL_INTENTS.PREPARE,
    icon: "fa-solid fa-store",
    description: "Browse shops currently available to your account.",
  },
  {
    surface: PLAYER_SURFACES.DOWNTIME,
    intent: TOOL_INTENTS.RUN_SESSION,
    icon: "fa-solid fa-hourglass-half",
    description: "Review your active downtime block and queue activities.",
  },
  {
    surface: PLAYER_SURFACES.CALENDAR,
    intent: TOOL_INTENTS.RUN_SESSION,
    icon: "fa-solid fa-calendar-days",
    description: "Open the campaign calendar when Simple Calendar is active.",
  },
  {
    surface: PLAYER_SURFACES.PARTY_SUPPLIES,
    intent: TOOL_INTENTS.TRACK_CAMPAIGN,
    icon: "fa-solid fa-campground",
    description:
      "Check the food, water, and light outlook the GM has made available.",
  },
  {
    surface: PLAYER_SURFACES.REPUTATION,
    intent: TOOL_INTENTS.TRACK_CAMPAIGN,
    icon: "fa-solid fa-handshake",
    description: "Review faction standings the GM has revealed to players.",
  },
  {
    surface: PLAYER_SURFACES.CRITICAL_INJURIES,
    intent: TOOL_INTENTS.TRACK_CAMPAIGN,
    icon: "fa-solid fa-heart-pulse",
    description:
      "Review your controlled character's injuries and treatment status.",
  },
]);

const PLAYER_HOME_SURFACE_SET = new Set(
  PLAYER_HOME_DESTINATIONS.map((entry) => entry.surface),
);

export class InfinityDashboardApp extends HandlebarsApplicationMixin(
  ApplicationV2,
) {
  static _instance = null;
  static _recentToolIds = [];
  static _recentsHydrated = false;
  static RECENT_LIMIT = 3;

  static _hydrateRecents() {
    if (InfinityDashboardApp._recentsHydrated) return;
    const stored = getSetting(SETTING_KEYS.RECENT_TOOLS);
    InfinityDashboardApp._recentToolIds = Array.isArray(stored)
      ? stored.map((value) => String(value)).filter(Boolean)
      : [];
    InfinityDashboardApp._recentsHydrated = true;
  }

  static _recordRecent(id) {
    if (!id) return;
    InfinityDashboardApp._hydrateRecents();
    const next = InfinityDashboardApp._recentToolIds.filter(
      (entry) => entry !== id,
    );
    next.unshift(id);
    InfinityDashboardApp._recentToolIds = next.slice(
      0,
      InfinityDashboardApp.RECENT_LIMIT,
    );
    void setSetting(SETTING_KEYS.RECENT_TOOLS, [
      ...InfinityDashboardApp._recentToolIds,
    ]);
  }

  static DEFAULT_OPTIONS = {
    id: "infinity-dnd5e-dashboard",
    tag: "section",
    classes: ["infinity-dnd5e", "infinity-dashboard"],
    window: {
      title: "Infinity D&D5e — Player Launcher",
      icon: "fa-solid fa-dice-d20",
      resizable: true,
    },
    position: { width: 760, height: 640 },
    actions: {
      launch: InfinityDashboardApp._onLaunch,
      openSettings: InfinityDashboardApp._onOpenSettings,
      help: InfinityDashboardApp._onHelp,
    },
  };

  static PARTS = {
    body: { template: TEMPLATE_PATH },
  };

  /** Open or focus the player/Assistant launcher. */
  static open() {
    playModuleSound(SOUND_EVENTS.UI_OPEN);
    const shouldRefresh = Boolean(InfinityDashboardApp._instance?.rendered);
    const app = openSingleton(
      InfinityDashboardApp,
      () => new InfinityDashboardApp(),
    );
    if (shouldRefresh) void app.render(false);
    return app;
  }

  constructor(options = {}) {
    super(options);
    this._privateStateRecoveryService =
      options.privateStateRecoveryService ?? PRIVATE_STATE_RECOVERY_SERVICE;
    this._privateStateRecoveryInFlight = false;
    this._privateStateRecoveryMessage = "";
    this._privateStateRecoveryTone = "neutral";
    this._privateStateHookId = null;
    // A compatibility launcher opened with privileged GM tiles closes on
    // demotion. Normal full-GM entry routes directly to the Workbench.
    this._unbindFullGmWindowGuard = isFullGM()
      ? bindFullGmWindowGuard(this)
      : bindPlayerHomePromotionGuard(this);
    if (isFullGM()) {
      this._privateStateHookId = onPrivateStateChanged(() => {
        if (!this.rendered || this._privateStateRecoveryInFlight) return;
        void this.render(false);
      });
    }
  }

  async _prepareContext() {
    InfinityDashboardApp._hydrateRecents();
    const fullGm = isFullGM();
    const assistantGm = Boolean(globalThis.game?.user?.isGM && !fullGm);
    const moduleVersion = String(
      globalThis.game?.modules?.get?.(MODULE_ID)?.version ?? "0.0.0",
    );
    const registeredTools = fullGm ? getTools() : [];
    const actions = fullGm
      ? registeredTools.map(normalizeRegisteredTool)
      : buildPlayerHomeActions();
    const groups = groupHomeActionsByIntent(actions);
    const recentActions = resolveRecentActions(actions);
    const sessionFocus = resolveSessionFocus(actions, recentActions);
    const privateStateRecovery = fullGm
      ? await preparePrivateStateRecoveryContext(this)
      : null;

    return {
      moduleId: MODULE_ID,
      moduleVersion,
      isFullGm: fullGm,
      isAssistantGm: assistantGm,
      roleLabel: fullGm
        ? "Game Master Launcher"
        : assistantGm
          ? "Assistant GM Launcher"
          : "Player Launcher",
      headingHint: fullGm
        ? "Prepare the session, run active workflows, and track what changes."
        : "Open the campaign tools and information currently available to you.",
      hasActions: actions.length > 0,
      groups,
      recentTools: recentActions,
      hasRecentTools: recentActions.length > 0,
      sessionFocus,
      privateStateRecovery,

      // Compatibility context for existing harnesses and extensions that still
      // call this surface a dashboard.
      hasTools: actions.length > 0,
      tools: registeredTools.map(normalizeRegisteredTool),
      categories: groupByCategory(registeredTools),
    };
  }

  /** @this {InfinityCampaignRecoveryApp} */
  static async _onOpenWorkbench() {
    const overview = await this._privateStateRecoveryService?.getOverview?.();
    if (overview?.status?.state !== "ready") {
      globalThis.ui?.notifications?.warn?.(
        "Campaign recovery is not complete. Review the current status before opening campaign tools.",
      );
      await this.render?.(false);
      return null;
    }
    const moduleApi = globalThis.game?.modules?.get?.(MODULE_ID)?.api;
    if (typeof moduleApi?.openGmWorkbench !== "function") return null;
    await this.close?.({ animate: false });
    return moduleApi.openGmWorkbench();
  }

  _onClose(options) {
    super._onClose?.(options);
    if (this._privateStateHookId != null) {
      globalThis.Hooks?.off?.(
        PRIVATE_STATE_CHANGED_HOOK,
        this._privateStateHookId,
      );
    }
    this._privateStateHookId = null;
    this._unbindFullGmWindowGuard?.();
    this._unbindFullGmWindowGuard = null;
    InfinityDashboardApp._instance = null;
  }

  /** @this {InfinityDashboardApp} */
  static async _onOpenSettings() {
    const moduleApi = globalThis.game?.modules?.get?.(MODULE_ID)?.api;
    if (typeof moduleApi?.openSettings === "function") {
      try {
        await moduleApi.openSettings();
        playModuleSound(SOUND_EVENTS.ITEM_OPEN);
        return;
      } catch (error) {
        console.warn(`${MODULE_ID} | Infinity Settings did not open`, error);
      }
    }
    try {
      const SettingsConfig =
        globalThis.foundry?.applications?.settings?.SettingsConfig ??
        globalThis.SettingsConfig;
      if (typeof SettingsConfig === "function") {
        renderSettingsConfig(SettingsConfig);
        playModuleSound(SOUND_EVENTS.ITEM_OPEN);
        return;
      }
    } catch (error) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      console.warn(`${MODULE_ID} | could not open SettingsConfig`, error);
    }
    globalThis.ui?.notifications?.info?.(
      "Open Game Settings, then Module Settings, to edit Infinity D&D5e options.",
    );
  }

  /** @this {InfinityDashboardApp} */
  static async _onHelp() {
    const fullGm = isFullGM();
    await promptInfinityDialog({
      window: {
        title: "Infinity D&D5e — Launcher Help",
        icon: "fa-solid fa-circle-question",
      },
      content: buildHomeHelpDialogContent({ fullGm }),
      ok: {
        label: "Close",
        icon: "fa-solid fa-check",
        callback: () => true,
      },
      rejectClose: false,
    });
  }

  /** @this {InfinityDashboardApp} */
  static async _onRefreshPrivateState() {
    this._privateStateRecoveryMessage = "Campaign data status refreshed.";
    this._privateStateRecoveryTone = "neutral";
    await this.render(false);
  }

  /** @this {InfinityDashboardApp} */
  static async _onReviewPrivateStateCandidate(_event, target) {
    const candidateId = String(target?.dataset?.candidateId ?? "").trim();
    if (!candidateId) return;
    await runPrivateStateRecoveryAction(this, async (service) => {
      const preview = await service.previewCandidate(candidateId);
      const confirmed = await confirmInfinityDialog({
        window: {
          title: "Adopt this campaign-data store?",
          icon: "fa-solid fa-link",
        },
        content: buildCandidateAdoptionConfirmation(preview),
        yes: {
          label: "Adopt this store",
          icon: "fa-solid fa-link",
        },
        no: { label: "Cancel", icon: "fa-solid fa-xmark" },
        rejectClose: false,
      });
      if (!confirmed) return null;
      assertRecoveryMutationAuthority();
      return service.applyCandidate({ token: preview?.token });
    });
  }

  /** @this {InfinityDashboardApp} */
  static async _onRecoverPrivateStateSnapshot() {
    await runPrivateStateRecoveryAction(this, async (service) => {
      const preview = await service.previewSnapshot();
      const confirmed = await confirmInfinityDialog({
        window: {
          title: "Recover the verified campaign-data snapshot?",
          icon: "fa-solid fa-clock-rotate-left",
        },
        content: buildSnapshotRecoveryConfirmation(preview),
        yes: {
          label: "Recover snapshot",
          icon: "fa-solid fa-clock-rotate-left",
        },
        no: { label: "Cancel", icon: "fa-solid fa-xmark" },
        rejectClose: false,
      });
      if (!confirmed) return null;
      assertRecoveryMutationAuthority();
      return service.applySnapshot({
        token: preview?.token,
        confirmationToken: preview?.confirmationToken,
      });
    });
  }

  /** @this {InfinityDashboardApp} */
  static async _onCreateEmptyPrivateState() {
    await runPrivateStateRecoveryAction(this, async (service) => {
      const preview = await service.previewEmpty();
      const confirmed = await confirmInfinityDialog({
        window: {
          title: "Start with empty campaign data?",
          icon: "fa-solid fa-triangle-exclamation",
        },
        content: buildEmptyReplacementConfirmation(preview),
        yes: {
          label: "Create empty store",
          icon: "fa-solid fa-file-circle-plus",
        },
        no: { label: "Cancel", icon: "fa-solid fa-xmark" },
        rejectClose: false,
      });
      if (!confirmed) return null;
      assertRecoveryMutationAuthority();
      return service.applyEmpty({
        token: preview?.token,
        confirmationToken: preview?.confirmationToken,
      });
    });
  }

  /** @this {InfinityDashboardApp} */
  static async _onLaunch(_event, target) {
    const launchKind = String(target?.dataset?.launchKind ?? "");
    const launchId = String(
      target?.dataset?.launchId ?? target?.dataset?.toolId ?? "",
    ).trim();
    if (!launchId) return;

    if (launchKind === "surface") {
      await InfinityDashboardApp._launchPlayerSurface.call(this, launchId);
      return;
    }

    if (launchKind && launchKind !== "tool") return;
    if (!isFullGM()) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      globalThis.ui?.notifications?.warn?.(
        "Only a Game Master can open that campaign-management tool.",
      );
      return;
    }

    const tool = getTool(launchId);
    if (!tool) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      notify(
        "warn",
        "That launcher destination is no longer available. Nothing changed; refresh the launcher and choose another destination.",
      );
      return;
    }
    if (tool.status !== "available") {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      globalThis.ui?.notifications?.info?.(
        `${tool.title} is not available in this release yet. Nothing changed.`,
      );
      return;
    }

    try {
      await tool.open();
      InfinityDashboardApp._recordRecent(tool.id);
      void this.render(false);
    } catch (error) {
      console.error(`${MODULE_ID} | failed to open tool "${tool.id}"`, error);
      globalThis.ui?.notifications?.error?.(
        `${tool.title} did not open. Nothing changed; try again.`,
      );
    }
  }

  /** @this {InfinityDashboardApp} */
  static async _launchPlayerSurface(surface) {
    if (!PLAYER_HOME_SURFACE_SET.has(surface)) return;
    const availability = getPlayerSurfaceAvailability(surface);
    if (!availability.available) {
      playModuleSound(SOUND_EVENTS.WARNING_MUTED);
      globalThis.ui?.notifications?.warn?.(availability.reason);
      return;
    }

    const opened = await openPlayerSurface(surface);
    if (!opened) return;
    InfinityDashboardApp._recordRecent(`surface:${surface}`);
    void this.render(false);
  }
}

export class InfinityCampaignRecoveryApp extends InfinityDashboardApp {
  static _instance = null;

  static DEFAULT_OPTIONS = {
    id: "infinity-dnd5e-campaign-recovery",
    tag: "section",
    classes: [
      "infinity-dnd5e",
      "infinity-dashboard",
      "infinity-campaign-recovery",
    ],
    window: {
      title: "Infinity D&D5e — Campaign Recovery",
      icon: "fa-solid fa-triangle-exclamation",
      resizable: true,
    },
    position: { width: 760, height: 700 },
    actions: {
      refreshPrivateState: InfinityDashboardApp._onRefreshPrivateState,
      reviewPrivateStateCandidate:
        InfinityDashboardApp._onReviewPrivateStateCandidate,
      recoverPrivateStateSnapshot:
        InfinityDashboardApp._onRecoverPrivateStateSnapshot,
      createEmptyPrivateState: InfinityDashboardApp._onCreateEmptyPrivateState,
      openWorkbench: InfinityCampaignRecoveryApp._onOpenWorkbench,
    },
  };

  static PARTS = {
    body: { template: RECOVERY_TEMPLATE_PATH },
  };

  static open() {
    if (!isFullGM()) {
      globalThis.ui?.notifications?.warn?.(
        "Campaign recovery is available to full Game Masters only.",
      );
      return null;
    }
    playModuleSound(SOUND_EVENTS.WARNING_MUTED);
    const shouldRefresh = Boolean(
      InfinityCampaignRecoveryApp._instance?.rendered,
    );
    const app = openSingleton(
      InfinityCampaignRecoveryApp,
      () => new InfinityCampaignRecoveryApp(),
    );
    InfinityCampaignRecoveryApp._instance = app;
    if (shouldRefresh) void app.render(false);
    return app;
  }

  async _prepareContext() {
    const moduleVersion = String(
      globalThis.game?.modules?.get?.(MODULE_ID)?.version ?? "0.0.0",
    );
    return {
      moduleId: MODULE_ID,
      moduleVersion,
      privateStateRecovery: await preparePrivateStateRecoveryContext(this),
    };
  }

  _onClose(options) {
    super._onClose(options);
    InfinityCampaignRecoveryApp._instance = null;
  }
}

async function preparePrivateStateRecoveryContext(application) {
  try {
    const overview =
      await application._privateStateRecoveryService.getOverview();
    if (!isFullGM() || overview?.fullGm !== true) {
      return presentPrivateStateRecoveryOverview({
        status: {
          state: "pending",
          code: "full-gm-required",
          supportedSchema: null,
          observedSchema: null,
        },
        fullGm: false,
        authoritative: false,
        canonicalId: "",
        candidates: [],
        canMutate: false,
        blockedReason: "full-gm-required",
      });
    }
    return presentPrivateStateRecoveryOverview(overview, {
      busy: application._privateStateRecoveryInFlight,
      message: application._privateStateRecoveryMessage,
      messageTone: application._privateStateRecoveryTone,
    });
  } catch (error) {
    console.warn(
      `${MODULE_ID} | campaign-data status could not be read (${safeRecoveryErrorCode(error)})`,
    );
    return presentPrivateStateRecoveryOverview(
      {
        status: {
          state: "pending",
          code: "store-unavailable",
          supportedSchema: null,
          observedSchema: null,
        },
        authoritative: false,
        candidates: [],
        canMutate: false,
        blockedReason: "store-unavailable",
      },
      {
        busy: false,
        message:
          "Campaign data status could not be read. Refresh after startup completes.",
        messageTone: "danger",
      },
    );
  }
}

/** Convert the value-free service projection into recovery-window data. */
export function presentPrivateStateRecoveryOverview(raw = {}, uiState = {}) {
  const status =
    raw?.status && typeof raw.status === "object" ? raw.status : {};
  const state = ["ready", "blocked"].includes(status.state)
    ? status.state
    : "pending";
  const busy = uiState.busy === true;
  const authoritative = raw.authoritative === true;
  const recoveryNeeded = state !== "ready";
  const canMutate =
    raw.canMutate === true && authoritative && recoveryNeeded && !busy;
  const mutationReason = busy
    ? "A campaign-data action is already being checked."
    : !authoritative
      ? "Only the active Game Master can change campaign data."
      : state === "pending"
        ? "Campaign data is still being checked. Recovery actions are not available yet."
        : state === "ready"
          ? "Campaign data is verified; recovery actions are not available."
          : "Recovery actions are not available for the current state.";
  const candidates = (Array.isArray(raw.candidates) ? raw.candidates : []).map(
    (candidate, index) => {
      const eligible = candidate?.eligible === true;
      return {
        id: String(candidate?.id ?? "").trim() || "Unknown Journal",
        domId: `infinity-home-campaign-candidate-${index}`,
        canonical: candidate?.canonical === true,
        canonicalLabel:
          candidate?.canonical === true ? "Selected" : "Candidate",
        createdLabel: formatRecoveryTimestamp(candidate?.createdTime),
        modifiedLabel: formatRecoveryTimestamp(candidate?.modifiedTime),
        schemaLabel: recoverySchemaLabel(
          candidate?.schemaState,
          candidate?.observedSchema,
        ),
        payloadLabel: recoveryPayloadLabel(candidate?.payloadState),
        ownershipLabel: recoveryOwnershipLabel(candidate?.ownershipState),
        eligible,
        canAdopt: eligible && canMutate,
        reason: eligible
          ? canMutate
            ? "Ready for review."
            : mutationReason
          : candidateReason(candidate?.reason),
      };
    },
  );
  const tone =
    state === "ready" ? "success" : state === "blocked" ? "danger" : "warning";
  const stateLabel =
    state === "ready"
      ? "Ready"
      : state === "blocked"
        ? "Recovery needed"
        : "Loading";
  const stateTitle =
    state === "ready"
      ? "Campaign data is verified"
      : state === "blocked"
        ? "Campaign tools are safely locked"
        : "Campaign data is still being checked";
  const reason = recoveryReason(
    state === "ready" ? status.code : (raw.blockedReason ?? status.code),
    state,
  );
  const canonicalId = String(raw.canonicalId ?? "").trim();
  const snapshotAvailable = raw.snapshotAvailable === true;

  return {
    open: state !== "ready",
    state,
    stateLabel,
    stateTitle,
    statusRole: state === "blocked" ? "alert" : "status",
    statusClass: `infinity-banner--${tone}`,
    statusIcon:
      state === "ready"
        ? "fa-solid fa-circle-check"
        : state === "blocked"
          ? "fa-solid fa-triangle-exclamation"
          : "fa-solid fa-spinner",
    reason,
    canonicalId: canonicalId || "Not selected",
    canonicalStateLabel: canonicalStateLabel(raw.canonicalState),
    supportedSchema: Number.isSafeInteger(status.supportedSchema)
      ? status.supportedSchema
      : "Unknown",
    observedSchema: Number.isSafeInteger(status.observedSchema)
      ? status.observedSchema
      : "Not available",
    authoritative,
    authorityLabel: authoritative
      ? "This client is the active Game Master."
      : "Inspection only — the active Game Master must confirm recovery actions.",
    canMutate,
    mutationReason,
    candidates,
    hasCandidates: candidates.length > 0,
    snapshotAvailable,
    canRecoverSnapshot:
      snapshotAvailable && raw.canRecoverSnapshot === true && canMutate,
    snapshotReason: !authoritative
      ? mutationReason
      : snapshotAvailable
        ? raw.canRecoverSnapshot === true && canMutate
          ? "Ready for review."
          : raw.canRecoverSnapshot === true
            ? mutationReason
            : "The verified snapshot cannot be recovered in the current state."
        : "No verified snapshot is available on this client.",
    canCreateEmpty: raw.canCreateEmpty === true && canMutate,
    emptyReason: !authoritative
      ? mutationReason
      : raw.canCreateEmpty === true && canMutate
        ? "Ready for review."
        : raw.canCreateEmpty === true
          ? mutationReason
          : "An empty replacement is not available in the current state.",
    busy,
    message: String(uiState.message ?? "").trim(),
    messageTone: safeMessageTone(uiState.messageTone),
  };
}

async function runPrivateStateRecoveryAction(application, operation) {
  if (application._privateStateRecoveryInFlight) {
    notify("info", "a campaign-data action is already being checked.");
    return null;
  }
  application._privateStateRecoveryInFlight = true;
  try {
    assertRecoveryMutationAuthority();
    const result = await operation(application._privateStateRecoveryService);
    if (result?.ok === true) {
      application._privateStateRecoveryMessage =
        "Campaign data recovery completed and the selected store was verified.";
      application._privateStateRecoveryTone = "success";
      playModuleSound(SOUND_EVENTS.DEPOSIT);
      notify("info", "campaign data recovery completed and was verified.");
    } else {
      application._privateStateRecoveryMessage = "No campaign data changed.";
      application._privateStateRecoveryTone = "neutral";
    }
    return result ?? null;
  } catch (error) {
    console.warn(
      `${MODULE_ID} | campaign-data recovery action stopped (${safeRecoveryErrorCode(error)})`,
    );
    const message = recoveryActionErrorMessage(error);
    application._privateStateRecoveryMessage = message;
    application._privateStateRecoveryTone = "danger";
    notify("warn", message);
    return null;
  } finally {
    application._privateStateRecoveryInFlight = false;
    await application.render?.(false);
  }
}

function assertRecoveryMutationAuthority() {
  if (!isFullGM() || !isAuthoritativeGM()) {
    const error = new Error("PrivateStateRecoveryAuthorityChanged");
    error.code = "PRIVATE_STATE_RECOVERY_PREFLIGHT_AUTHORITY_CHANGED";
    throw error;
  }
}

export function buildCandidateAdoptionConfirmation(preview = {}) {
  const candidate = preview?.candidate ?? {};
  const candidateId = escapeHtml(String(candidate.id ?? "Unknown Journal"));
  const canonicalId = escapeHtml(
    String(preview?.canonicalId ?? "No selected store"),
  );
  return `<div class="infinity-dnd5e infinity-ui">
    <p>Make <strong>${candidateId}</strong> the selected campaign-data store?</p>
    <p>It will replace the current selection <strong>${canonicalId}</strong>. A supported older store will follow the normal migration path after selection.</p>
    <p><strong>Other Journals remain untouched.</strong> Nothing is deleted.</p>
  </div>`;
}

export function buildSnapshotRecoveryConfirmation(preview = {}) {
  const sourceId = escapeHtml(
    String(preview?.sourceId ?? "the last verified store"),
  );
  const canonicalId = escapeHtml(
    String(preview?.canonicalId ?? "No selected store"),
  );
  return `<div class="infinity-dnd5e infinity-ui">
    <p>Recover the last verified snapshot from <strong>${sourceId}</strong> into a new restricted store?</p>
    <p>The current selection is <strong>${canonicalId}</strong>. The service will re-check this review before changing it.</p>
    <p><strong>Old Journals remain untouched.</strong> Nothing is deleted or overwritten.</p>
  </div>`;
}

export function buildEmptyReplacementConfirmation(preview = {}) {
  const canonicalId = escapeHtml(
    String(preview?.canonicalId ?? "No selected store"),
  );
  return `<div class="infinity-dnd5e infinity-ui">
    <p>Create a new empty restricted store and replace the current selection <strong>${canonicalId}</strong>?</p>
    <p><strong>The new canonical store starts empty.</strong> Private merchant, faction, resource, downtime, and critical-injury data will not be copied into it.</p>
    <p>Old Journals remain untouched. Nothing is deleted or overwritten, but campaign tools will use the new empty store.</p>
  </div>`;
}

function recoveryReason(code, state) {
  const key = String(code ?? "").trim();
  if (PRIVATE_STATE_REASON_LABELS[key]) return PRIVATE_STATE_REASON_LABELS[key];
  if (state === "ready")
    return "The selected store passed its privacy and schema checks.";
  if (state === "blocked") {
    return "Campaign data could not be verified safely. Review the available recovery choices.";
  }
  return "Campaign data is still loading. Refresh this status after startup completes.";
}

function candidateReason(code) {
  const key = String(code ?? "").trim();
  return (
    CANDIDATE_REASON_LABELS[key] ??
    "This candidate cannot be adopted safely with the current module."
  );
}

function canonicalStateLabel(value) {
  const labels = {
    current: "Selected store verified",
    missing: "Selected store missing",
    resolved: "Selected store found",
    unset: "No selected store",
    unresolved: "Selected store unresolved",
    blocked: "Selected store blocked",
    none: "No selected store",
  };
  return labels[String(value ?? "").trim()] ?? "Selection not verified";
}

function recoverySchemaLabel(state, observed) {
  const label = {
    current: "Current schema",
    legacy: "Older schema",
    future: "Newer schema",
    invalid: "Invalid schema",
    missing: "Schema not recorded",
  }[String(state ?? "").trim()];
  return Number.isSafeInteger(observed)
    ? `${label ?? "Schema"} (${observed})`
    : (label ?? "Schema not available");
}

function recoveryPayloadLabel(state) {
  return (
    {
      complete: "Required fields complete",
      incomplete: "Required fields incomplete",
      invalid: "Required fields invalid",
      unknown: "Required fields not verified",
    }[String(state ?? "").trim()] ?? "Required fields not verified"
  );
}

function recoveryOwnershipLabel(state) {
  return (
    {
      private: "Restricted to full Game Masters",
      restricted: "Restricted to full Game Masters",
      unsafe: "Ownership is not private",
      unknown: "Ownership not verified",
    }[String(state ?? "").trim()] ?? "Ownership not verified"
  );
}

function formatRecoveryTimestamp(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return "Not recorded";
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(numeric));
  } catch {
    return "Recorded time unavailable";
  }
}

function safeMessageTone(value) {
  return ["neutral", "success", "danger", "warning"].includes(value)
    ? value
    : "neutral";
}

function recoveryActionErrorMessage(error) {
  const code = String(error?.code ?? "").trim();
  if (code === "PRIVATE_STATE_RECOVERY_PREFLIGHT_AUTHORITY_CHANGED") {
    return "Active Game Master control changed. Nothing was changed; review the current status again.";
  }
  if (code.includes("EXPIRED") || code.includes("STALE")) {
    return "That recovery review is no longer current. Nothing was changed; review it again.";
  }
  return "Could not confirm the recovery result. Review the current selection before trying another action.";
}

function safeRecoveryErrorCode(error) {
  const code = String(error?.code ?? "unknown")
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, 80);
  return code || "unknown";
}

/** Open the compatibility player launcher. Full-GM routing lives in bootstrap. */
export function openPlayerLauncher() {
  return InfinityDashboardApp.open();
}

export const openHub = openPlayerLauncher;

/** Build the fixed player/Assistant-GM destinations without campaign data. */
export function buildPlayerHomeActions(options = {}) {
  return PLAYER_HOME_DESTINATIONS.map((destination) => {
    const availability = getPlayerSurfaceAvailability(
      destination.surface,
      options,
    );
    return Object.freeze({
      id: `surface:${destination.surface}`,
      recentId: `surface:${destination.surface}`,
      launchId: destination.surface,
      launchKind: "surface",
      surface: destination.surface,
      title: PLAYER_SURFACE_LABELS[destination.surface] ?? destination.surface,
      description: destination.description,
      icon: destination.icon,
      intent: destination.intent,
      status: availability.available ? "available" : "unavailable",
      isAvailable: availability.available,
      isComingSoon: false,
      ariaDisabled: availability.available ? "false" : "true",
      statusDescriptionId: `infinity-home-status-surface-${destination.surface}`,
      statusLabel: availability.available ? "" : "Unavailable",
      statusReason: availability.reason,
    });
  });
}

/** Group launcher actions into the stable, task-oriented navigation model. */
export function groupHomeActionsByIntent(actions) {
  return HOME_INTENTS.map((intent) => ({
    ...intent,
    actions: actions.filter((action) => action.intent === intent.id),
  })).filter((group) => group.actions.length > 0);
}

/**
 * Compatibility helper for extensions that still request a recent destination.
 * wins, then an available in-session tool, then any other available tool.
 * This is presentation-only: it never probes campaign state or changes what
 * the player launcher is allowed to expose.
 */
export function resolveSessionFocus(actions = [], recentActions = []) {
  const available = actions.filter((action) => action?.isAvailable);
  const recent = recentActions.find((action) => action?.isAvailable);
  const inSession = available.find(
    (action) => action.intent === TOOL_INTENTS.RUN_SESSION,
  );
  const action = recent ?? inSession ?? available[0];
  if (!action) return null;

  const continuing = action === recent;
  return Object.freeze({
    ...action,
    label: continuing
      ? `Continue with ${action.title}`
      : `Open ${action.title}`,
    description: continuing
      ? "Resume a workspace you recently used. Its current state and next safe action stay inside that window."
      : "This is the next available destination for the current role. The launcher does not change campaign data.",
  });
}

/** Build the concise content opened by the player launcher Help button. */
export function buildHomeHelpDialogContent({ fullGm = false } = {}) {
  const steps = fullGm
    ? [
        "Prepare: set up merchants and supplies before play.",
        "Run the Session: open loot, downtime, or the calendar while play is moving.",
        "Track the Campaign: review lasting supplies, faction, and injury changes.",
      ]
    : [
        "Open any available destination; the launcher only shows player-safe tools.",
        "Unavailable cards explain what the GM needs to enable.",
        "Use a shortcut below to reopen a familiar window.",
      ];
  const stepMarkup = steps
    .map((step) => `<li>${escapeHtml(step)}</li>`)
    .join("");
  const shortcutMarkup = buildShortcuts({ fullGm })
    .map(
      ({ keys, label }) =>
        `<div><dt><kbd>${escapeHtml(keys)}</kbd></dt><dd>${escapeHtml(label)}</dd></div>`,
    )
    .join("");
  return `<div class="id-help-dialog">
    <p>Choose a destination in the launcher. Disabled cards explain what is needed without changing campaign data.</p>
    <ol>${stepMarkup}</ol>
    <h3>Keyboard shortcuts</h3>
    <dl class="id-help-dialog__shortcuts">${shortcutMarkup}</dl>
    <p>Restore dismissed workspace guides from Infinity Settings.</p>
  </div>`;
}

function normalizeRegisteredTool(tool) {
  return {
    ...tool,
    recentId: tool.id,
    launchId: tool.id,
    launchKind: "tool",
    isAvailable: tool.status === "available",
    isComingSoon: tool.status === "coming-soon",
    ariaDisabled: tool.status === "available" ? "false" : "true",
    statusDescriptionId: `infinity-home-status-tool-${tool.id}`,
    statusLabel: tool.status === "coming-soon" ? "Coming Soon" : "",
    statusReason:
      tool.status === "coming-soon"
        ? "This tool is planned for a later release."
        : "",
  };
}

function resolveRecentActions(actions) {
  const byId = new Map(actions.map((action) => [action.recentId, action]));
  return InfinityDashboardApp._recentToolIds
    .map((id) => byId.get(id))
    .filter((action) => action?.isAvailable)
    .slice(0, InfinityDashboardApp.RECENT_LIMIT);
}

function renderSettingsConfig(SettingsConfigClass) {
  const app = new SettingsConfigClass();
  let renderResult;
  try {
    renderResult = app.render({ force: true });
  } catch {
    renderResult = app.render(true);
  }
  if (typeof renderResult?.catch === "function") {
    renderResult.catch((error) => {
      console.warn(`${MODULE_ID} | SettingsConfig render failed`, error);
      globalThis.ui?.notifications?.info?.(
        "Open Game Settings, then Module Settings, to edit Infinity D&D5e options.",
      );
    });
  }
}

/** Close the player launcher when promotion makes the Workbench primary. */
function bindPlayerHomePromotionGuard(application) {
  const hooks = globalThis.Hooks;
  if (!application || typeof hooks?.on !== "function") return () => {};
  const eventName = "updateUser";
  let bound = true;
  const hookId = hooks.on(eventName, (user) => {
    if (
      !bound ||
      String(user?.id ?? "") !== String(globalThis.game?.user?.id ?? "") ||
      !isFullGM(user)
    ) {
      return;
    }
    void Promise.resolve(application.close?.()).catch((error) => {
      console.warn(
        `${MODULE_ID} | could not close the player launcher after role change`,
        error,
      );
    });
  });
  return () => {
    if (!bound) return;
    bound = false;
    hooks.off?.(eventName, hookId);
  };
}

function buildShortcuts({ fullGm }) {
  const shortcuts = [
    { keys: "Shift+I", label: "Open Infinity launcher" },
    { keys: "Shift+D", label: "Open Downtime Activities" },
    { keys: "Shift+O", label: "Open Shops" },
    { keys: "Shift+Q", label: "Open Party Supplies" },
    { keys: "Shift+R", label: "Open revealed Factions" },
    { keys: "Shift+J", label: "Open Critical Injuries" },
  ];
  if (fullGm) {
    shortcuts.push({
      keys: "Enter or R",
      label: "Generate while a loot form has focus",
    });
  }
  return shortcuts;
}

/** Legacy category grouping retained for dashboard context compatibility. */
function groupByCategory(tools) {
  const order = [];
  const buckets = new Map();
  for (const tool of tools) {
    if (!buckets.has(tool.category)) {
      buckets.set(tool.category, []);
      order.push(tool.category);
    }
    buckets.get(tool.category).push(normalizeRegisteredTool(tool));
  }
  return order.map((category) => ({
    category,
    label: prettyCategory(category),
    tools: buckets.get(category),
  }));
}
