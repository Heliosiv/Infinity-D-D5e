/**
 * Infinity D&D5e - Resource overview model (pure)
 *
 * Builds one generic, source-aware projection for both the GM Quartermaster
 * and the read-only player Supplies view. Actor Items remain the stock source
 * of truth; this module only receives plain roster/item snapshots and performs
 * no Foundry reads or writes.
 */

import { matchResourceItems } from "./consumption.js";

export const RESOURCE_OVERVIEW_VERSION = 1;

const STATUS_LABELS = Object.freeze({
  ready: "Ready",
  low: "Low",
  critical: "Critical",
  stable: "No daily use",
  unconfigured: "No party",
});

/** Build a complete GM-facing overview from plain resource data. */
export function buildResourceOverview({
  config = {},
  state = {},
  environment = null,
  roster = [],
  autoTrigger = true,
  generatedAt = null,
} = {}) {
  const members = normalizeOverviewRoster(roster);
  const consumers = members.filter((member) => member.consumes);
  const memberById = new Map(members.map((member) => [member.actorId, member]));
  const resources = (Array.isArray(config.resources) ? config.resources : [])
    .filter((resource) => resource && typeof resource === "object")
    .filter(
      (resource) =>
        !(
          config.waterEnabled === false &&
          (resource.id === "water" || resource.forageYields === "water")
        ),
    );

  const memberRows = members.map((member) => ({
    actorId: member.actorId,
    name: member.name,
    isStash: member.isStash,
    consumes: member.consumes,
    drawFromId: member.drawFromId,
    drawFromName: memberById.get(member.drawFromId)?.name ?? member.name,
    exhaustion: member.exhaustion,
    resources: [],
  }));
  const memberRowById = new Map(
    memberRows.map((member) => [member.actorId, member]),
  );

  const resourceRows = resources.map((resource) =>
    resource.scope === "party"
      ? buildPartyResource({
          resource,
          config,
          members,
          memberRows,
          consumerCount: consumers.length,
        })
      : buildPerCharacterResource({
          resource,
          config,
          consumers,
          memberById,
          memberRowById,
        }),
  );
  // Keep the GM roster table rectangular and in configured resource order.
  // A tracked inventory-only actor may not yet supply any consumer, but its own
  // stock still needs a real cell rather than shifting later resource columns.
  for (const member of members) {
    const row = memberRowById.get(member.actorId);
    if (!row) continue;
    const cellsById = new Map(
      row.resources.map((resource) => [String(resource.id), resource]),
    );
    row.resources = resources.map((resource) => {
      const id = text(resource.id);
      return (
        cellsById.get(id) ??
        buildInventoryOnlyResourceCell({ member, resource })
      );
    });
  }

  return {
    schemaVersion: RESOURCE_OVERVIEW_VERSION,
    generatedAt: finiteOrNull(generatedAt),
    partySize: consumers.length,
    autoTrigger: autoTrigger !== false,
    halfRations: config.halfRations === true,
    waterEnabled: config.waterEnabled !== false,
    environment: environment
      ? {
          id: text(environment.id),
          label: text(environment.label, "Unknown"),
          forageable: environment.forageable !== false,
          dc: finiteOrNull(environment.dc),
        }
      : null,
    resources: resourceRows,
    members: memberRows,
    lastUpkeep: buildLastUpkeep(state.lastUpkeepResult, resources),
  };
}

function buildInventoryOnlyResourceCell({ member, resource }) {
  const matches = matchResourceItems(member.items, resource);
  const available = sumMatches(matches);
  return {
    id: text(resource.id),
    label: text(resource.label, resource.id),
    total: available,
    sourceName: member.name,
    shared: false,
    coverageDays: null,
    coverageLabel: "No daily use",
    status: "stable",
    detail: `${matchDetail(matches, resource.label)}. Not currently assigned to a consuming party member.`,
  };
}

/**
 * Strip document ids and item-match evidence before a snapshot leaves the GM.
 * Players receive deliberate party aggregates, source labels, and the last
 * operational result, never raw Actor Items, UUID rules, or write errors.
 */
