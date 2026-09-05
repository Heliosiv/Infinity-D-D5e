/** A local canvas badge; never changes token art, conditions or document data. */
import { isFullGM } from "../permissions.js";
import { SETTING_KEYS, getSetting } from "../settings.js";
import {
  hasEffectiveOwnerPermission,
  isPlayerOwnedCriticalInjuryActor,
} from "./actors.js";
import {
  getActorCriticalInjuryEffects,
  getCriticalInjuryData,
} from "./effects.js";
import { CriticalInjuryApp } from "./injury-app.js";
import { getStandaloneRecordedInjuryRows } from "./recorded-injuries.js";

const badges = new Map();
let registered = false;

export function tokenInjuryBadgeData(token) {
  const actor = token?.actor;
  const user = globalThis.game?.user;
  const assignedId =
    typeof user?.character === "string" ? user.character : user?.character?.id;
  if (
    !actor ||
    token.document?.actorLink === false ||
    getSetting(SETTING_KEYS.CRITICAL_INJURIES_ENABLED) === false ||
    !isPlayerOwnedCriticalInjuryActor(actor) ||
    (!isFullGM(user) &&
      assignedId !== actor.id &&
      !hasEffectiveOwnerPermission(actor, user?.id))
  )
    return null;
  const injuries = getActorCriticalInjuryEffects(actor).map(
    getCriticalInjuryData,
  );
  const records = getStandaloneRecordedInjuryRows(actor).filter(
    (record) => record.status !== "recovered",
  );
  const labels = [
    ...injuries.map((injury) => injury.injuryName),
    ...records.map(
      (record) =>
        `${record.name} (${record.status === "review" ? "needs review" : record.status})`,
    ),
  ];
  if (!labels.length) return null;
  return {
    actorId: actor.id,
    count: labels.length,
    label: `${actor.name}: ${labels.length} injuries or records to review. ${labels.join(", ")}. Click to view and treat.`,
  };
}

export function refreshTokenInjuryBadge(token) {
  const data = tokenInjuryBadgeData(token);
  if (!data || token?.destroyed) {
    removeTokenInjuryBadge(token);
    return;
  }
  const pixi = globalThis.PIXI;
  if (!pixi?.Container || !pixi?.Graphics || !pixi?.Text) return;
  let badge = badges.get(token);
  if (badge?.destroyed || badge?.parent !== token) {
    removeTokenInjuryBadge(token);
    badge = null;
  }
  if (!badge) {
    badge = new pixi.Container();
    badge.name = "infinity-injury-badge";
    badge.eventMode = "static";
    badge.cursor = "pointer";
    badge.zIndex = 100;
    badge._previousInteractiveChildren = token.interactiveChildren;
    token.interactiveChildren = true;
    badge.addChild(new pixi.Graphics());
    badge.addChild(
      new pixi.Text("", {
        fontFamily: "Arial",
        fontSize: 18,
        fontWeight: "bold",
        fill: 0xffffff,
      }),
    );
    badge.on("pointerdown", (event) => event.stopPropagation?.());
    badge.on("pointertap", (event) => {
      event.stopPropagation?.();
      const current = tokenInjuryBadgeData(token);
      if (current) CriticalInjuryApp.open({ actorId: current.actorId });
    });
    token.addChild(badge);
    badges.set(token, badge);
  }
  const width = Math.max(32, Math.min(64, Number(token.w || 100) * 0.52));
  const height = Math.max(24, Math.min(34, Number(token.h || 100) * 0.28));
  badge.visible = token.visible !== false;
  const signature = `${data.label}:${width}:${height}:${token.w}:${token.h}`;
  if (badge._injurySignature === signature) return;
  badge._injurySignature = signature;
  const [background, label] = badge.children;
  background
    .clear()
    .lineStyle(2, 0xffd5d5, 1)
    .beginFill(0x8f2838, 0.98)
    .drawRoundedRect(0, 0, width, height, 7)
    .endFill();
  label.text = `! ${data.count}`;
  label.style.fontSize = Math.round(height * 0.58);
  label.anchor.set(0.5);
  label.position.set(width / 2, height / 2);
  badge.position.set(
    Math.max(0, Number(token.w || 100) - width - 2),
    Math.max(0, Number(token.h || 100) - height - 2),
  );
  badge.hitArea = new pixi.Rectangle(0, 0, width, height);
  badge.accessible = true;
  badge.accessibleTitle = data.label;
  badge.accessibleHint = "Open character injuries";
  badge.accessibleType = "button";
  badge.tabIndex = 0;
  badge.visible = token.visible !== false;
}

export function removeTokenInjuryBadge(token) {
  const badge = badges.get(token);
  badges.delete(token);
  if (badge && token.interactiveChildren === true)
    token.interactiveChildren = badge._previousInteractiveChildren;
  if (badge && !badge.destroyed) {
    badge.parent?.removeChild?.(badge);
    badge.destroy({ children: true });
  }
}

export function registerCriticalInjuryTokenBadges() {
  if (registered || !globalThis.Hooks?.on) return;
  registered = true;
  const refreshAll = () => {
    for (const token of globalThis.canvas?.tokens?.placeables ?? [])
      refreshTokenInjuryBadge(token);
  };
  const refreshActor = (actor) => {
    for (const token of globalThis.canvas?.tokens?.placeables ?? []) {
      if (token.actor?.id === actor?.id) refreshTokenInjuryBadge(token);
    }
  };
  Hooks.on("drawToken", refreshTokenInjuryBadge);
  Hooks.on("refreshToken", refreshTokenInjuryBadge);
  Hooks.on("destroyToken", removeTokenInjuryBadge);
  Hooks.on("canvasReady", refreshAll);
  Hooks.on("canvasTearDown", () => {
    for (const token of badges.keys()) removeTokenInjuryBadge(token);
  });
  for (const hook of [
    "createActiveEffect",
    "updateActiveEffect",
    "deleteActiveEffect",
  ])
    Hooks.on(hook, (effect) => refreshActor(effect.parent));
  Hooks.on("updateActor", refreshActor);
  Hooks.on("updateUser", refreshAll);
  Hooks.on("updateSetting", (setting) => {
    if (
      String(setting?.key ?? "") ===
      `infinity-dnd5e.${SETTING_KEYS.CRITICAL_INJURIES_ENABLED}`
    )
      refreshAll();
  });
  refreshAll();
}
