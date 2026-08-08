const MODULE_ID = "infinity-dnd5e";
const LEDGER_STATES = new Set(["issued", "consumed"]);

function cleanId(value) {
  return String(value ?? "")
    .trim()
    .slice(0, 160);
}

function nonNegativeInteger(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : 0;
}

function sourceOf(document) {
  return document?.toObject?.() ?? document ?? {};
}

export function stolenItemProvenance(document) {
  const value = sourceOf(document).flags?.[MODULE_ID]?.stolen;
  return value && typeof value === "object" && !Array.isArray(value)
    ? {
        settlementId: cleanId(value.settlementId),
        targetType: cleanId(value.targetType),
        sourceId: value.sourceId == null ? null : cleanId(value.sourceId),
        merchantId: value.merchantId == null ? null : cleanId(value.merchantId),
        operationId: cleanId(value.operationId),
        timestamp: nonNegativeInteger(value.timestamp),
        appraisedValueCp: nonNegativeInteger(value.appraisedValueCp),
      }
    : null;
}

export function normalizeStolenGoodsRecord(raw, fallbackItemId = "") {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const itemId = cleanId(raw.itemId) || cleanId(fallbackItemId);
  const actorId = cleanId(raw.actorId);
  const operationId = cleanId(raw.operationId);
  const provenance = stolenItemProvenance({
    flags: { [MODULE_ID]: { stolen: raw.provenance } },
  });
  if (!itemId || !actorId || !operationId || !provenance) return null;
  if (provenance.operationId !== operationId) return null;
  const state = LEDGER_STATES.has(raw.state) ? raw.state : "issued";
  const record = {
    itemId,
    actorId,
    operationId,
    provenance,
    state,
    issuedAt: nonNegativeInteger(raw.issuedAt ?? provenance.timestamp),
    consumedByOperationId: null,
    consumedAt: 0,
  };
  if (state === "consumed") {
    const consumedByOperationId = cleanId(raw.consumedByOperationId);
    if (!consumedByOperationId) return null;
    record.consumedByOperationId = consumedByOperationId;
    record.consumedAt = nonNegativeInteger(raw.consumedAt);
  }
  return record;
}

export function normalizeStolenGoodsLedger(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const entries = [];
  for (const [itemId, value] of Object.entries(raw)) {
    const record = normalizeStolenGoodsRecord(value, itemId);
    if (!record || record.itemId !== cleanId(itemId)) continue;
    entries.push([record.itemId, record]);
  }
  entries.sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(entries);
}

export function buildStolenGoodsIssuance({ actorId, snapshot } = {}) {
  const source = sourceOf(snapshot);
  return normalizeStolenGoodsRecord({
    itemId: source._id ?? source.id,
    actorId,
    operationId: stolenItemProvenance(source)?.operationId,
    provenance: stolenItemProvenance(source),
    state: "issued",
    issuedAt: stolenItemProvenance(source)?.timestamp,
  });
}

export function stolenGoodsRecord(configOrLedger, itemId) {
  const ledger = normalizeStolenGoodsLedger(
    configOrLedger?.stolenGoods ?? configOrLedger,
  );
  return ledger[cleanId(itemId)] ?? null;
}

export function stolenGoodsRecordsEqual(left, right) {
  const normalizedLeft = normalizeStolenGoodsRecord(left, left?.itemId);
  const normalizedRight = normalizeStolenGoodsRecord(right, right?.itemId);
  return Boolean(
    normalizedLeft &&
    normalizedRight &&
    JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight),
  );
}

export function activeStolenGoodsRecord(
  configOrLedger,
  { actorId, itemId, item = null } = {},
) {
  const record = stolenGoodsRecord(configOrLedger, itemId);
  if (
    !record ||
    record.state !== "issued" ||
    record.actorId !== cleanId(actorId) ||
    record.itemId !== cleanId(itemId)
  ) {
    return null;
  }
  if (item) {
    const provenance = stolenItemProvenance(item);
    if (!provenance) return null;
    const expected = normalizeStolenGoodsRecord({
      ...record,
      provenance,
    });
    if (!stolenGoodsRecordsEqual(record, expected)) return null;
  }
  return record;
}

export function hasActiveStolenGoodsIssuance(configOrLedger, actorId, itemId) {
  return Boolean(activeStolenGoodsRecord(configOrLedger, { actorId, itemId }));
}

/**
 * Return whether this deterministic embedded-item ID has ever been issued to
 * the Actor. Ordinary merchant sales use this broader predicate so recreating
 * a consumed ID cannot turn already-fenced goods into clean inventory.
 */
export function hasStolenGoodsIssuance(configOrLedger, actorId, itemId) {
  const record = stolenGoodsRecord(configOrLedger, itemId);
  return Boolean(
    record &&
    record.actorId === cleanId(actorId) &&
    record.itemId === cleanId(itemId),
  );
}

export function issueStolenGoodsRecord(rawLedger, rawIssuance) {
  const ledger = normalizeStolenGoodsLedger(rawLedger);
  const issuance = normalizeStolenGoodsRecord(rawIssuance, rawIssuance?.itemId);
  if (!issuance || issuance.state !== "issued") {
    return { ok: false, reason: "stolen-issuance-invalid", ledger };
  }
  const current = ledger[issuance.itemId];
  if (current) {
    return stolenGoodsRecordsEqual(current, issuance)
      ? { ok: true, alreadyIssued: true, record: current, ledger }
      : { ok: false, reason: "stolen-issuance-collision", ledger };
  }
  ledger[issuance.itemId] = issuance;
  return { ok: true, alreadyIssued: false, record: issuance, ledger };
}

export function buildStolenGoodsConsumption(
  issuance,
  { fenceOperationId, consumedAt } = {},
) {
  const record = normalizeStolenGoodsRecord(issuance, issuance?.itemId);
  const operationId = cleanId(fenceOperationId);
  if (!record || record.state !== "issued" || !operationId) return null;
  return {
    ...record,
    state: "consumed",
    consumedByOperationId: operationId,
    consumedAt: nonNegativeInteger(consumedAt),
  };
}

export function consumeStolenGoodsRecord(rawLedger, rawConsumption) {
  const ledger = normalizeStolenGoodsLedger(rawLedger);
  const consumption = normalizeStolenGoodsRecord(
    rawConsumption,
    rawConsumption?.itemId,
  );
  if (!consumption || consumption.state !== "consumed") {
    return { ok: false, reason: "stolen-consumption-invalid", ledger };
  }
  const current = ledger[consumption.itemId];
  if (!current) {
    return { ok: false, reason: "stolen-issuance-missing", ledger };
  }
  if (current.state === "consumed") {
    return stolenGoodsRecordsEqual(current, consumption)
      ? { ok: true, alreadyConsumed: true, record: current, ledger }
      : { ok: false, reason: "stolen-consumption-collision", ledger };
  }
  const expectedIssued = normalizeStolenGoodsRecord({
    ...consumption,
    state: "issued",
    consumedByOperationId: null,
    consumedAt: 0,
  });
  if (!stolenGoodsRecordsEqual(current, expectedIssued)) {
    return { ok: false, reason: "stolen-consumption-collision", ledger };
  }
  ledger[consumption.itemId] = consumption;
  return {
    ok: true,
    alreadyConsumed: false,
    record: consumption,
    ledger,
  };
}
