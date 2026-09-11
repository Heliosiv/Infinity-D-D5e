/** Approved, durable training grants. Plans persist before Actor writes. */
import { isAuthoritativeGM } from "../socket-authority.js";
import { runWithActorMutex } from "../merchant/session-state.js";
import { createActorItemVerified } from "../merchant/write-verification.js";
import {
  loadDowntimeConfig,
  loadDowntimeWorkflowStore,
  saveTrainingAward,
} from "./store.js";
import { resolveItemSnapshot, collectionValues } from "./items.js";
import {
  trainingFieldState,
  trainingProgressComplete,
  validateTrainingProject,
} from "./training-rules.js";

const MODULE_ID = "infinity-dnd5e";
const marker = (item) => item?.flags?.[MODULE_ID]?.training;
const ddbId = (actor) =>
  String(actor?.flags?.ddbimporter?.dndbeyond?.characterId ?? "");
function authorize(actor, record) {
  const block = loadDowntimeWorkflowStore().activeBlock;
  return (
    isAuthoritativeGM() &&
    actor?.id === record.actorId &&
    (!record.ddbCharacterId || record.ddbCharacterId === ddbId(actor)) &&
    (!block ||
      !["planned", "applying", "needs-review"].includes(block.state) ||
      !block.participants?.some((p) => p.actorId === actor.id && !p.resolved))
  );
}
function matchingItem(actor, record) {
  return collectionValues(actor.items).find(
    (item) =>
      marker(item)?.projectId === record.projectId ||
      (record.reward.itemUuid &&
        (item._stats?.compendiumSource === record.reward.itemUuid ||
          item.flags?.core?.sourceId === record.reward.itemUuid)),
  );
}
function isPresent(actor, record) {
  return record.snapshot
    ? Boolean(matchingItem(actor, record))
    : trainingFieldState(actor, record.reward).present;
}
function containsExpected(actual, expected) {
  if (expected === null || typeof expected !== "object")
    return actual === expected;
  if (!actual || typeof actual !== "object") return false;
  return Object.entries(expected).every(
    ([key, value]) => key === "_stats" || containsExpected(actual[key], value),
  );
}
export function trainingAwardStatus(project) {
  const store = loadDowntimeWorkflowStore();
  const record = store.trainingAwards?.[project.id];
  const actor = globalThis.game?.actors?.get(project.actorId);
  if (record)
    return actor && isPresent(actor, record)
      ? "Learned — on character sheet"
      : "Approved — restore available";
  if (trainingProgressComplete(project, store))
    return project.reward && project.reward.kind !== "none"
      ? "Ready for GM approval"
      : "Completed";
  return "In progress";
}
async function deliver(record) {
  const actor = globalThis.game?.actors?.get(record.actorId);
  return runWithActorMutex(record.actorId, async () => {
    if (!authorize(actor, record))
      throw new Error(
        "Training cannot be delivered during resolution or to a changed character. Refresh when the character is idle.",
      );
    if (isPresent(actor, record))
      return { status: "retained", projectId: record.projectId };
    if (record.snapshot) {
      if (actor.items.get(record.snapshot._id))
        throw new Error(
          "Training item identity conflict. GM review is required.",
        );
      const result = await createActorItemVerified(actor, record.snapshot, {
        expectedQuantity: null,
        authorizeWrite: () => authorize(actor, record),
      });
      const actual = actor.items.get(record.snapshot._id);
      if (
        !result.ok ||
        !containsExpected(actual?.toObject?.() ?? actual, record.snapshot)
      )
        throw new Error(
          "The created training Item differs from its approved reward. GM review is required.",
        );
    } else {
      const field = trainingFieldState(actor, record.reward);
      await actor.update({ [field.path]: field.value });
    }
    if (!authorize(actor, record) || !isPresent(actor, record))
      throw new Error(
        "Training reward could not be verified. The approved plan is saved; use Approve / restore to retry safely.",
      );
    return { status: "delivered", projectId: record.projectId };
  });
}
export async function approveTrainingReward(projectId) {
  if (!isAuthoritativeGM())
    throw new Error("An active full GM must approve training.");
  const project = loadDowntimeConfig().guidedProjects.find(
    (p) => p.id === projectId,
  );
  if (!project || !project.reward || project.reward.kind === "none")
    throw new Error("This plan has no permanent training reward.");
  const actor = globalThis.game?.actors?.get(project.actorId);
  await validateTrainingProject(project, actor);
  const store = loadDowntimeWorkflowStore();
  if (!trainingProgressComplete(project, store))
    throw new Error(
      "Complete the required hours and successes before approving training.",
    );
  let record = store.trainingAwards?.[projectId];
  if (!record) {
    record = {
      version: 1,
      projectId,
      actorId: actor.id,
      ddbCharacterId: ddbId(actor),
      name: project.name,
      reward: project.reward,
      approvedBy: game.user.id,
      approvedAt: Date.now(),
    };
    if (["feat", "technique"].includes(project.reward.kind)) {
      const snapshot = structuredClone(
        project.reward.snapshot ??
          (await resolveItemSnapshot(project.reward.itemUuid)),
      );
      if (snapshot?.type !== "feat")
        throw new Error(
          "The reward must be a usable feat or technique stored as a feat Item.",
        );
      for (const key of ["id", "folder", "ownership", "sort", "_stats"])
        delete snapshot[key];
      snapshot._id = foundry.utils.randomID();
      snapshot.flags ??= {};
      snapshot.flags[MODULE_ID] = {
        ...snapshot.flags[MODULE_ID],
        training: { projectId, sourceUuid: project.reward.itemUuid },
      };
      record.snapshot = snapshot;
    }
    await saveTrainingAward(projectId, record);
  }
  return deliver(record);
}
export async function reconcileTraining(actorId = "") {
  if (!isAuthoritativeGM()) return [];
  const result = [];
  for (const record of Object.values(
    loadDowntimeWorkflowStore().trainingAwards ?? {},
  )) {
    if (actorId && record.actorId !== actorId) continue;
    const actor = globalThis.game?.actors?.get(record.actorId);
    if (authorize(actor, record)) result.push(await deliver(record));
  }
  return result;
}
let registered = false;
export function registerTrainingHooks() {
  if (registered || !globalThis.Hooks?.on) return;
  registered = true;
  // Import completion, rather than intermediate Actor/Item updates, avoids fighting an importer.
  Hooks.on("ddb-importer.characterProcessDataComplete", ({ actor } = {}) => {
    if (actor?.id)
      void reconcileTraining(actor.id).catch((error) =>
        console.warn(`${MODULE_ID} | training restore`, error),
      );
  });
}
