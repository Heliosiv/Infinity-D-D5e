/**
 * Infinity D&D5e — portable Quartermaster environment files (pure)
 *
 * Portable files contain only validated custom-region rules. Built-in presets,
 * roster data, resource balances, run state, and history remain world-owned.
 */

import {
  isCustomEnvironment,
  validateEnvironmentDraft,
} from "./environment.js";

export const ENVIRONMENT_EXPORT_SCHEMA =
  "infinity-dnd5e-quartermaster-environments-v1";
export const ENVIRONMENT_EXPORT_FILENAME =
  "infinity-quartermaster-environments.json";
export const ENVIRONMENT_EXPORT_LIMIT = 50;

/** Validate and project a portable file against the current saved catalog. */
export function planEnvironmentImport(data, existingCatalog = []) {
  const errors = [];
  const originalCatalog = Array.isArray(existingCatalog)
    ? existingCatalog.map((environment) => ({ ...environment }))
    : [];
  if (!isRecord(data)) {
    return importFailure(
      "The selected file must contain a JSON object.",
      originalCatalog,
    );
  }
  if (data.schema !== ENVIRONMENT_EXPORT_SCHEMA) {
    return importFailure(
      `Expected schema ${ENVIRONMENT_EXPORT_SCHEMA}.`,
      originalCatalog,
    );
  }
  if (!Array.isArray(data.environments) || data.environments.length === 0) {
    return importFailure(
      "The file contains no custom environments.",
      originalCatalog,
    );
  }
  if (data.environments.length > ENVIRONMENT_EXPORT_LIMIT) {
    return importFailure(
      `Import at most ${ENVIRONMENT_EXPORT_LIMIT} custom environments at once.`,
      originalCatalog,
    );
  }
  const projectedCatalog = originalCatalog.map((environment) => ({
    ...environment,
  }));
  const imported = [];
  const fileIds = new Set();

  for (const [index, raw] of data.environments.entries()) {
    const id = String(raw?.id ?? "").trim();
    const idKey = id.toLowerCase();
    if (idKey && fileIds.has(idKey)) {
      errors.push(`Entry ${index + 1}: duplicate environment ID ${id}.`);
      continue;
    }
    if (idKey) fileIds.add(idKey);

    const existingIndex = projectedCatalog.findIndex(
      (environment) => String(environment?.id ?? "") === id,
    );
    const caseCollision = projectedCatalog.find(
      (environment) =>
        String(environment?.id ?? "").toLowerCase() === idKey &&
        String(environment?.id ?? "") !== id,
    );
    const existing =
      existingIndex >= 0 ? projectedCatalog[existingIndex] : null;
    if (caseCollision) {
      errors.push(
        `Entry ${index + 1}: ${id} differs only by letter case from saved ID ${caseCollision.id}.`,
      );
      continue;
    }
    if (existing?.builtIn === true) {
      errors.push(
        `Entry ${index + 1}: ${id} is a built-in preset and cannot be replaced.`,
      );
      continue;
    }

    const validationCatalog = projectedCatalog.filter(
      (environment) => String(environment?.id ?? "") !== id,
    );
    const validation = validateEnvironmentDraft(raw, {
      catalog: validationCatalog,
    });
    if (!validation.ok || !validation.value) {
      const detail = Object.values(validation.errors ?? {})[0];
      errors.push(
        `Entry ${index + 1}${id ? ` (${id})` : ""}: ${detail ?? "invalid environment data."}`,
      );
      continue;
    }

    const value = validation.value;
    const action = existing
      ? environmentRuleFingerprint(existing) ===
        environmentRuleFingerprint(value)
        ? "unchanged"
        : "update"
      : "add";
    if (existingIndex >= 0) projectedCatalog[existingIndex] = value;
    else projectedCatalog.push(value);
    imported.push({ action, environment: { ...value } });
  }

  if (errors.length > 0) {
    return {
      ok: false,
      errors,
      catalog: originalCatalog,
      imported: [],
      preview: emptyImportPreview(),
    };
  }

  const requestedActiveId = String(data.activeEnvironmentId ?? "").trim();
  const recommendedActiveEnvironment = requestedActiveId
    ? (imported.find(({ environment }) => environment.id === requestedActiveId)
        ?.environment ?? null)
    : null;
  if (requestedActiveId && !recommendedActiveEnvironment) {
    return importFailure(
      `The suggested active environment ${requestedActiveId} is not present in the file.`,
      originalCatalog,
    );
  }

  const preview = {
    additions: imported.filter((entry) => entry.action === "add").length,
    updates: imported.filter((entry) => entry.action === "update").length,
    unchanged: imported.filter((entry) => entry.action === "unchanged").length,
    total: imported.length,
    recommendedActiveEnvironment: recommendedActiveEnvironment
      ? { ...recommendedActiveEnvironment }
      : null,
  };
  return {
    ok: true,
    errors: [],
    catalog: projectedCatalog,
    imported,
    preview,
  };
}

