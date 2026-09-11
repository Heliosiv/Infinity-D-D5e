/** Bounded permanent advancement; no arbitrary Actor paths or effect code. */
const KINDS = new Set([
  "none",
  "language",
  "tool",
  "skill",
  "feat",
  "technique",
]);
const clean = (v, max = 100) =>
  String(v ?? "")
    .trim()
    .slice(0, max);
export function normalizeTrainingReward(raw = {}) {
  return {
    kind: KINDS.has(raw?.kind) ? raw.kind : "none",
    key: clean(raw?.key),
    itemUuid: clean(raw?.itemUuid, 300),
    ...(raw?.snapshot ? { snapshot: structuredClone(raw.snapshot) } : {}),
  };
}
export function trainingTargetOptions(kind) {
  const config = globalThis.CONFIG?.DND5E ?? {};
  const table =
    kind === "skill"
      ? config.skills
      : kind === "tool"
        ? config.tools
        : config.languages;
  const options = [];
  const visit = (entries) => {
    for (const [id, value] of Object.entries(entries ?? {})) {
      if (value?.children) visit(value.children);
      else
        options.push({
          id,
          label:
            globalThis.game?.i18n?.localize?.(
              typeof value === "string" ? value : (value?.label ?? id),
            ) ??
            String(typeof value === "string" ? value : (value?.label ?? id)),
        });
    }
  };
  visit(table);
  return options;
}
export async function validateTrainingProject(project, actor) {
  if (project.scope === "personal" && actor?.type !== "character")
    throw new Error(
      "Choose the character who owns this personal training plan.",
    );
  const reward = project.reward ?? { kind: "none" };
  if (reward.kind === "none") return;
  if (project.scope !== "personal")
    throw new Error(
      "Permanent training rewards require a personal plan and one character.",
    );
  if (!project.prerequisites)
    throw new Error(
      "Record the prerequisites and instructor or study source; use 'None required' where appropriate.",
    );
  if (["skill", "tool", "language"].includes(reward.kind)) {
    if (!trainingTargetOptions(reward.kind).some((o) => o.id === reward.key))
      throw new Error(
        "Choose a supported training target from the suggestions.",
      );
  } else if (
    !/^(Item\.[A-Za-z0-9]+|Compendium\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.Item\.[A-Za-z0-9]+)$/.test(
      reward.itemUuid,
    )
  ) {
    throw new Error(
      "Choose a world or compendium feat Item for the permanent reward.",
    );
  }
}

export function trainingProgressComplete(project, store) {
  return (
    (store.projectProgress?.[project.id] ?? 0) >= project.requiredHours &&
    (store.projectSuccesses?.[project.id] ?? 0) >= project.requiredSuccesses
  );
}

/** Read only the narrow proficiency target; a later expertise value is retained. */
export function trainingFieldState(actor, reward) {
  if (reward.kind === "language") {
    const before = Array.from(actor.system?.traits?.languages?.value ?? []);
    return {
      path: "system.traits.languages.value",
      value: [...new Set([...before, reward.key])],
      present: before.includes(reward.key),
    };
  }
  const group = reward.kind === "skill" ? "skills" : "tools";
  const before = Number(actor.system?.[group]?.[reward.key]?.value ?? 0);
  return {
    path: `system.${group}.${reward.key}.value`,
    value: Math.max(1, before),
    present: before >= 1,
  };
}