export function sanitizeResourceOverview(
  overview,
  { visibleActorIds = null } = {},
) {
  const source = overview && typeof overview === "object" ? overview : {};
  return {
    schemaVersion: RESOURCE_OVERVIEW_VERSION,
    generatedAt: finiteOrNull(source.generatedAt),
    partySize: nonNegativeInt(source.partySize),
    autoTrigger: source.autoTrigger !== false,
    halfRations: source.halfRations === true,
    waterEnabled: source.waterEnabled !== false,
    environment: source.environment
      ? {
          id: text(source.environment.id),
          label: text(source.environment.label, "Unknown"),
          forageable: source.environment.forageable !== false,
          dc: finiteOrNull(source.environment.dc),
        }
      : null,
    resources: (Array.isArray(source.resources) ? source.resources : []).map(
      (resource) => ({
        id: text(resource.id),
        label: text(resource.label, resource.id),
        scope: resource.scope === "party" ? "party" : "per-character",
        scopeLabel: resource.scope === "party" ? "Party pool" : "Per character",
        available: nonNegativeNumber(resource.available),
        dailyUse: nonNegativeNumber(resource.dailyUse),
        coverageDays: finiteOrNull(resource.coverageDays),
        coverageLabel: text(resource.coverageLabel),
        status: normalizeStatus(resource.status),
        statusLabel: STATUS_LABELS[normalizeStatus(resource.status)],
        sourceSummary: sanitizedSourceSummary(resource),
      }),
    ),
    lastUpkeep: sanitizeLastUpkeep(source.lastUpkeep, { visibleActorIds }),
  };
}

function buildPerCharacterResource({
  resource,
  config,
  consumers,
  memberById,
  memberRowById,
}) {
  const demandPerMember = dailyDemand(resource, config);
  const groups = new Map();
  for (const member of consumers) {
    const requestedSourceId = member.drawFromId || member.actorId;
    const source = memberById.get(requestedSourceId) ?? member;
    let group = groups.get(source.actorId);
    if (!group) {
      group = { source, members: [] };
      groups.set(source.actorId, group);
    }
    group.members.push(member);
  }

  const sourceRows = [...groups.values()].map(
    ({ source, members: consumers }) => {
      const matches = matchResourceItems(source.items, resource);
      const available = sumMatches(matches);
      const dailyUse = demandPerMember * consumers.length;
      const coverageDays = coverage(available, dailyUse);
      const status = coverageStatus(coverageDays, dailyUse, consumers.length);
      const detail = matchDetail(matches, resource.label);
      const row = {
        name: source.name,
        memberCount: consumers.length,
        available,
        dailyUse,
        coverageDays,
        coverageLabel: formatCoverage(coverageDays, dailyUse, consumers.length),
        status,
        statusLabel: STATUS_LABELS[status],
        matchDetail: detail,
      };

      for (const consumer of consumers) {
        memberRowById.get(consumer.actorId)?.resources.push({
          id: text(resource.id),
          label: text(resource.label, resource.id),
          total: available,
          sourceName: source.name,
          shared: consumers.length > 1,
          coverageDays,
          coverageLabel: row.coverageLabel,
          status,
          detail:
            consumers.length > 1
              ? `${detail}. Shared by ${consumers.length} party members.`
              : detail,
        });
      }
      if (!consumers.some((consumer) => consumer.actorId === source.actorId)) {
        memberRowById.get(source.actorId)?.resources.push({
          id: text(resource.id),
          label: text(resource.label, resource.id),
          total: available,
          sourceName: source.name,
          shared: consumers.length > 0,
          coverageDays,
          coverageLabel: row.coverageLabel,
          status,
          detail:
            consumers.length > 0
              ? `${detail}. Inventory source for ${consumers.length} consuming party member${consumers.length === 1 ? "" : "s"}.`
              : detail,
        });
      }
      return row;
    },
  );

  const available = sourceRows.reduce((sum, row) => sum + row.available, 0);
  const dailyUse = sourceRows.reduce((sum, row) => sum + row.dailyUse, 0);
  const coverageDays =
    sourceRows.length > 0
      ? minFinite(sourceRows.map((row) => row.coverageDays))
      : coverage(available, dailyUse);
  const status = coverageStatus(coverageDays, dailyUse, consumers.length);
  return {
    id: text(resource.id),
    label: text(resource.label, resource.id),
    scope: "per-character",
    scopeLabel: "Per character",
    available,
    dailyUse,
    coverageDays,
    coverageLabel: formatCoverage(coverageDays, dailyUse, consumers.length),
    status,
    statusLabel: STATUS_LABELS[status],
    sourceSummary: describeSources(sourceRows, "Individual packs", true),
    sources: sourceRows,
  };
}

