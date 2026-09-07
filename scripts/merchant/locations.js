/** Location-first shop setup and atomic stock/purse operations. */
import {
  clearInventory,
  createBlankMerchant,
  loadMerchants,
  normalizeMerchant,
  resetMerchantPurse,
  restockAll,
  shopSetup,
} from "./store.js";
import { rollMerchantStock } from "./pool.js";
import {
  addMerchantLocation,
  loadMerchantAccessState,
  saveMerchantAccessState,
} from "./global-access.js";
import {
  commitMerchantBatch,
  pushMerchantAccessRefresh,
  runMerchantAccessOperation,
} from "./socket.js";

export const SHOP_TEMPLATES = Object.freeze([
  {
    id: "general",
    name: "Sundries & General Goods",
    types: ["loot.equipment", "loot.container", "loot.tool", "loot.ammunition"],
  },
  {
    id: "smith",
    name: "Weapons & Armour",
    types: ["loot.weapon.mundane", "loot.armor.mundane", "loot.ammunition"],
  },
  { id: "herbalist", name: "Herbalist & Apothecary", types: ["loot.reagent"] },
  { id: "potions", name: "Potions", types: ["loot.potion"] },
  {
    id: "outfitter",
    name: "Tools & Outfitters",
    types: ["loot.tool", "loot.equipment"],
  },
  {
    id: "arcane",
    name: "Arcane Supplies",
    types: ["loot.equipment.magic", "loot.scroll"],
  },
  {
    id: "jeweller",
    name: "Jeweller & Fine Goods",
    types: ["loot.gem", "loot.art"],
  },
  { id: "custom", name: "Custom Merchant", types: [] },
]);

export const LOCATION_TEMPLATES = Object.freeze([
  {
    id: "village",
    name: "Village — 3 everyday shops",
    shops: ["general", "smith", "herbalist"],
    count: 8,
    gold: 250,
    maxGp: 100,
    rarities: ["common", "uncommon"],
  },
  {
    id: "town",
    name: "Town — 5 shops",
    shops: ["general", "smith", "herbalist", "potions", "outfitter"],
    count: 12,
    gold: 1000,
    maxGp: 1000,
    rarities: ["common", "uncommon"],
  },
  {
    id: "city",
    name: "City — 7 shops, including magic & fine goods",
    shops: [
      "general",
      "smith",
      "herbalist",
      "potions",
      "outfitter",
      "arcane",
      "jeweller",
    ],
    count: 16,
    gold: 5000,
    maxGp: 5000,
    rarities: ["common", "uncommon", "rare"],
  },
  { id: "empty", name: "Empty location — add your own shops", shops: [] },
]);

export function locationDirectory(
  merchants = loadMerchants(),
  access = loadMerchantAccessState(),
) {
  const locations = [...(access.locations ?? [])];
  // Keep merchants accessible even if an imported location catalogue is missing.
  for (const merchant of merchants) {
    const id = merchant.shop?.locationId ?? "";
    if (id && !locations.some((location) => location.id === id)) {
      locations.push({ id, name: "Imported location" });
    }
  }
  if (merchants.some((merchant) => !merchant.shop?.locationId))
    locations.unshift({ id: "", name: "Unassigned shops" });
  return locations.map((location) => {
    const shops = merchants.filter(
      (merchant) => (merchant.shop?.locationId ?? "") === location.id,
    );
    const openCount = access.closed
      ? 0
      : shops.filter(
          (merchant) =>
            shopSetup(merchant).open && merchant.selfServiceMode !== "off",
        ).length;
    return {
      ...location,
      count: shops.length,
      openCount,
      status: !openCount
        ? "Closed"
        : openCount === shops.length
          ? "Open"
          : "Partly open",
    };
  });
}

export function templateMerchant(
  templateId,
  locationId,
  { scale = "town" } = {},
) {
  const template = SHOP_TEMPLATES.find((row) => row.id === templateId);
  const size =
    LOCATION_TEMPLATES.find((row) => row.id === scale && row.gold) ??
    LOCATION_TEMPLATES[1];
  if (!template) throw new Error("Choose a shop template.");
  return createBlankMerchant({
    name: template.name,
    goldOnHand: size.gold,
    selfServiceMode: "open",
    passiveHaggle: false,
    shop: {
      locationId,
      templateId,
      startingGold: size.gold,
      open: false,
      access: "all",
    },
    pool: {
      lootTypes: template.types,
      rarities: size.rarities,
      count: size.count,
      maxGp: size.maxGp,
    },
  });
}

