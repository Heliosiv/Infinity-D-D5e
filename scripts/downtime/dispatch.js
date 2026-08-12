/**
 * The intentionally small, GM-guided downtime model.
 *
 * It is separate from the legacy city-action catalog: a template describes
 * one player-facing activity and three to six GM-selectable report outcomes.
 * Templates contain no hidden DCs, faction state, settlement state, or
 * privileged document data.
 */

export const GUIDED_DOWNTIME_MODE = "guided";
export const GUIDED_DOWNTIME_TEMPLATE_LIMIT = 24;
export const GUIDED_DOWNTIME_OUTCOME_MINIMUM = 3;
export const GUIDED_DOWNTIME_OUTCOME_MAXIMUM = 6;

const DEFAULT_IMAGE = "icons/svg/d20.svg";
const SKILL_IDS = new Set([
  "acr",
  "ani",
  "arc",
  "ath",
  "dec",
  "his",
  "ins",
  "itm",
  "inv",
  "med",
  "nat",
  "prc",
  "prf",
  "per",
  "rel",
  "slt",
  "ste",
  "sur",
]);

const DEFAULT_TEMPLATES = Object.freeze([
  {
    id: "guided-labor",
    name: "Paid Work",
    description: "Find honest work and turn the available time into wages.",
    image: "icons/skills/social/diplomacy-handshake.webp",
    skills: ["ath", "per", "sur"],
    outcomes: [
      {
        label: "A lean day",
        report: "The work was scarce, but you made a useful contact.",
        rewardGp: 2,
      },
      {
        label: "Solid wages",
        report: "You completed the job cleanly and were paid fairly.",
        rewardGp: 5,
      },
      {
        label: "In demand",
        report: "Your work stood out and the foreman paid a premium.",
        rewardGp: 10,
      },
    ],
  },
  {
    id: "guided-research",
    name: "Research & Rumors",
    description:
      "Follow a lead, study, or work a local network for useful information.",
    image: "icons/sundries/books/book-red-exclamation.webp",
    skills: ["arc", "his", "inv", "nat", "rel"],
    outcomes: [
      {
        label: "Loose thread",
        report: "You found a small clue worth keeping in your notes.",
        rewardGp: 0,
      },
      {
        label: "Useful lead",
        report: "Your research produced a clear lead for the party to pursue.",
        rewardGp: 2,
      },
      {
        label: "Breakthrough",
        report: "You uncovered a valuable connection the GM can build on.",
        rewardGp: 5,
      },
    ],
  },
  {
    id: "guided-thievery",
    name: "Thievery",
    description:
      "Work a discreet angle. The GM decides how much trouble or opportunity it creates.",
    image: "icons/skills/trades/thief-lockpicks-gray.webp",
    skills: ["dec", "ins", "slt", "ste"],
    outcomes: [
      {
        label: "Empty pockets",
        report: "The opportunity dried up before you could profit.",
        rewardGp: 0,
      },
      {
        label: "Quiet score",
        report: "You came away with a small, unremarkable score.",
        rewardGp: 4,
      },
      {
        label: "Clean haul",
        report: "A bold but controlled play paid off handsomely.",
        rewardGp: 12,
      },
    ],
  },
]);

export function defaultGuidedDowntimeTemplates() {
  return DEFAULT_TEMPLATES.map((template) =>
    normalizeGuidedDowntimeTemplate(template),
  );
}

export function normalizeGuidedDowntimeTemplates(raw) {
  const source = Array.isArray(raw) ? raw : defaultGuidedDowntimeTemplates();
  const ids = new Set();
  const templates = [];
  for (const entry of source.slice(0, GUIDED_DOWNTIME_TEMPLATE_LIMIT)) {
    const template = normalizeGuidedDowntimeTemplate(entry);
    if (!template || ids.has(template.id)) continue;
    ids.add(template.id);
    templates.push(template);
  }
  return templates.length >= 1 ? templates : defaultGuidedDowntimeTemplates();
}

export function normalizeGuidedDowntimeTemplate(raw = {}) {
  if (!isRecord(raw)) return null;
  const name = text(raw.name, 80);
  const id = idValue(raw.id) || slugId(name);
  const outcomes = (Array.isArray(raw.outcomes) ? raw.outcomes : [])
    .slice(0, GUIDED_DOWNTIME_OUTCOME_MAXIMUM)
    .map(normalizeGuidedDowntimeOutcome)
    .filter(Boolean);
  if (!id || !name || outcomes.length < GUIDED_DOWNTIME_OUTCOME_MINIMUM)
    return null;
  return {
    id,
    name,
    description: text(raw.description, 400),
    image: imagePath(raw.image),
    skills: normalizeSkills(raw.skills),
    outcomes,
  };
}

export function normalizeGuidedDowntimeOutcome(raw = {}) {
  if (!isRecord(raw)) return null;
  const label = text(raw.label, 80);
  const report = text(raw.report, 800);
  if (!label || !report) return null;
  return {
    label,
    report,
    rewardGp: decimal(raw.rewardGp, 0, 100000),
  };
}

export function normalizeGuidedDowntimeSelection(raw = {}, templates = []) {
  if (!isRecord(raw)) return null;
  const templateId = idValue(raw.templateId);
  const template = templates.find((entry) => entry.id === templateId);
  if (!template) return null;
  const skill = idValue(raw.skill);
  if (template.skills.length > 0 && !template.skills.includes(skill))
    return null;
  return { templateId, skill: template.skills.length > 0 ? skill : "" };
}

export function guidedTemplateById(templates, templateId) {
  return (
    normalizeGuidedDowntimeTemplates(templates).find(
      (template) => template.id === idValue(templateId),
    ) ?? null
  );
}

export function projectGuidedDowntimeTemplate(template) {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    image: template.image,
    skills: [...template.skills],
  };
}

function normalizeSkills(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map(idValue).filter((skill) => SKILL_IDS.has(skill)))];
}

function decimal(value, minimum, maximum) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.round(numeric * 100) / 100));
}

function imagePath(value) {
  const image = String(value ?? "").trim();
  return image && image.length <= 500 && !/[<>]/.test(image)
    ? image
    : DEFAULT_IMAGE;
}

function idValue(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_.:-]/g, "")
    .slice(0, 80);
}

function slugId(value) {
  const slug = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug ? `guided-${slug}` : "";
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
