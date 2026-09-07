/** Durable learned-spell reconciliation. Only the elected full GM writes. */
import { isAuthoritativeGM } from "../socket-authority.js";
import { onPrivateStateChanged } from "../private-state.js";
import { runWithActorMutex } from "../merchant/session-state.js";
import {
  createActorItemVerified,
  deleteActorItemVerified,
} from "../merchant/write-verification.js";
import { loadDowntimeWorkflowStore, updateSpellbookRecord } from "./store.js";
import { collectionValues } from "./items.js";
import {
  matchingLearnedSpell,
  SPELLBOOK_MODULE_ID as MODULE_ID,
} from "./spell-learning.js";

const marker = (item) => item?.flags?.[MODULE_ID]?.learnedSpell;
let registered = false;
let timer;
export function spellbookRecords(actorId = "") {
  return Object.values(loadDowntimeWorkflowStore().spellbooks ?? {}).filter(
    (record) =>
      record?.snapshot?.type === "spell" &&
      record.operationId &&
      (!actorId || record.actorId === actorId),
  );
}
function idle(actorId) {
  const block = loadDowntimeWorkflowStore().activeBlock;
  return (
    !block ||
    !["planned", "applying", "needs-review"].includes(block.state) ||
    !block.participants?.some(
      (participant) => participant.actorId === actorId && !participant.resolved,
    )
  );
}
export function spellbookIdentityMatches(actor, record) {
  const expected = marker(record.snapshot)?.ddbCharacterId;
  const actual = String(
    actor?.flags?.ddbimporter?.dndbeyond?.characterId ?? "",
  );
  return record.actorId === actor?.id && (!expected || expected === actual);
}
export function projectSpellbookNote(actor, record) {
  const spell = record.snapshot;
  const note = marker(spell);
  const matches = matchingLearnedSpell(actor, spell);
  const linked = spellbookIdentityMatches(actor, record);
  return {
    operationId: record.operationId,
    name: spell.name,
    level: spell.system.level,
    source: note.sourceName,
    book: note.bookName,
    date: note.dateLabel || `World time ${note.worldTime}`,
    status: record.forgotten
      ? "Forgotten — will not restore"
      : !linked
        ? "Character link needs review"
        : matches.length > 1
          ? "Duplicate spells — GM review needed"
          : matches.length
            ? "Present on sheet"
            : "Missing — restore available",
  };
}
async function mirrorNotes(actorId) {
  const actor = globalThis.game?.actors?.get(actorId);
  if (!actor?.setFlag || !isAuthoritativeGM()) return;
  const notes = spellbookRecords(actorId).map((record) =>
    projectSpellbookNote(actor, record),
  );
  if (
    JSON.stringify(actor.flags?.[MODULE_ID]?.wizardNotes ?? []) !==
    JSON.stringify(notes)
  )
    await actor.setFlag(MODULE_ID, "wizardNotes", notes);
}
export async function reconcileSpellbook(actorId = "") {
  if (!isAuthoritativeGM()) return [];
  const results = [];
  for (const record of spellbookRecords(actorId)) {
    if (record.forgotten) continue;
    const actor = globalThis.game?.actors?.get(record.actorId);
    if (!actor || !spellbookIdentityMatches(actor, record)) {
      results.push({
        operationId: record.operationId,
        status: "character-link-needs-review",
      });
      continue;
    }
    results.push(
      await runWithActorMutex(actor.id, async () => {
        const authorizeWrite = () =>
          isAuthoritativeGM() &&
          idle(actor.id) &&
          spellbookIdentityMatches(actor, record) &&
          spellbookRecords(actor.id).some(
            (r) => r.operationId === record.operationId && !r.forgotten,
          );
        if (!authorizeWrite())
          return { operationId: record.operationId, status: "deferred" };
        const matches = matchingLearnedSpell(actor, record.snapshot);
        if (matches.length)
          return {
            operationId: record.operationId,
            status:
              matches.length === 1 ? "retained" : "duplicate-needs-review",
          };
        const id = record.snapshot._id;
        if (actor.items.get(id))
          return {
            operationId: record.operationId,
            status: "item-id-conflict",
          };
        const result = await createActorItemVerified(actor, record.snapshot, {
          authorizeWrite,
        });
        const actual = actor.items.get(id);
        const verified =
          (result.ok || result.canonicalConfirmed) &&
          marker(actual)?.operationId === record.operationId;
        return {
          operationId: record.operationId,
          status: verified ? "restored" : "restore-needs-review",
        };
      }),
    );
  }
  for (const id of new Set(
    spellbookRecords(actorId).map((record) => record.actorId),
  ))
    await mirrorNotes(id);
  return results;
}
export async function forgetLearnedSpell(actorId, operationId) {
  if (!isAuthoritativeGM())
    throw new Error("The active full GM must forget a learned spell.");
  return runWithActorMutex(actorId, async () => {
    if (!idle(actorId))
      throw new Error(
        "Finish or recover this character's pending downtime before forgetting a spell.",
      );
    const record = spellbookRecords(actorId).find(
      (r) => r.operationId === operationId,
    );
    const actor = game.actors.get(actorId);
    if (!record || !actor || !spellbookIdentityMatches(actor, record))
      throw new Error("Character link needs GM review.");
    // Commit the tombstone first. A lost delete reply must never resurrect the spell.
    await updateSpellbookRecord(operationId, { forgotten: true });
    for (const item of collectionValues(actor.items).filter(
      (item) => marker(item)?.operationId === operationId,
    )) {
      const result = await deleteActorItemVerified(actor, item.id, {
        authorizeWrite: isAuthoritativeGM,
      });
      if (!result.ok && actor.items.get(item.id))
        throw new Error(
          "Protection is removed, but the spell could not be deleted. Retry Forget; a DDB-owned copy must be removed in DDB too.",
        );
    }
    await mirrorNotes(actorId);
    return true;
  });
}
export async function relinkSpellbook(operationId, actorId) {
  if (!isAuthoritativeGM())
    throw new Error("The active full GM must link the spellbook.");
  const record = spellbookRecords().find((r) => r.operationId === operationId);
  const actor = game.actors.get(actorId);
  const expected = marker(record?.snapshot)?.ddbCharacterId;
  if (
    !record ||
    !actor ||
    !expected ||
    expected !==
      String(actor.flags?.ddbimporter?.dndbeyond?.characterId ?? "") ||
    !idle(actorId) ||
    !idle(record.actorId)
  )
    throw new Error(
      "Link only to an idle character with the same DDB character ID.",
    );
  const lockIds = [...new Set([record.actorId, actorId])].sort();
  const link = async () => {
    const current = spellbookRecords().find(
      (r) => r.operationId === operationId,
    );
    if (
      !isAuthoritativeGM() ||
      current?.actorId !== record.actorId ||
      current.forgotten ||
      !idle(actorId) ||
      !idle(record.actorId) ||
      String(actor.flags?.ddbimporter?.dndbeyond?.characterId ?? "") !==
        expected
    )
      throw new Error(
        "The spellbook changed. Refresh before linking it again.",
      );
    await updateSpellbookRecord(operationId, { actorId });
    await mirrorNotes(record.actorId);
  };
  const lock = (index) =>
    index === lockIds.length
      ? link()
      : runWithActorMutex(lockIds[index], () => lock(index + 1));
  await lock(0);
  return reconcileSpellbook(actorId);
}
function schedule() {
  if (!isAuthoritativeGM()) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    void reconcileSpellbook()
      .then((results) => {
        if (
          results.some(
            (r) => r.status.includes("review") || r.status.includes("conflict"),
          )
        )
          ui.notifications.warn(
            "Wizard Notes: a spellbook needs GM review. Open Wizard Notes on the character sheet.",
          );
      })
      .catch((error) =>
        console.warn(`${MODULE_ID} | spellbook reconciliation`, error),
      );
  }, 1000);
}
export async function openWizardNotes(actor) {
  if (!actor || (!actor.isOwner && !game.user.isGM))
    throw new Error("Choose a character you own.");
  const { WizardNotesApp } = await import("./wizard-notes-app.js");
  return new WizardNotesApp(actor).render(true);
}
export function registerSpellbookHooks() {
  if (registered || !globalThis.Hooks?.on) return;
  registered = true;
  // This event fires on the importing client. An owner-written marker notifies
  // the elected GM without transmitting snapshots or trusting client spell data.
  Hooks.on("ddb-importer.characterProcessDataComplete", ({ actor } = {}) => {
    if (!actor?.isOwner) return;
    void actor
      .setFlag(MODULE_ID, "spellbookImportCompleted", Date.now())
      .catch((error) =>
        console.warn(`${MODULE_ID} | spellbook import signal`, error),
      );
  });
  Hooks.on("updateActor", (_actor, changes) => {
    if (
      changes?.flags?.[MODULE_ID]?.spellbookImportCompleted !== undefined ||
      changes?.[`flags.${MODULE_ID}.spellbookImportCompleted`] !== undefined
    )
      schedule();
  });
  Hooks.on("updateUser", schedule);
  onPrivateStateChanged(schedule);
  Hooks.on("getActorSheetHeaderButtons", (app, buttons) => {
    if (app.actor?.type !== "character" || !app.actor.isOwner) return;
    buttons.unshift({
      label: "Wizard Notes",
      class: "infinity-wizard-notes",
      icon: "fas fa-book-open",
      onclick: () => openWizardNotes(app.actor),
    });
  });
  Hooks.on("getHeaderControlsApplicationV2", (app, controls) => {
    if (app.actor?.type !== "character" || !app.actor.isOwner) return;
    controls.push({
      label: "Wizard Notes",
      icon: "fa-solid fa-book-open",
      action: "infinityWizardNotes",
      onClick: () => openWizardNotes(app.actor),
    });
  });
}