/** Stable comparison for stale-preview and persistence verification. */
export function environmentCatalogFingerprint(catalog) {
  return JSON.stringify(
    (Array.isArray(catalog) ? catalog : []).map((environment) => ({
      ...projectPortableEnvironment(environment),
      builtIn: environment?.builtIn === true,
    })),
  );
}

/** Build a deterministic, versioned export of the saved custom regions. */
export function buildEnvironmentExport(catalog, activeEnvironmentId = null) {
  const environments = (Array.isArray(catalog) ? catalog : [])
    .filter((environment) => isCustomEnvironment(environment))
    .slice(0, ENVIRONMENT_EXPORT_LIMIT)
    .map(projectPortableEnvironment);
  const activeId = String(activeEnvironmentId ?? "").trim();
  return {
    schema: ENVIRONMENT_EXPORT_SCHEMA,
    activeEnvironmentId: environments.some(
      (environment) => environment.id === activeId,
    )
      ? activeId
      : null,
    environments,
  };
}

/**
 * Build and pass an export to an injected JSON downloader. This keeps the file
 * contract testable without browser globals.
 */
export function downloadEnvironmentExport({
  catalog,
  activeEnvironmentId = null,
  download,
} = {}) {
  const customCount = (Array.isArray(catalog) ? catalog : []).filter(
    (environment) => isCustomEnvironment(environment),
  ).length;
  const data = buildEnvironmentExport(catalog, activeEnvironmentId);
  if (
    customCount === 0 ||
    customCount > ENVIRONMENT_EXPORT_LIMIT ||
    typeof download !== "function"
  ) {
    return {
      ok: false,
      reason:
        customCount > ENVIRONMENT_EXPORT_LIMIT
          ? "limit-exceeded"
          : "unavailable",
      data,
      filename: ENVIRONMENT_EXPORT_FILENAME,
    };
  }
  return {
    ok: download(ENVIRONMENT_EXPORT_FILENAME, data) === true,
    reason: null,
    data,
    filename: ENVIRONMENT_EXPORT_FILENAME,
  };
}

function projectPortableEnvironment(environment) {
  return {
    id: String(environment?.id ?? "").trim(),
    label: String(environment?.label ?? "").trim(),
    dc: Number(environment?.dc),
    foodDc: Number(environment?.foodDc ?? environment?.dc),
    waterDc: Number(environment?.waterDc ?? environment?.dc),
    forageable: environment?.forageable !== false,
    yieldFood: String(environment?.yieldFood ?? "0").trim(),
    yieldWater: String(environment?.yieldWater ?? "0").trim(),
  };
}

function environmentRuleFingerprint(environment) {
  return JSON.stringify(projectPortableEnvironment(environment));
}

function importFailure(message, catalog = []) {
  return {
    ok: false,
    errors: [message],
    catalog: Array.isArray(catalog)
      ? catalog.map((environment) => ({ ...environment }))
      : [],
    imported: [],
    preview: emptyImportPreview(),
  };
}

function emptyImportPreview() {
  return {
    additions: 0,
    updates: 0,
    unchanged: 0,
    total: 0,
    recommendedActiveEnvironment: null,
  };
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
