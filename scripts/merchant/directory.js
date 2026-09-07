/** Shop organization, kept separate from stock generation and the UI. */
import { loadMerchants, normalizeMerchant, shopSetup } from "./store.js";
import { locationDirectory } from "./locations.js";
import { updateMerchantLocations } from "./global-access.js";
import {
  commitMerchantBatch,
  pushCloseAllSessionsFor,
  pushMerchantAccessRefresh,
  runMerchantAccessOperation,
} from "./socket.js";

export function assertShopLocation(locationId) {
  if (
    locationId !== "" &&
    !locationDirectory().some((row) => row.id === locationId)
  )
    throw new Error(
      "This location no longer exists. Refresh Shops and choose another location.",
    );
}

function checkedShops(current, expectedShops) {
  if (!Array.isArray(expectedShops) || !expectedShops.length)
    throw new Error("Select at least one shop.");
  const ids = new Set();
  for (const expected of expectedShops) {
    const fresh = current.find((row) => row.id === expected.id);
    if (
      !fresh ||
      fresh.name !== expected.name ||
      (fresh.shop?.locationId ?? "") !== (expected.shop?.locationId ?? "")
    )
      throw new Error(
        "A selected shop was renamed, moved, or deleted. Review the list and try again.",
      );
    ids.add(fresh.id);
  }
  return ids;
}

export function moveDirectoryShops({ expectedShops, destination }) {
  return runMerchantAccessOperation(() =>
    moveShops(expectedShops, destination),
  );
}

async function moveShops(expectedShops, destination, sourceLocation = null) {
  return commitMerchantBatch(
    expectedShops.map((row) => row.id),
    (current) => {
      assertShopLocation(destination);
      if (sourceLocation != null) {
        const actual = current
          .filter((row) => (row.shop?.locationId ?? "") === sourceLocation)
          .map((row) => row.id)
          .sort();
        if (
          JSON.stringify(actual) !==
          JSON.stringify(expectedShops.map((row) => row.id).sort())
        )
          throw new Error(
            "The shops in this location changed. Review the list and try again.",
          );
      }
      const ids = checkedShops(current, expectedShops);
      return current.map((merchant) =>
        ids.has(merchant.id)
          ? normalizeMerchant({
              ...merchant,
              shop: { ...shopSetup(merchant), locationId: destination },
            })
          : merchant,
      );
    },
  );
}

export function deleteDirectoryShops(expectedShops) {
  return runMerchantAccessOperation(async () => {
    const ids = expectedShops.map((row) => row.id);
    await commitMerchantBatch(ids, (current) => {
      const selected = checkedShops(current, expectedShops);
      return current.filter((row) => !selected.has(row.id));
    });
    for (const id of ids) pushCloseAllSessionsFor(id);
    pushMerchantAccessRefresh();
    return ids;
  });
}

export function renameShopLocation({ locationId, expectedName, name }) {
  return runMerchantAccessOperation(async () => {
    const label = String(name ?? "")
      .trim()
      .slice(0, 100);
    if (!locationId || !label)
      throw new Error("Enter a city or location name.");
    assertLocationUnchanged(locationId, expectedName);
    await updateMerchantLocations((locations) => {
      if (
        locations.some(
          (row) =>
            row.id !== locationId &&
            row.name.toLocaleLowerCase() === label.toLocaleLowerCase(),
        )
      )
        throw new Error("That location name already exists.");
      // Imported locations can be given a real catalogue entry too.
      return [
        ...locations.filter((row) => row.id !== locationId),
        { id: locationId, name: label },
      ];
    });
    pushMerchantAccessRefresh();
  });
}