function buildPartyResource({
  resource,
  config,
  members,
  memberRows,
  consumerCount,
}) {
  const dailyUse = dailyDemand(resource, config);
  const sourceRows = members.map((member) => {
    const matches = matchResourceItems(member.items, resource);
    return {
      name: member.name,
      memberCount: 0,
      available: sumMatches(matches),
      dailyUse: 0,
      coverageDays: null,
      coverageLabel: "",
      status: "stable",
      statusLabel: STATUS_LABELS.stable,
      matchDetail: matchDetail(matches, resource.label),
    };
  });
  const available = sourceRows.reduce((sum, row) => sum + row.available, 0);
  const coverageDays = coverage(available, dailyUse);
  const status = coverageStatus(coverageDays, dailyUse, consumerCount);
  const detail = sourceRows
    .filter((row) => row.available > 0)
    .map((row) => `${row.name}: ${row.available}`)
    .join(", ");

  for (const member of memberRows) {
    member.resources.push({
      id: text(resource.id),
      label: text(resource.label, resource.id),
      total: available,
      sourceName: "Party pool",
      shared: true,
      coverageDays,
      coverageLabel: formatCoverage(coverageDays, dailyUse, consumerCount),
      status,
      detail: detail || `No items match ${text(resource.label, resource.id)}`,
    });
  }

  return {
    id: text(resource.id),
    label: text(resource.label, resource.id),
    scope: "party",
    scopeLabel: "Party pool",
    available,
    dailyUse,
    coverageDays,
    coverageLabel: formatCoverage(coverageDays, dailyUse, consumerCount),
    status,
    statusLabel: STATUS_LABELS[status],
    sourceSummary: describeSources(sourceRows, "Party pool"),
    sources: sourceRows,
  };
}

function buildLastUpkeep(result, resources) {
  if (!result || typeof result !== "object") return null;
  const historicalResources = Array.isArray(result.resourceSnapshot)
    ? result.resourceSnapshot
        .filter((resource) => resource && typeof resource === "object")
        .map((resource) => ({
          id: text(resource.id),
          label: text(resource.label, resource.id),
          scope: resource.scope === "party" ? "party" : "per-character",
        }))
        .filter((resource) => resource.id)
    : resources;
  const perCharacter = historicalResources.filter(
    (resource) => resource.scope !== "party",
  );
  const partyResources = historicalResources.filter(
    (resource) => resource.scope === "party",
  );
  const rows = (Array.isArray(result.perActor) ? result.perActor : []).map(
    (row) => {
      const shortages = perCharacter
        .map((resource) => ({
          id: text(resource.id),
          label: text(resource.label, resource.id),
          amount: nonNegativeNumber(row?.shortfalls?.[resource.id]),
        }))
        .filter((entry) => entry.amount > 0);
      return {
        actorId: text(row?.actorId) || null,
        name: text(row?.name, "Character"),
        shortages,
        supplied: shortages.length === 0,
        forage: sanitizeForage(row?.foraged),
        hasErrors: Array.isArray(row?.errors) && row.errors.length > 0,
        errors: Array.isArray(row?.errors)
          ? row.errors.map((entry) => text(entry)).filter(Boolean)
          : [],
      };
    },
  );
  const partyShortages = partyResources
    .map((resource) => {
      const entry = result.party?.[resource.id] ?? {};
      return {
        id: text(resource.id),
        label: text(resource.label, resource.id),
        amount: nonNegativeNumber(entry.shortfall),
        hasError: Boolean(entry.error),
        error: text(entry.error),
      };
    })
    .filter((entry) => entry.amount > 0 || entry.hasError);
  return {
    runId: text(result.runId) || null,
    day: finiteOrNull(result.day),
    days: Math.max(1, nonNegativeInt(result.days) || 1),
    environmentId: text(result.environmentId) || null,
    status: result.status === "partial" ? "partial" : "complete",
    ranAt: finiteOrNull(result.ranAt),
    rows,
    partyShortages,
    hasShortages:
      rows.some((row) => !row.supplied) || partyShortages.length > 0,
    hasErrors:
      result.hasErrors === true ||
      rows.some((row) => row.hasErrors) ||
      partyShortages.some((entry) => entry.hasError),
  };
}

function sanitizeLastUpkeep(report, { visibleActorIds = null } = {}) {
  if (!report || typeof report !== "object") return null;
  return {
    day: finiteOrNull(report.day),
    days: Math.max(1, nonNegativeInt(report.days) || 1),
    environmentId: text(report.environmentId) || null,
    status: report.status === "partial" ? "partial" : "complete",
    ranAt: finiteOrNull(report.ranAt),
    rows: (Array.isArray(report.rows) ? report.rows : []).map((row) => ({
      name:
        visibleActorIds instanceof Set &&
        (!row.actorId || !visibleActorIds.has(row.actorId))
          ? "Hidden party member"
          : text(row.name, "Character"),
      shortages: (Array.isArray(row.shortages) ? row.shortages : []).map(
        (entry) => ({
          id: text(entry.id),
          label: text(entry.label, entry.id),
          amount: nonNegativeNumber(entry.amount),
        }),
      ),
      supplied: row.supplied !== false,
      forage: sanitizeForage(row.forage),
      hasErrors: row.hasErrors === true,
    })),
    partyShortages: (Array.isArray(report.partyShortages)
      ? report.partyShortages
      : []
    ).map((entry) => ({
      id: text(entry.id),
      label: text(entry.label, entry.id),
      amount: nonNegativeNumber(entry.amount),
      hasError: entry.hasError === true,
    })),
    hasShortages: report.hasShortages === true,
    hasErrors: report.hasErrors === true,
  };
}

