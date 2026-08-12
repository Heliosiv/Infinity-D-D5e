/**
 * Durable, GM-defined guided-downtime projects.
 *
 * Project progress is deliberately derived from completed downtime operation
 * receipts instead of being a separately mutable counter. That gives a
 * concurrent party one authoritative, replay-safe work history.
 */

import { normalizeGuidedDowntimeSkills } from "./dispatch.js";

export const GUIDED_DOWNTIME_PROJECT_LIMIT = 40;
export const GUIDED_PROJECT_ID_PREFIX = "project-";

const DEFAULT_IMAGE = "icons/svg/clockwork.svg";

export function normalizeGuidedDowntimeProjects(raw) {
  if (!Array.isArray(raw)) return [];
  const ids = new Set();
  const projects = [];
  for (const entry of raw.slice(0, GUIDED_DOWNTIME_PROJECT_LIMIT)) {
    const project = normalizeGuidedDowntimeProject(entry);
    if (!project || ids.has(project.id)) continue;
    ids.add(project.id);
    projects.push(project);
  }
  return projects;
}

export function normalizeGuidedDowntimeProject(
  raw = {},
  { fallbackId = "" } = {},
) {
  if (!isRecord(raw)) return null;
  const name = text(raw.name, 80);
  const id = projectId(raw.id || fallbackId || name);
  const requiredHours = wholeNumber(raw.requiredHours, 1, 10_000, 0);
  if (!id || !name || !requiredHours) return null;
  return {
    id,
    name,
    description: text(raw.description, 400),
    image: imagePath(raw.image),
    skills: normalizeGuidedDowntimeSkills(raw.skills),
    requiredHours,
  };
}

export function guidedProjectById(projects, projectIdValue) {
  const id = projectId(projectIdValue);
  return normalizeGuidedDowntimeProjects(projects).find(
    (project) => project.id === id,
  );
}

export function projectGuidedDowntimeProject(project) {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    image: project.image,
    skills: [...project.skills],
    requiredHours: project.requiredHours,
  };
}

function projectId(value) {
  const cleaned = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  if (!cleaned) return "";
  return cleaned.startsWith(GUIDED_PROJECT_ID_PREFIX)
    ? cleaned
    : `${GUIDED_PROJECT_ID_PREFIX}${cleaned}`;
}

function wholeNumber(value, minimum, maximum, fallback) {
  const number = Math.floor(Number(value));
  if (!Number.isSafeInteger(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

function imagePath(value) {
  const image = String(value ?? "").trim();
  return image && image.length <= 500 && !/[<>]/.test(image)
    ? image
    : DEFAULT_IMAGE;
}

function text(value, maximum) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