/** Give the current unassigned shops a real location, without generating stock. */
export function nameUnassignedShopLocation({ name, expectedShops }) {
  return runMerchantAccessOperation(async () => {
    const label = String(name ?? "")
      .trim()
      .slice(0, 100);
    if (!label) throw new Error("Enter a city or location name.");
    const current = loadMerchants();
    checkedShops(current, expectedShops);
    if (
      expectedShops.some((row) => row.shop?.locationId) ||
      current.filter((row) => !row.shop?.locationId).length !==
        expectedShops.length
    )
      throw new Error(
        "The unassigned shops changed. Review the list and try again.",
      );
    if (
      locationDirectory().some(
        (row) => row.name.toLocaleLowerCase() === label.toLocaleLowerCase(),
      )
    )
      throw new Error(
        "That location name already exists. Use Move selected to move shops there.",
      );
    const id = globalThis.crypto.randomUUID();
    await updateMerchantLocations((locations) => [
      ...locations,
      { id, name: label },
    ]);
    try {
      await moveShops(expectedShops, id, "");
    } catch (error) {
      // A failed or blocked move must not leave a misleading empty location.
      if (!loadMerchants().some((row) => row.shop?.locationId === id)) {
        try {
          await updateMerchantLocations((locations) =>
            locations.filter((row) => row.id !== id),
          );
        } catch {
          throw new Error(
            `The shops could not be moved. An empty location named ${label} was created; refresh Shops and retry using Move selected. ${error.message}`,
          );
        }
      }
      throw error;
    }
    pushMerchantAccessRefresh();
    return { id, name: label };
  });
}

function assertLocationUnchanged(locationId, expectedName) {
  const fresh = locationDirectory().find((row) => row.id === locationId);
  if (!locationId || !fresh || fresh.name !== expectedName)
    throw new Error("This location changed. Review the list and try again.");
}

/** Keep shops first, then remove their empty catalogue entry. A failed second
 * save leaves an empty location which can be removed again; no shops are lost. */
export function removeShopLocation({
  locationId,
  expectedName,
  expectedShops,
}) {
  return runMerchantAccessOperation(async () => {
    assertLocationUnchanged(locationId, expectedName);
    const actualIds = loadMerchants()
      .filter((row) => row.shop?.locationId === locationId)
      .map((row) => row.id)
      .sort();
    if (
      JSON.stringify(actualIds) !==
      JSON.stringify(expectedShops.map((row) => row.id).sort())
    )
      throw new Error(
        "The shops in this location changed. Review the list and try again.",
      );
    if (expectedShops.length) await moveShops(expectedShops, "", locationId);
    try {
      await updateMerchantLocations((locations) => {
        if (loadMerchants().some((row) => row.shop?.locationId === locationId))
          throw new Error(
            "A shop was added to this location. Review it and try again.",
          );
        return locations.filter((row) => row.id !== locationId);
      });
    } catch (error) {
      throw new Error(
        `The location could not be removed. Any shops already moved are safe in Unassigned shops. Try removing the location again. ${error.message}`,
      );
    }
    pushMerchantAccessRefresh();
  });
}

/** Pure view transform: sorting never changes the saved merchant order. */
export function filterDirectoryShops(
  merchants,
  { query = "", filter = "all", sort = "name" } = {},
) {
  const search = query.trim().toLocaleLowerCase();
  const byName = (a, b) =>
    a.name.localeCompare(b.name, undefined, {
      numeric: true,
      sensitivity: "base",
    }) || a.id.localeCompare(b.id);
  return merchants
    .filter(
      (row) =>
        row.name.toLocaleLowerCase().includes(search) &&
        (filter === "open"
          ? row.status === "Open"
          : filter === "closed"
            ? row.status === "Closed"
            : filter === "empty"
              ? row.itemCount === 0
              : true),
    )
    .sort((a, b) =>
      sort === "name-desc"
        ? -byName(a, b)
        : sort === "stock"
          ? b.itemCount - a.itemCount || byName(a, b)
          : sort === "open"
            ? Number(b.status === "Open") - Number(a.status === "Open") ||
              byName(a, b)
            : byName(a, b),
    );
}
