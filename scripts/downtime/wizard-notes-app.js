import { isAuthoritativeGM } from "../socket-authority.js";
import { confirmInfinityDialog } from "../dialog-contract.js";
import {
  spellbookRecords,
  reconcileSpellbook,
  forgetLearnedSpell,
  relinkSpellbook,
  spellbookIdentityMatches,
  projectSpellbookNote,
} from "./spellbook.js";
import { SPELLBOOK_MODULE_ID as MODULE_ID } from "./spell-learning.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
export class WizardNotesApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(actor) {
    super({ window: { title: `${actor.name} — Wizard Notes` } });
    this.actor = actor;
  }
  static DEFAULT_OPTIONS = {
    classes: ["infinity-dnd5e", "infinity-wizard-notes"],
    window: {
      title: "Wizard Notes",
      resizable: true,
      icon: "fa-solid fa-book-open",
    },
    position: { width: 580, height: "auto" },
    actions: {
      reconcile: WizardNotesApp.reconcile,
      forget: WizardNotesApp.forget,
      relink: WizardNotesApp.relink,
    },
  };
  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/wizard-notes.hbs` },
  };
  async _prepareContext() {
    if (!this.actor.isOwner && !game.user.isGM)
      throw new Error("You no longer own this character.");
    const gm = isAuthoritativeGM();
    if (!gm)
      return {
        gm: false,
        rows: (this.actor.flags?.[MODULE_ID]?.wizardNotes ?? []).map((row) => ({
          ...row,
          canForget: false,
          canRelink: false,
        })),
      };
    const ddbId = String(
      this.actor.flags?.ddbimporter?.dndbeyond?.characterId ?? "",
    );
    const records = spellbookRecords().filter(
      (r) =>
        r.actorId === this.actor.id ||
        (ddbId &&
          r.snapshot.flags?.[MODULE_ID]?.learnedSpell?.ddbCharacterId ===
            ddbId),
    );
    return {
      gm,
      rows: records.map((record) => {
        const linked = spellbookIdentityMatches(this.actor, record);
        return {
          ...projectSpellbookNote(this.actor, record),
          canForget: gm && linked,
          canRelink:
            gm &&
            !linked &&
            !record.forgotten &&
            record.actorId !== this.actor.id &&
            Boolean(ddbId),
        };
      }),
    };
  }
  static async reconcile() {
    await this.run(() => reconcileSpellbook(this.actor.id));
  }
  static async forget(_event, button) {
    if (!isAuthoritativeGM()) return;
    const yes = await confirmInfinityDialog({
      title: "Forget learned spell?",
      content:
        "Remove this downtime spell and stop restoring it after imports? The learning history is kept. If the spell is also on DDB, remove it there separately.",
      yes: { label: "Forget spell" },
    });
    if (yes)
      await this.run(() =>
        forgetLearnedSpell(this.actor.id, button.dataset.operationId),
      );
  }
  static async relink(_event, button) {
    if (!isAuthoritativeGM()) return;
    const yes = await confirmInfinityDialog({
      title: "Link recovered spellbook?",
      content:
        "Move this saved spell's protection to this character? Its DDB character ID must match. The old character will no longer receive automatic recovery for this entry.",
      yes: { label: "Link and restore" },
    });
    if (yes)
      await this.run(() =>
        relinkSpellbook(button.dataset.operationId, this.actor.id),
      );
  }
  async run(action) {
    try {
      await action();
      await this.render(false);
    } catch (error) {
      ui.notifications.error(error.message);
    }
  }
}