export function createShopLocation(options) {
  return runMerchantAccessOperation(() => createShopLocationLocked(options));
}

export function addShopToLocation(options) {
  return runMerchantAccessOperation(() => addShopToLocationLocked(options));
}

async function createShopLocationLocked({
  name,
  templateId = "town",
  items = [],
}) {
  const label = String(name ?? "")
    .trim()
    .slice(0, 100);
  if (!label) throw new Error("Enter a city or location name.");
  const template = LOCATION_TEMPLATES.find((row) => row.id === templateId);
  if (!template) throw new Error("Choose a location template.");
  const id = globalThis.crypto.randomUUID();
  const shops = template.shops.map((key) =>
    generateShop(templateMerchant(key, id, { scale: templateId }), items),
  );
  // Generate everything before saving, so an unavailable library cannot erase stock.
  await addMerchantLocation({ id, name: label });
  if (shops.length)
    await commitMerchantBatch([], (current) => [...current, ...shops]);
  return { id, name: label, count: shops.length };
}

async function addShopToLocationLocked({ locationId, templateId, items = [] }) {
  if (
    locationId &&
    !locationDirectory().some((location) => location.id === locationId)
  )
    throw new Error("This location no longer exists.");
  const merchant = templateMerchant(templateId, locationId);
  const next =
    templateId === "custom" ? merchant : generateShop(merchant, items);
  await commitMerchantBatch([], (current) => [...current, next]);
  return next;
}

function generateShop(merchant, items) {
  const result = rollMerchantStock(merchant.pool, items);
  if (!result.rows.length)
    throw new Error(
      `${merchant.name}: no library items match its stock settings. No inventories were changed.`,
    );
  return resetMerchantPurse({ ...merchant, items: result.rows });
}

/** Membership is rechecked after prompts and library loading; one write for all. */
export function applyLocationOperation({
  locationId,
  operation,
  expectedIds,
  items = [],
}) {
  return runMerchantAccessOperation(async () => {
    if (!["restock", "generate", "clear", "open", "close"].includes(operation))
      throw new Error("Unknown shop action.");
    const selectedIds = (expectedIds ?? []).slice().sort();
    if (!selectedIds.length)
      throw new Error("Add a shop to this location first.");
    const globallyClosed = loadMerchantAccessState().closed;
    const liftingGlobalGate = operation === "open" && globallyClosed;
    const all = loadMerchants();
    const lockedIds = liftingGlobalGate
      ? all.map((row) => row.id)
      : selectedIds;
    let count = 0;
    await commitMerchantBatch(lockedIds, (current) => {
      const actualIds = current
        .filter((row) => (row.shop?.locationId ?? "") === locationId)
        .map((row) => row.id)
        .sort();
      if (JSON.stringify(actualIds) !== JSON.stringify(selectedIds))
        throw new Error(
          "The shops in this location changed. Try the action again.",
        );
      if (
        liftingGlobalGate &&
        current.some((row) => !lockedIds.includes(row.id))
      )
        throw new Error(
          "A new shop was added. Try opening the location again.",
        );
      return current.map((merchant) => {
        if (!selectedIds.includes(merchant.id)) {
          // An old global closure must not accidentally open other locations.
          return liftingGlobalGate
            ? normalizeMerchant({
                ...merchant,
                shop: { ...shopSetup(merchant), open: false },
              })
            : merchant;
        }
        count++;
        if (operation === "generate") return generateShop(merchant, items);
        if (operation === "restock")
          return resetMerchantPurse(restockAll(merchant));
        if (operation === "clear")
          return resetMerchantPurse(clearInventory(merchant));
        return normalizeMerchant({
          ...merchant,
          selfServiceMode:
            operation === "open" ? "open" : merchant.selfServiceMode,
          shop: { ...shopSetup(merchant), open: operation === "open" },
        });
      });
    });
    if (liftingGlobalGate)
      await saveMerchantAccessState({ closed: false, suspendedSessions: [] });
    pushMerchantAccessRefresh();
    return { count };
  });
}
