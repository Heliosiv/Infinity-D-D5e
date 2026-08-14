/**
 * Infinity D&D5e — ReputationWorkspaceApp
 *
 * GM-only singleton window for tracking faction reputation. Factions live
 * in the FACTIONS world setting via `reputation/store.js`; this app is the
 * editor on top. The GM sees every faction the party has encountered, raises
 * or lowers each one's standing (with a logged reason), and reveals chosen
 * factions to players — every edit broadcasts so open player views refresh.
 */

import {
  addPerCharacter,
  adjustStanding,
  createBlankFaction,
  findFaction,
  loadFactions,
  removeFaction,
  removePerCharacter,
  setStanding,
  updateFaction,
  updatePerCharacter,
  upsertFaction,
} from "./reputation/store.js";
import {
  STANDING_MAX,
  STANDING_MIN,
  normalizeFaction,
  standingBand,
  standingTier,
} from "./reputation/standing.js";
import { broadcastReputationState } from "./reputation/socket.js";
import {
  captureScroll,
  restoreScroll,
  bindScrollTracking,
} from "./merchant/scroll.js";
import { wireBackgroundImageFallback } from "./loot/loot-app-shared.js";
import { prettyStanding, escapeHtml } from "./ui-util.js";
import { SOUND_EVENTS, playModuleSound } from "./audio.js";
import {
  applyVisualPrefs,
  bindFullGmWindowGuard,
  navigateToAppSection,
  openSingleton,
} from "./infinity-app.js";
import { GM_WORKBENCH_TEMPLATE_PATH, GmWorkbenchApp } from "./gm-workbench.js";
import { runAsFullGM } from "./permissions.js";
import {
  confirmInfinityDialog,
  promptInfinityDialog,
} from "./dialog-contract.js";

