const MODULE_ID = "infinity-dnd5e";

/** Full-GM gate for privileged module applications and mutations. */
export function isFullGM(user = globalThis.game?.user) {
  if (!user?.isGM) return false;
  const fullRole = globalThis.CONST?.USER_ROLES?.GAMEMASTER;
  if (
    !Number.isFinite(Number(fullRole)) ||
    !Number.isFinite(Number(user.role))
  ) {
    return true;
  }
  return Number(user.role) >= Number(fullRole);
}

/** Run an action only for a full GM, with a consistent user-facing warning. */
export function runAsFullGM(
  action,
  message = "Only a Game Master can use that tool.",
) {
  if (!isFullGM()) {
    globalThis.ui?.notifications?.warn?.(`${MODULE_ID}: ${message}`);
    return null;
  }
  return action();
}
