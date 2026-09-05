import { isFullGM } from "../permissions.js";

/** Main party roster: the character selected in each player's configuration. */
export function isAssignedPlayerCharacter(actor, gameRef = globalThis.game) {
  if (actor?.type !== "character" || !actor.id) return false;
  const users =
    gameRef?.users?.contents ??
    gameRef?.users?.values?.() ??
    gameRef?.users ??
    [];
  return Array.from(users).some((user) => {
    if (!user || user.isGM || isFullGM(user)) return false;
    const id =
      typeof user.character === "string" ? user.character : user.character?.id;
    return String(id ?? "") === String(actor.id);
  });
}

/** The injury roster includes characters assigned to or owned by a non-GM. */
export function isPlayerOwnedCriticalInjuryActor(
  actor,
  gameRef = globalThis.game,
) {
  if (actor?.type !== "character") return false;
  const users =
    gameRef?.users?.contents ??
    gameRef?.users?.values?.() ??
    gameRef?.users ??
    [];
  return Array.from(users).some((user) => {
    if (!user || isFullGM(user)) return false;
    const characterId =
      typeof user.character === "string"
        ? user.character
        : String(user.character?.id ?? "");
    return (
      String(characterId ?? "") === String(actor.id ?? "") ||
      hasEffectiveOwnerPermission(actor, user.id)
    );
  });
}

export function hasEffectiveOwnerPermission(actor, userId) {
  const id = String(userId ?? "");
  if (!id) return false;
  const ownership = actor?.ownership ?? {};
  const level = Object.hasOwn(ownership, id)
    ? ownership[id]
    : ownership.default;
  const OWNER = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  return Number(level) >= Number(OWNER);
}