const MODULE_ID = "infinity-dnd5e";
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/reputation-workspace.hbs`;
const FALLBACK_IMG = "icons/svg/mystery-man.svg";

/** Scroll panes whose position survives action re-renders. */
const SCROLL_TARGETS = [
  { key: "list", selector: ".rw-list" },
  { key: "edit", selector: ".rw-edit" },
];

export class ReputationWorkspaceApp extends GmWorkbenchApp {
  static _instance = null;
  static WORKBENCH_ROUTE = "factions";

  static DEFAULT_OPTIONS = {
    id: "infinity-dnd5e-reputation-workspace",
    tag: "section",
    classes: ["infinity-dnd5e", "infinity-reputation-workspace"],
    window: {
      title: "Infinity D&D5e — Reputation & Factions",
      icon: "fa-solid fa-handshake",
      resizable: true,
    },
    position: { width: 940, height: 720 },
    actions: {
      newFaction: ReputationWorkspaceApp._onNewFaction,
      selectFaction: ReputationWorkspaceApp._onSelectFaction,
      changeStanding: ReputationWorkspaceApp._onChangeStanding,
      logNote: ReputationWorkspaceApp._onLogNote,
      pickImage: ReputationWorkspaceApp._onPickImage,
      addCharacterNote: ReputationWorkspaceApp._onAddCharacterNote,
      removeCharacterNote: ReputationWorkspaceApp._onRemoveCharacterNote,
      selectSection: navigateToAppSection,
      save: ReputationWorkspaceApp._onSave,
      deleteFaction: ReputationWorkspaceApp._onDeleteFaction,
      navigateGmWorkbench: GmWorkbenchApp._onNavigate,
      openGmWorkbenchUtility: GmWorkbenchApp._onOpenUtility,
    },
  };

  static PARTS = {
    workbench: { template: GM_WORKBENCH_TEMPLATE_PATH },
    body: { template: TEMPLATE_PATH },
  };

  static open(options = {}) {
    return runAsFullGM(() => {
      playModuleSound(SOUND_EVENTS.UI_OPEN);
      const app = openSingleton(
        ReputationWorkspaceApp,
        () => new ReputationWorkspaceApp(options),
      );
      if (options.workbench) app.setWorkbenchTarget(options.workbench);
      return app;
    }, "Reputation Workspace is available to full GMs only.");
  }

  constructor(options = {}) {
    super(options);
    this._unbindFullGmWindowGuard = bindFullGmWindowGuard(this);
    this._selectedId = String(options.workbench?.entityId ?? "").trim() || null;
    this._scroll = null;
    this._saveStatus = "All changes saved";
  }

  _onClose(options) {
    super._onClose?.(options);
    this._unbindFullGmWindowGuard?.();
    this._unbindFullGmWindowGuard = null;
    ReputationWorkspaceApp._instance = null;
  }

  _captureWorkbenchTarget() {
    return {
      route: ReputationWorkspaceApp.WORKBENCH_ROUTE,
      entityId: this._selectedId ?? "",
    };
  }

  _applyWorkbenchTarget(target) {
    if (target?.entityId) this._selectedId = target.entityId;
  }

  async _beforeWorkbenchNavigate() {
    if (!this._selectedId || !this.rendered) return true;
    await this._saveFromForm();
    return true;
  }

  /* -------------------- context -------------------- */

  async _prepareContext() {
    const factions = loadFactions();
    if (!this._selectedId && factions.length > 0) {
      this._selectedId = factions[0].id;
    }
    const selected = this._selectedId
      ? (factions.find((f) => f.id === this._selectedId) ?? null)
      : null;

    const factionList = factions.map((f) => ({
      id: f.id,
      name: f.name,
      img: f.img || FALLBACK_IMG,
      tier: standingTier(f.standing),
      band: standingBand(f.standing),
      standingLabel: prettyStanding(f.standing),
      revealed: f.revealed,
      selected: f.id === this._selectedId,
    }));

    const characters = listCharacterActors();

    return {
      workbench: this.prepareWorkbenchContext?.() ?? null,
      moduleId: MODULE_ID,
      hasFactions: factions.length > 0,
      total: factions.length,
      revealedCount: factions.filter((f) => f.revealed).length,
      factions: factionList,
      hasCharacters: characters.length > 0,
      selected: selected ? this._buildSelectedView(selected, characters) : null,
      saveStatus: this._saveStatus,
    };
  }

  _buildSelectedView(faction, characters) {
    const span = STANDING_MAX - STANDING_MIN;
    return {
      id: faction.id,
      name: faction.name,
      category: faction.category,
      description: faction.description,
      gmNotes: faction.gmNotes,
      playerNote: faction.playerNote,
      img: faction.img || FALLBACK_IMG,
      revealed: faction.revealed,
      standing: faction.standing,
      tier: standingTier(faction.standing),
      band: standingBand(faction.standing),
      standingLabel: prettyStanding(faction.standing),
      canRaise: faction.standing < STANDING_MAX,
      canLower: faction.standing > STANDING_MIN,
      meterPercent: Math.round(
        ((faction.standing - STANDING_MIN) / span) * 100,
      ),
      history: faction.history.map((entry) => formatHistoryEntry(entry)),
      hasHistory: faction.history.length > 0,
      perCharacter: faction.perCharacter.map((row) => ({
        id: row.id,
        actorId: row.actorId,
        delta: row.delta,
        note: row.note,
        unknownActor:
          Boolean(row.actorId) && !characters.some((c) => c.id === row.actorId),
        characterOptions: characters.map((c) => ({
          id: c.id,
          name: c.name,
          selected: c.id === row.actorId,
        })),
      })),
      hasPerCharacter: faction.perCharacter.length > 0,
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);

    applyVisualPrefs(this.element, "rw-");

    this._wireFormChange();
    this._wirePerCharacterInputs();

    const root = this.element;
    if (root) {
      wireBackgroundImageFallback(root, ".rw-list__art", FALLBACK_IMG);
      wireBackgroundImageFallback(root, ".rw-form__art", FALLBACK_IMG);
      bindScrollTracking(root, SCROLL_TARGETS, () => {
        this._scroll = captureScroll(root, SCROLL_TARGETS);
      });
      restoreScroll(root, SCROLL_TARGETS, this._scroll);
    }
  }

  /** Auto-save the scalar faction fields (name, category, notes, reveal) when
   *  the form changes. Standing is NOT a form field — it changes only via the
   *  Raise/Lower/Set buttons so every change is logged with a reason. */
  _wireFormChange() {
    const form = this.element?.querySelector?.('[data-form="faction-edit"]');
    if (!form) return;
    form.addEventListener("change", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const name = target.getAttribute?.("name");
      if (!name) return;
      // Per-character rows + action buttons own their own handlers.
      if (target.dataset?.action || target.dataset?.role) return;
      try {
        await this._saveFromForm();
        // Name, image, category, and the player note all feed the player
        // projection, so push every scalar save to open player views. We don't
        // re-render the workspace on text edits (it would steal focus mid-type);
        // the reveal checkbox is the exception — it flips the list badge.
        broadcastReputationState();
        if (name === "revealed") this.render(false);
      } catch (error) {
        console.warn(`${MODULE_ID} | faction auto-save failed`, error);
        ui.notifications?.error(
          "Faction changes were not saved. Review the fields and try again.",
        );
      }
    });
  }

  /** Per-character rows change on blur/select; a delegated `change` listener
   *  persists each edit (ApplicationV2 `data-action` dispatch is click-only). */
  _wirePerCharacterInputs() {
    const host = this.element?.querySelector?.("[data-perchar-rows]");
    if (!host) return;
    host.addEventListener("change", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const role = target.dataset?.role;
      const rowId = target.dataset?.rowId;
      if (!role || !rowId) return;
      event.stopPropagation();
      const patch = {};
      if (role === "pcActor") patch.actorId = target.value;
      else if (role === "pcDelta") patch.delta = Number(target.value) || 0;
      else if (role === "pcNote") patch.note = target.value;
      else return;
      try {
        await this._persistMutation((faction) =>
          updatePerCharacter(faction, rowId, patch),
        );
      } catch (error) {
        console.warn(`${MODULE_ID} | per-character update failed`, error);
        this._setSaveStatus("Save failed — retry");
        ui.notifications?.error(
          "Character reputation was not saved. Review the value and reason, then try again.",
        );
      }
    });
  }

  async _saveFromForm() {
    if (!this._selectedId) return;
    const form = this.element?.querySelector?.('[data-form="faction-edit"]');
    if (!form) return;
    const data = readFormFields(form);
    this._setSaveStatus("Saving…");
    try {
      const faction = await updateFaction(this._selectedId, (current) =>
        normalizeFaction({
          ...current,
          name: data.name ?? current.name,
          category: data.category ?? current.category,
          img: data.img ?? current.img,
          description: data.description ?? current.description,
          gmNotes: data.gmNotes ?? current.gmNotes,
          playerNote: data.playerNote ?? current.playerNote,
          revealed: data.revealed === "on",
        }),
      );
      if (!faction) {
        this._setSaveStatus("Faction no longer available");
        return;
      }
      this._setSaveStatus("Saved");
    } catch (error) {
      this._setSaveStatus("Save failed — retry");
      throw error;
    }
  }

  _setSaveStatus(message) {
    this._saveStatus = String(message || "");
    const status = this.element?.querySelector?.("[data-save-status]");
    if (status) status.textContent = this._saveStatus;
  }

  /** Mutate the freshest faction, push the player projection, and re-render. */
  async _persistMutation(mutation) {
    if (!this._selectedId) return null;
    this._setSaveStatus("Saving…");
    try {
      const faction = await updateFaction(this._selectedId, mutation);
      if (!faction) {
        this._setSaveStatus("Faction no longer available");
        return null;
      }
      this._setSaveStatus("Saved");
      broadcastReputationState();
      this.render(false);
      return faction;
    } catch (error) {
      this._setSaveStatus("Save failed — retry");
      throw error;
    }
  }

  /* -------------------- actions -------------------- */

  static async _onNewFaction() {
    const blank = createBlankFaction();
    await upsertFaction(blank);
    this._selectedId = blank.id;
    playModuleSound(SOUND_EVENTS.PRESET_APPLY);
    broadcastReputationState();
    this.render(false);
  }

  static _onSelectFaction(_event, target) {
    const id = target?.dataset?.factionId;
    if (!id) return;
    this._selectedId = id;
    playModuleSound(SOUND_EVENTS.ITEM_OPEN);
    this.render(false);
  }

  static async _onRaiseStanding() {
    return this._changeStanding(+1);
  }

  static async _onLowerStanding() {
    return this._changeStanding(-1);
  }

  /** Shared Raise/Lower path: prompt for an optional reason, then log it. */
  async _changeStanding(delta) {
    if (!this._selectedId) return;
    const faction = findFaction(this._selectedId);
    if (!faction) return;
    const verb = delta > 0 ? "Raise" : "Lower";
    const reason = await promptReason(
      `${verb} standing — ${faction.name}`,
      delta > 0
        ? "What did the party do to earn this? (optional)"
        : "What did the party do to lose standing? (optional)",
    );
    if (reason === null) return; // cancelled
    await adjustStanding(this._selectedId, delta, {
      reason,
      by: gmName(),
    });
    playModuleSound(
      delta > 0 ? SOUND_EVENTS.ROLL_START : SOUND_EVENTS.LOCK_TOGGLE,
    );
    broadcastReputationState();
    this.render(false);
  }

  static async _onSetStanding() {
    if (!this._selectedId) return;
    const faction = findFaction(this._selectedId);
    if (!faction) return;
    const result = await promptSetStanding(faction);
    if (!result) return; // cancelled
    await setStanding(this._selectedId, result.value, {
      reason: result.reason,
      by: gmName(),
    });
    playModuleSound(SOUND_EVENTS.PRESET_APPLY);
    broadcastReputationState();
    this.render(false);
  }

  /**
   * Accessible inline standing-change flow. The existing authoritative
   * setStanding store path remains the only write; this layer merely requires
   * an explicit new value and a non-empty reason before calling it.
   */
  static async _onChangeStanding(_event, target) {
    if (!this._selectedId) return;
    const faction = findFaction(this._selectedId);
    if (!faction) return;
    const host =
      target?.closest?.("[data-standing-change]") ??
      this.element?.querySelector?.("[data-standing-change]");
    const valueControl = host?.querySelector?.(
      '[data-role="standing-change-value"]',
    );
    const reasonControl = host?.querySelector?.(
      '[data-role="standing-change-reason"]',
    );
    const rawValue = String(valueControl?.value ?? "").trim();
    const value = Number(rawValue);
    const reason = String(reasonControl?.value ?? "").trim();

    if (
      !rawValue ||
      !Number.isInteger(value) ||
      value < STANDING_MIN ||
      value > STANDING_MAX
    ) {
      valueControl?.setAttribute?.("aria-invalid", "true");
      valueControl?.focus?.();
      ui.notifications?.warn("Choose a valid standing value.");
      return;
    }
    valueControl?.removeAttribute?.("aria-invalid");

    if (value === faction.standing) {
      valueControl?.setAttribute?.("aria-invalid", "true");
      valueControl?.focus?.();
      ui.notifications?.warn("Choose a different standing value.");
      return;
    }

    if (!reason) {
      reasonControl?.setAttribute?.("aria-invalid", "true");
      reasonControl?.focus?.();
      ui.notifications?.warn("Enter a reason for the standing change.");
      return;
    }
    reasonControl?.removeAttribute?.("aria-invalid");

    await setStanding(this._selectedId, value, {
      reason,
      by: gmName(),
    });
    playModuleSound(SOUND_EVENTS.PRESET_APPLY);
    broadcastReputationState();
    this.render(false);
  }

  /** Log a note against the faction without changing its standing (delta 0). */
  static async _onLogNote() {
    if (!this._selectedId) return;
    const faction = findFaction(this._selectedId);
    if (!faction) return;
    const reason = await promptReason(
      `Log a note — ${faction.name}`,
      "Record something about this faction (no standing change).",
    );
    if (!reason) return; // cancelled or empty — nothing to log
    await adjustStanding(this._selectedId, 0, { reason, by: gmName() });
    playModuleSound(SOUND_EVENTS.LOCK_TOGGLE);
    this.render(false);
  }

  static async _onPickImage() {
    const input = this.element?.querySelector?.('input[name="img"]');
    const FP =
      foundry?.applications?.apps?.FilePicker?.implementation ??
      globalThis.FilePicker;
    if (!FP) {
      ui.notifications?.warn(
        "The image picker could not open. Nothing changed; enter an image path manually or reload Foundry and try again.",
      );
      return;
    }
    const picker = new FP({
      type: "image",
      current: input?.value || "",
      callback: async (path) => {
        if (input) input.value = path;
        try {
          await this._saveFromForm();
        } catch {}
        broadcastReputationState();
        this.render(false);
      },
    });
    picker.render(true);
  }

  static async _onAddCharacterNote() {
    if (!this._selectedId) return;
    const characters = listCharacterActors();
    await this._persistMutation((faction) =>
      addPerCharacter(faction, {
        actorId: characters[0]?.id ?? "",
        delta: 0,
        note: "",
      }),
    );
  }

  static async _onRemoveCharacterNote(_event, target) {
    if (!this._selectedId) return;
    const rowId = target?.dataset?.rowId;
    if (!rowId) return;
    playModuleSound(SOUND_EVENTS.ROSTER_REMOVE);
    await this._persistMutation((faction) =>
      removePerCharacter(faction, rowId),
    );
  }

  static async _onSave() {
    try {
      await this._saveFromForm();
      broadcastReputationState();
      playModuleSound(SOUND_EVENTS.LOCK_TOGGLE);
      ui.notifications?.info("Faction saved.");
    } catch (error) {
      console.error(`${MODULE_ID} | save failed`, error);
      ui.notifications?.error(
        "The faction was not saved. Review the faction fields and try again; if it keeps failing, share this exact status message with the GM.",
      );
    }
  }

  static async _onDeleteFaction() {
    if (!this._selectedId) return;
    const faction = findFaction(this._selectedId);
    if (!faction) return;
    const confirmed = await confirmInfinityDialog({
      window: {
        title: `Delete "${faction.name}"?`,
        icon: "fa-solid fa-trash",
      },
      content: `<p>This permanently removes <strong>${escapeHtml(faction.name)}</strong> and its reputation history. This can't be undone.</p>`,
      rejectClose: false,
    });
    if (!confirmed) return;
    await removeFaction(this._selectedId);
    this._selectedId = null;
    playModuleSound(SOUND_EVENTS.CLEAR_RESET);
    broadcastReputationState();
    this.render(false);
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Character actors the GM can attach per-character notes to. */
function listCharacterActors() {
  const actors = globalThis.game?.actors;
  if (!actors) return [];
  return actors
    .filter((a) => a?.type === "character")
    .map((a) => ({ id: a.id, name: a.name }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function gmName() {
  return globalThis.game?.user?.name ?? "GM";
}

/** Shape a stored history entry for display. */
function formatHistoryEntry(entry) {
  const delta = Number(entry.delta) || 0;
  return {
    id: entry.id,
    reason: entry.reason,
    by: entry.by,
    when: formatWhen(entry.at),
    deltaLabel:
      delta > 0 ? `+${delta}` : delta < 0 ? `−${Math.abs(delta)}` : "note",
    deltaTone: delta > 0 ? "up" : delta < 0 ? "down" : "flat",
    swing: `${standingTier(entry.fromStanding)} → ${standingTier(entry.toStanding)}`,
    changed: entry.fromStanding !== entry.toStanding,
  };
}

function formatWhen(at) {
  const ms = Number(at);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return "";
  }
}

/** Read top-level form fields into a plain object (single-value fields). */
function readFormFields(form) {
  const formData = new FormData(form);
  const out = {};
  for (const [key, value] of formData.entries()) {
    if (key in out) continue; // top-level fields are single-valued
    out[key] = value;
  }
  return out;
}

/**
 * Prompt for a free-text reason. Returns the trimmed string (possibly empty)
 * on confirm, or null when cancelled or no dialog is available.
 */
async function promptReason(title, hint) {
  const value = await promptInfinityDialog({
    window: { title, icon: "fa-solid fa-feather" },
    content: `
        <div class="rw-prompt">
          <p class="rw-prompt__hint">${escapeHtml(hint)}</p>
          <textarea name="reason" rows="3" style="width:100%;" placeholder="e.g. Recovered the stolen relic"></textarea>
        </div>
      `,
    ok: {
      label: "Log",
      icon: "fa-solid fa-check",
      callback: (_event, button) =>
        String(button?.form?.elements?.reason?.value ?? "").trim(),
    },
    rejectClose: false,
  });
  return value ?? null;
}

/**
 * Prompt for an absolute standing value + required reason. Returns
 * `{ value, reason }` on confirm, or null when cancelled.
 */
async function promptSetStanding(faction) {
  const current = faction.standing;
  const options = [];
  for (let n = STANDING_MAX; n >= STANDING_MIN; n -= 1) {
    options.push(
      `<option value="${n}" ${n === current ? "selected" : ""}>${prettyStanding(n)}</option>`,
    );
  }
  const result = await promptInfinityDialog({
    window: {
      title: `Set standing — ${faction.name}`,
      icon: "fa-solid fa-sliders",
    },
    content: `
        <div class="rw-prompt" style="display:grid;gap:8px;">
          <label style="display:grid;gap:4px;">
            <span>Standing</span>
            <select name="value">${options.join("")}</select>
          </label>
          <label style="display:grid;gap:4px;">
            <span>Reason</span>
            <textarea name="reason" rows="2" style="width:100%;" required aria-required="true" placeholder="Why is the standing changing?"></textarea>
          </label>
        </div>
      `,
    ok: {
      label: "Set",
      icon: "fa-solid fa-check",
      callback: (_event, button) => {
        const reason = String(
          button?.form?.elements?.reason?.value ?? "",
        ).trim();
        if (!reason) {
          ui.notifications?.warn("Enter a reason for the standing change.");
          return null;
        }
        return {
          value: Number(button?.form?.elements?.value?.value ?? current),
          reason,
        };
      },
    },
    rejectClose: false,
  });
  return result ?? null;
}
