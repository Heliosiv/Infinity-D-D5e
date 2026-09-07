/** Persist public text only on uniquely identified Campaign Pulse controls. */
const FLAG_SCOPE = "drakemore-foundry";
const HUB_VERSION = 1;

export async function syncPlayerHubLabel({
  gameRef,
  key,
  title,
  text,
  isWriteAuthority,
}) {
  const result = { updated: 0, unchanged: 0, skipped: 0 };
  for (const scene of collectionValues(gameRef?.scenes)) {
    const hub = scene?.flags?.[FLAG_SCOPE]?.playerHub;
    if (
      hub?.kind !== "interactive-player-hub" ||
      hub?.version !== HUB_VERSION ||
      Number(scene?.width ?? hub?.width) !== 3840 ||
      Number(scene?.height ?? hub?.height) !== 2160
    )
      continue;
    const target = findLabel(scene, key, title);
    const drawingId = String(target?.id ?? target?._id ?? "").trim();
    if (
      !target ||
      !drawingId ||
      typeof scene.updateEmbeddedDocuments !== "function"
    ) {
      result.skipped += 1;
      continue;
    }
    if (target.text === text) {
      result.unchanged += 1;
      continue;
    }
    // Reads and earlier scene updates can yield; recheck immediately before writing.
    if (isWriteAuthority() !== true) {
      result.skipped += 1;
      continue;
    }
    try {
      await scene.updateEmbeddedDocuments("Drawing", [
        { _id: drawingId, text },
      ]);
      result.updated += 1;
    } catch (error) {
      result.skipped += 1;
      console.warn("infinity-dnd5e | player-hub label update failed", {
        sceneId: scene.id ?? null,
        drawingId,
        error,
      });
    }
  }
  return result;
}

function findLabel(scene, key, title) {
  const tiles = collectionValues(scene?.tiles).filter((tile) => {
    const control = tile?.flags?.[FLAG_SCOPE]?.playerHubControl;
    return control?.version === HUB_VERSION && control?.key === key;
  });
  const drawings = collectionValues(scene?.drawings).filter((drawing) => {
    const label = drawing?.flags?.[FLAG_SCOPE]?.playerHubLabel;
    return label?.version === HUB_VERSION && label?.key === key;
  });
  if (tiles.length !== 1 || drawings.length !== 1) return null;
  const drawing = drawings[0];
  if (String(drawing.text ?? "").split(/\r?\n/)[0] !== title) return null;
  return substantiallyOverlaps(rect(drawing), rect(tiles[0])) ? drawing : null;
}

function substantiallyOverlaps(first, second) {
  if (!first || !second) return false;
  const width = Math.max(
    0,
    Math.min(first.right, second.right) - Math.max(first.left, second.left),
  );
  const height = Math.max(
    0,
    Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top),
  );
  return (width * height) / Math.min(first.area, second.area) >= 0.8;
}

function rect(document) {
  const left = Number(document?.x);
  const top = Number(document?.y);
  const width = Number(document?.width ?? document?.shape?.width);
  const height = Number(document?.height ?? document?.shape?.height);
  if (
    ![left, top, width, height].every(Number.isFinite) ||
    width <= 0 ||
    height <= 0
  )
    return null;
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    area: width * height,
  };
}

function collectionValues(collection) {
  if (Array.isArray(collection)) return collection;
  if (Array.isArray(collection?.contents)) return collection.contents;
  if (typeof collection?.values === "function") return [...collection.values()];
  return [];
}