function sanitizedSourceSummary(resource) {
  const count = Array.isArray(resource?.sources) ? resource.sources.length : 0;
  if (resource?.scope === "party") {
    return count === 1 ? "1 supply source" : `${count} supply sources`;
  }
  if (count > 1) return `${count} supply sources; lowest coverage shown`;
  return count === 1 ? "1 supply source" : "Individual packs";
}

function sanitizeForage(value) {
  if (!value || typeof value !== "object") return null;
  return {
    attempted: value.attempted === true,
    success: value.success === true,
    suppressed: value.suppressed === true,
    food: nonNegativeNumber(value.food),
    water: nonNegativeNumber(value.water),
  };
}

function normalizeOverviewRoster(roster) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(roster) ? roster : []) {
    const actorId = text(raw?.actorId);
    if (!actorId || seen.has(actorId)) continue;
    seen.add(actorId);
    out.push({
      actorId,
      name: text(raw?.name, "Character"),
      isStash: raw?.isStash === true,
      consumes: raw?.consumes !== false,
      drawFromId: text(raw?.drawFromId, actorId),
      exhaustion: nonNegativeNumber(raw?.exhaustion),
      items: Array.isArray(raw?.items) ? raw.items : [],
    });
  }
  return out;
}

function dailyDemand(resource, config) {
  const base = nonNegativeNumber(resource?.perDay);
  const isFood = resource?.id === "food" || resource?.forageYields === "food";
  return isFood && config?.halfRations === true
    ? Math.ceil(base / 2)
    : Math.round(base);
}

function sumMatches(matches) {
  return (Array.isArray(matches) ? matches : []).reduce(
    (sum, match) => sum + nonNegativeNumber(match?.quantity),
    0,
  );
}

function matchDetail(matches, label) {
  return matches.length > 0
    ? matches.map((match) => `${match.name} x${match.quantity}`).join(", ")
    : `No items match ${text(label, "this resource")}`;
}

function coverage(available, dailyUse) {
  const use = nonNegativeNumber(dailyUse);
  if (use <= 0) return null;
  return roundTo(nonNegativeNumber(available) / use, 2);
}

function minFinite(values) {
  const finite = values.filter(
    (value) =>
      value !== null &&
      value !== undefined &&
      value !== "" &&
      Number.isFinite(Number(value)),
  );
  return finite.length > 0 ? Math.min(...finite.map(Number)) : null;
}

function coverageStatus(coverageDays, dailyUse, partySize) {
  if (partySize <= 0) return "unconfigured";
  if (dailyUse <= 0 || coverageDays == null) return "stable";
  if (coverageDays < 1) return "critical";
  if (coverageDays < 3) return "low";
  return "ready";
}

export function formatCoverage(coverageDays, dailyUse, partySize = 1) {
  if (partySize <= 0) return "No party";
  if (nonNegativeNumber(dailyUse) <= 0 || coverageDays == null)
    return "No daily use";
  const days = nonNegativeNumber(coverageDays);
  if (days <= 0) return "Empty";
  if (days < 1) return "<1 day";
  if (days >= 999) return "999+ days";
  const rounded = roundTo(days, days < 10 ? 1 : 0);
  return `${rounded} ${rounded === 1 ? "day" : "days"}`;
}

function describeSources(sources, fallback, usesLowestCoverage = false) {
  const active = sources.filter((source) => source.available > 0);
  if (sources.length === 1 && sources[0].memberCount > 1)
    return `Shared via ${sources[0].name}`;
  if (usesLowestCoverage && sources.length > 1)
    return `${sources.length} supply sources; lowest coverage shown`;
  if (active.length === 1) return active[0].name;
  if (sources.length > 1) return `${sources.length} supply sources`;
  return fallback;
}

function normalizeStatus(value) {
  return Object.prototype.hasOwnProperty.call(STATUS_LABELS, value)
    ? value
    : "unconfigured";
}

function text(value, fallback = "") {
  const result = String(value ?? "").trim();
  return result || fallback;
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function nonNegativeInt(value) {
  return Math.floor(nonNegativeNumber(value));
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundTo(value, places) {
  const factor = 10 ** Math.max(0, places);
  return Math.round((Number(value) || 0) * factor) / factor;
}
