/** Use prepared D&D5e weapon attack data without invoking ammunition consumption. */
import { collectionValues } from "./items.js";
const values = collectionValues;
const has = (set, key) =>
  set?.has?.(key) || (Array.isArray(set) && set.includes(key));
export function huntingEquipmentOptions(actor) {
  const result = [];
  for (const weapon of values(actor?.items)) {
    if (
      weapon.type !== "weapon" ||
      Number(weapon.system?.quantity) < 1 ||
      !has(weapon.system?.properties, "amm")
    )
      continue;
    const activities = values(weapon.system?.activities).filter(
      (a) =>
        a.type === "attack" &&
        a.attack?.type?.value === "ranged" &&
        a.attack?.type?.classification === "weapon",
    );
    for (const activity of activities) {
      // System-prepared choices are authoritative for ammunition compatibility.
      const compatible = weapon.system?.ammunitionOptions;
      for (const ammo of values(actor.items)) {
        const subtype = weapon.system?.ammunition?.type;
        const matches = Array.isArray(compatible)
          ? compatible.some((o) => o.value === ammo.id)
          : Boolean(
              subtype &&
              ammo.system?.type?.value === "ammo" &&
              ammo.system?.type?.subtype === subtype,
            );
        if (
          !matches ||
          ammo.type !== "consumable" ||
          !Number.isInteger(ammo.system?.quantity) ||
          ammo.system.quantity < 1
        )
          continue;
        if (typeof activity.getAttackData !== "function") continue;
        result.push({
          id: `${weapon.id}:${activity.id ?? activity._id}:${ammo.id}`,
          label: `${weapon.name} — ${ammo.name} (${ammo.system.quantity})`,
          weapon,
          activity,
          ammo,
        });
      }
    }
  }
  return result;
}
export function requireHuntingEquipment(actor, targetId) {
  const option = huntingEquipmentOptions(actor).find((o) => o.id === targetId);
  if (!option)
    throw new Error(
      "Carry a usable ranged weapon and at least one compatible ammunition; choose the weapon and ammunition together.",
    );
  return option;
}
export async function rollHuntingAttack(actor, targetId, blockId) {
  const storage = globalThis.localStorage;
  if (!storage || !blockId)
    throw new Error(
      "Browser storage is required to preserve your one hunting shot.",
    );
  const key = `infinity-dnd5e.huntingShot.v1.${globalThis.game?.world?.id}.${globalThis.game?.user?.id}.${blockId}.${actor.id}`;
  const saved = storage.getItem(key);
  if (saved) {
    const receipt = JSON.parse(saved);
    if (receipt.targetId !== targetId || !receipt.attack)
      throw new Error(
        "The hunting shot was interrupted. Ask the GM to review it; do not roll again.",
      );
    return receipt.attack;
  }
  const { activity, ammo, weapon } = requireHuntingEquipment(actor, targetId);
  const { parts, data } = activity.getAttackData({
    ammunition: ammo.id,
    attackMode: weapon.system?.attackModes?.[0]?.value,
  });
  if (!Array.isArray(parts))
    throw new Error("This weapon cannot provide a hunting attack roll.");
  const pending = JSON.stringify({ targetId, attack: null });
  storage.setItem(key, pending);
  if (storage.getItem(key) !== pending)
    throw new Error(
      "The hunting shot cannot be saved. Check browser storage before rolling.",
    );
  const roll = await new globalThis.Roll(
    ["1d20", ...parts].join(" + "),
    data,
  ).evaluate();
  const natural = roll.dice
    ?.find((d) => d.faces === 20)
    ?.results?.find((r) => r.active !== false)?.result;
  if (!Number.isFinite(roll.total) || !Number.isInteger(natural))
    throw new Error("The hunting attack could not be read.");
  const attack = { total: roll.total, formula: roll.formula, natural };
  const serialized = JSON.stringify({ targetId, attack });
  storage.setItem(key, serialized);
  if (storage.getItem(key) !== serialized)
    throw new Error("The shot could not be saved. Ask the GM to review it.");
  // Inventory is consumed only by the GM's reviewed transaction, never by this roll.
  try {
    await roll.toMessage?.({
      flavor: `Hunting shot: ${weapon.name}`,
      speaker: globalThis.ChatMessage?.getSpeaker?.({ actor }),
    });
  } catch {
    /* the persisted roll is still authoritative */
  }
  return attack;
}
