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
import { openSingleton, applyVisualPrefs } from "./infinity-app.js";

const MODULE_ID = "infinity-dnd5e";
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/reputation-workspace.hbs`;
const FALLBACK_IMG = "icons/svg/mystery-man.svg";

/** Scroll panes whose position survives action re-renders. */
const SCROLL_TARGETS = [
  { key: "list", selector: ".rw-list" },
  { key: "edit", selector: ".rw-edit" },
];

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class ReputationWorkspaceApp extends HandlebarsApplicationMixin(
  ApplicationV2,
) {
  static _instance = null;

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
      raiseStanding: ReputationWorkspaceApp._onRaiseStanding,
      lowerStanding: ReputationWorkspaceApp._onLowerStanding,
      setStanding: ReputationWorkspaceApp._onSetStanding,
      logNote: ReputationWorkspaceApp._onLogNote,
      pickImage: ReputationWorkspaceApp._onPickImage,
      addCharacterNote: ReputationWorkspaceApp._onAddCharacterNote,
      removeCharacterNote: ReputationWorkspaceApp._onRemoveCharacterNote,
      save: ReputationWorkspaceApp._onSave,
      deleteFaction: ReputationWorkspaceApp._onDeleteFaction,
    },
  };

  static PARTS = {
    body: { template: TEMPLATE_PATH },
  };

  static open() {
    if (!globalThis.game?.user?.isGM) {
      ui.notifications?.warn(`${MODULE_ID}: Reputation Workspace is GM-only.`);
      return null;
    }
    playModuleSound(SOUND_EVENTS.UI_OPEN);
    return openSingleton(
      ReputationWorkspaceApp,
      () => new ReputationWorkspaceApp(),
    );
  }

  constructor(options = {}) {
    super(options);
    this._selectedId = null;
    this._scroll = null;
  }

  _onClose(options) {
    super._onClose?.(options);
    ReputationWorkspaceApp._instance = null;
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
      moduleId: MODULE_ID,
      hasFactions: factions.length > 0,
      total: factions.length,
      revealedCount: factions.filter((f) => f.revealed).length,
      factions: factionList,
      hasCharacters: characters.length > 0,
      selected: selected ? this._buildSelectedView(selected, characters) : null,
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
        const faction = findFaction(this._selectedId);
        if (!faction) return;
        await this._persist(updatePerCharacter(faction, rowId, patch));
      } catch (error) {
        console.warn(`${MODULE_ID} | per-character update failed`, error);
      }
    });
  }

  async _saveFromForm() {
    if (!this._selectedId) return;
    const form = this.element?.querySelector?.('[data-form="faction-edit"]');
    if (!form) return;
    const faction = findFaction(this._selectedId);
    if (!faction) return;
    const data = readFormFields(form);
    const next = normalizeFaction({
      ...faction,
      name: data.name ?? faction.name,
      category: data.category ?? faction.category,
      description: data.description ?? faction.description,
      gmNotes: data.gmNotes ?? faction.gmNotes,
      playerNote: data.playerNote ?? faction.playerNote,
      revealed: data.revealed === "on",
    });
    await upsertFaction(next);
  }

  /** Save a faction, push the player projection, and re-render. */
  async _persist(faction) {
    await upsertFaction(faction);
    broadcastReputationState();
    this.render(false);
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
      ui.notifications?.warn(`${MODULE_ID}: file picker unavailable.`);
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
    const faction = findFaction(this._selectedId);
    if (!faction) return;
    const characters = listCharacterActors();
    const next = addPerCharacter(faction, {
      actorId: characters[0]?.id ?? "",
      delta: 0,
      note: "",
    });
    await this._persist(next);
  }

  static async _onRemoveCharacterNote(_event, target) {
    if (!this._selectedId) return;
    const rowId = target?.dataset?.rowId;
    if (!rowId) return;
    const faction = findFaction(this._selectedId);
    if (!faction) return;
    playModuleSound(SOUND_EVENTS.ROSTER_REMOVE);
    await this._persist(removePerCharacter(faction, rowId));
  }

  static async _onSave() {
    try {
      await this._saveFromForm();
      broadcastReputationState();
      playModuleSound(SOUND_EVENTS.LOCK_TOGGLE);
      ui.notifications?.info(`${MODULE_ID}: faction saved.`);
    } catch (error) {
      console.error(`${MODULE_ID} | save failed`, error);
      ui.notifications?.error(`${MODULE_ID}: save failed. See console.`);
    }
  }

  static async _onDeleteFaction() {
    if (!this._selectedId) return;
    const faction = findFaction(this._selectedId);
    if (!faction) return;
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    const confirmed = DialogV2
      ? await DialogV2.confirm({
          window: {
            title: `Delete "${faction.name}"?`,
            icon: "fa-solid fa-trash",
          },
          content: `<p>This permanently removes <strong>${escapeHtml(faction.name)}</strong> and its reputation history. This can't be undone.</p>`,
          rejectClose: false,
        })
      : true;
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
 * on confirm, or null when cancelled / no dialog available proceeds with "".
 */
async function promptReason(title, hint) {
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (!DialogV2) return "";
  try {
    const value = await DialogV2.prompt({
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
  } catch {
    return null;
  }
}

/**
 * Prompt for an absolute standing value + optional reason. Returns
 * `{ value, reason }` on confirm, or null when cancelled.
 */
async function promptSetStanding(faction) {
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (!DialogV2) return null;
  const current = faction.standing;
  const options = [];
  for (let n = STANDING_MAX; n >= STANDING_MIN; n -= 1) {
    options.push(
      `<option value="${n}" ${n === current ? "selected" : ""}>${prettyStanding(n)}</option>`,
    );
  }
  try {
    const result = await DialogV2.prompt({
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
            <span>Reason (optional)</span>
            <textarea name="reason" rows="2" style="width:100%;" placeholder="Why the change?"></textarea>
          </label>
        </div>
      `,
      ok: {
        label: "Set",
        icon: "fa-solid fa-check",
        callback: (_event, button) => ({
          value: Number(button?.form?.elements?.value?.value ?? current),
          reason: String(button?.form?.elements?.reason?.value ?? "").trim(),
        }),
      },
      rejectClose: false,
    });
    return result ?? null;
  } catch {
    return null;
  }
}
