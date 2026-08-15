/**
 * Infinity D&D5e — portable Quartermaster environment files (pure)
 *
 * Portable files contain only validated custom-region rules. Built-in presets,
 * roster data, resource balances, run state, and history remain world-owned.
 */

import { isCustomEnvironment } from "./environment.js";

export const ENVIRONMENT_EXPORT_SCHEMA =
  "infinity-dnd5e-quartermaster-environments-v1";
export const ENVIRONMENT_EXPORT_FILENAME =
  "infinity-quartermaster-environments.json";
export const ENVIRONMENT_EXPORT_LIMIT = 50;

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
  const data = buildEnvironmentExport(catalog, activeEnvironmentId);
  if (data.environments.length === 0 || typeof download !== "function") {
    return { ok: false, data, filename: ENVIRONMENT_EXPORT_FILENAME };
  }
  return {
    ok: download(ENVIRONMENT_EXPORT_FILENAME, data) === true,
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
