/**
 * The intentionally small, GM-guided downtime model.
 *
 * It is separate from the legacy city-action catalog: a template describes
 * one player-facing activity and three to six GM-selectable report outcomes.
 * Templates contain no hidden DCs, faction state, settlement state, or
 * privileged document data.
 */

import { normalizeGuidedWork, guidedWorkPreset } from "./work.js";
import { normalizeDowntimeBenefit } from "./benefit-rules.js";
import { ADDITIONAL_GUIDED_ACTIVITIES } from "./activity-library.js";
import {
  FIELD_OUTPUT,
  fieldTemplate,
  fieldChoice,
} from "./field-ammunition.js";

export const GUIDED_DOWNTIME_MODE = "guided";
export const GUIDED_DOWNTIME_TEMPLATE_LIMIT = 28;
export const GUIDED_DOWNTIME_OUTCOME_MINIMUM = 3;
export const GUIDED_DOWNTIME_OUTCOME_MAXIMUM = 6;
export const GUIDED_DOWNTIME_DEFAULT_BLOCK_HOURS = 8;

const DEFAULT_IMAGE = "icons/svg/d20.svg";
export const GUIDED_DOWNTIME_SKILLS = Object.freeze([
  Object.freeze({ id: "acr", label: "Acrobatics" }),
  Object.freeze({ id: "ani", label: "Animal Handling" }),
  Object.freeze({ id: "arc", label: "Arcana" }),
  Object.freeze({ id: "ath", label: "Athletics" }),
  Object.freeze({ id: "dec", label: "Deception" }),
  Object.freeze({ id: "his", label: "History" }),
  Object.freeze({ id: "ins", label: "Insight" }),
  Object.freeze({ id: "itm", label: "Intimidation" }),
  Object.freeze({ id: "inv", label: "Investigation" }),
  Object.freeze({ id: "med", label: "Medicine" }),
  Object.freeze({ id: "nat", label: "Nature" }),
  Object.freeze({ id: "prc", label: "Perception" }),
  Object.freeze({ id: "prf", label: "Performance" }),
  Object.freeze({ id: "per", label: "Persuasion" }),
  Object.freeze({ id: "rel", label: "Religion" }),
  Object.freeze({ id: "slt", label: "Sleight of Hand" }),
  Object.freeze({ id: "ste", label: "Stealth" }),
  Object.freeze({ id: "sur", label: "Survival" }),
]);

const SKILL_LABELS = new Map(
  GUIDED_DOWNTIME_SKILLS.map(({ id, label }) => [id, label]),
);
const SKILL_IDS = new Set(SKILL_LABELS.keys());

export function guidedDowntimeSkillLabel(skill) {
  return SKILL_LABELS.get(idValue(skill)) ?? "Unknown skill";
}

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
        rewardGp: 1,
      },
      {
        label: "Solid wages",
        report: "You completed the job cleanly and were paid fairly.",
        rewardGp: 2,
      },
      {
        label: "In demand",
        report: "Your work stood out and the foreman paid a premium.",
        rewardGp: 4,
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
        rewardGp: 0,
      },
      {
        label: "Breakthrough",
        report: "You uncovered a valuable connection the GM can build on.",
        rewardGp: 0,
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
        rewardGp: 2,
      },
      {
        label: "Clean haul",
        report: "A bold but controlled play paid off handsomely.",
        rewardGp: 6,
      },
    ],
  },
]);

export function defaultGuidedDowntimeTemplates() {
  return includeCampaignDowntimeTemplates(
    [...DEFAULT_TEMPLATES, ...ADDITIONAL_GUIDED_ACTIVITIES].map((template) =>
      normalizeGuidedDowntimeTemplate(template),
    ),
  );
}

/** Extend the campaign library only; assigned block snapshots stay unchanged. */
export function normalizeGuidedDowntimeLibrary(raw) {
  const templates = normalizeGuidedDowntimeTemplates(raw);
  const ids = new Set(templates.map((template) => template.id));
  for (const entry of ADDITIONAL_GUIDED_ACTIVITIES) {
    if (templates.length >= GUIDED_DOWNTIME_TEMPLATE_LIMIT) break;
    if (ids.has(entry.id)) continue;
    templates.push(normalizeGuidedDowntimeTemplate(entry));
    ids.add(entry.id);
  }
  return includeCampaignDowntimeTemplates(templates);
}

export function campaignDowntimeTemplates() {
  return [
    fieldTemplate(),
    {
      id: "guided-train-spar",
      name: "Train & Spar",
      description:
        "Practice footwork and timing. A strong result readies your next attack for up to 12 hours.",
      image: "icons/skills/melee/weapons-crossed-swords-yellow.webp",
      skills: ["ath", "acr"],
      outcomes: [
        {
          label: "Finding your footing",
          report: "Practice exposed a few habits to work on.",
          rewardGp: 0,
        },
        {
          label: "Solid practice",
          report: "You leave with a better feel for your technique.",
          rewardGp: 0,
        },
        {
          label: "Ready for the fight",
          report:
            "Your next attack gains +1. The benefit expires after that attack or 12 in-game hours.",
          rewardGp: 0,
          benefit: "sparring",
        },
      ],
    },
    {
      id: "guided-tend-sick",
      name: "Tend the Sick",
      description:
        "Care for an injured companion. A strong result after eight hours can shorten one timed injury by a day.",
      image: "icons/skills/wounds/injury-face-impact-orange.webp",
      skills: ["med"],
      outcomes: [
        {
          label: "Comfort and rest",
          report:
            "Your patient is more comfortable, but recovery takes its normal course.",
          rewardGp: 0,
        },
        {
          label: "Steady care",
          report: "You keep the patient rested and cared for.",
          rewardGp: 0,
        },
        {
          label: "Recovery progress",
          report: "Your skilled care helped your patient rest and recover.",
          rewardGp: 0,
          benefit: "injury-care",
        },
      ],
    },
    { ...guidedWorkPreset("arrows"), id: "guided-craft-arrows" },
    { ...guidedWorkPreset("scroll"), id: "guided-scribe-scroll" },
    guidedWorkPreset("learn-spell"),
    {
      id: "guided-focused-study",
      name: "Focused Study",
      description:
        "Organize notes, rehearse difficult procedures, and prepare a clear plan. A strong result grants +1 to ability and skill checks for 8 hours after the block ends.",
      image: "icons/sundries/books/book-open-purple.webp",
      skills: ["arc", "his", "inv", "nat", "rel"],
      outcomes: [
        {
          label: "Notes in progress",
          report:
            "You sorted the material and identified what still needs investigation.",
          rewardGp: 0,
        },
        {
          label: "Clear preparation",
          report: "Your notes now give you a reliable plan for the work ahead.",
          rewardGp: 0,
        },
        {
          label: "Prepared mind",
          report:
            "A careful breakthrough left the important details clear and ready to use.",
          rewardGp: 0,
          benefit: "focused-study",
        },
      ],
    },
    {
      id: "guided-seek-blessing",
      name: "Seek a Blessing",
      description:
        "Pray, meditate, or seek counsel within a spiritual tradition. A strong result grants +1 to saving throws for 8 hours after the block ends.",
      image: "icons/magic/holy/prayer-hands-glowing-yellow.webp",
      skills: ["rel", "ins", "per"],
      outcomes: [
        {
          label: "Quiet observance",
          report:
            "The observance offered calm, though no clear sign or answer followed.",
          rewardGp: 0,
        },
        {
          label: "Steady counsel",
          report:
            "The ritual and counsel helped you face the next challenge with purpose.",
          rewardGp: 0,
        },
        {
          label: "Blessed resolve",
          report:
            "You leave the observance with an unusual steadiness of mind and spirit.",
          rewardGp: 0,
          benefit: "blessed-resolve",
        },
      ],
    },
    {
      id: "guided-trail-conditioning",
      name: "Trail Conditioning",
      description:
        "Practice loaded marches, route pacing, and efficient movement. A strong result grants +5 feet of walking speed for 8 hours after the block ends.",
      image: "icons/skills/movement/feet-winged-boots-blue.webp",
      skills: ["ath", "sur", "acr"],
      outcomes: [
        {
          label: "Heavy legs",
          report:
            "The route exposed where your pace and equipment still need adjustment.",
          rewardGp: 0,
        },
        {
          label: "Measured pace",
          report:
            "You found a sustainable rhythm and corrected some wasted movement.",
          rewardGp: 0,
        },
        {
          label: "Trail ready",
          report:
            "The conditioning session left your stride quick, controlled, and efficient.",
          rewardGp: 0,
          benefit: "trail-ready",
        },
      ],
    },
    {
      id: "guided-defensive-drills",
      name: "Defensive Drills",
      description:
        "Practice guard positions, coordinated movement, and recovering safely after a committed attack.",
      image: "icons/equipment/shield/heater-steel-sword-yellow-black.webp",
      skills: ["ath", "acr", "ins"],
      outcomes: [
        {
          label: "Openings exposed",
          report:
            "The drills revealed a few defensive habits that still need work.",
          rewardGp: 0,
        },
        {
          label: "Steady guard",
          report:
            "Repeated practice made your guard more consistent under pressure.",
          rewardGp: 0,
        },
        {
          label: "Guarded and ready",
          report:
            "Your defensive reactions are sharp and ready for the next challenge.",
          rewardGp: 0,
          benefit: "guarded-drills",
        },
      ],
    },
  ];
}

/** Add missing campaign entries while retaining saved names, prose and recipes. */
export function includeCampaignDowntimeTemplates(templates) {
  const result = structuredClone(templates);
  const nameKey = (name) =>
    name
      .toLowerCase()
      .replace(/\band\b/g, "")
      .replace(/[^a-z]/g, "");
  for (const builtin of campaignDowntimeTemplates()) {
    const existing = result.find(
      (entry) =>
        entry.id === builtin.id ||
        nameKey(entry.name) === nameKey(builtin.name) ||
        (builtin.work && entry.work?.output === builtin.work.output),
    );
    if (existing) {
      // Upgrade the stock arrow recipe only. Saved custom tools and open-block
      // snapshots remain authoritative; a recipe change has separate progress.
      if (
        existing.id === "guided-craft-arrows" &&
        existing.work?.output === "arrows" &&
        !existing.work.tool &&
        !Object.hasOwn(existing.work, "requiredTools")
      )
        existing.work.requiredTools = [...builtin.work.requiredTools];
      const previousDescriptions = {
        "guided-training":
          "Practice footwork, endurance, or technique with a willing partner or instructor. Instruction costs 1 gp per workday. The GM records progress; this does not automatically grant proficiency or combat bonuses.",
        "guided-care":
          "Assist a healer, prepare clean dressings, and care for people who need help. Supplies cost 0.5 gp per workday. The GM decides any recovery; no HP, conditions, or injuries change automatically.",
      };
      if (existing.description === previousDescriptions[existing.id]) {
        existing.description = ADDITIONAL_GUIDED_ACTIVITIES.find(
          (entry) => entry.id === existing.id,
        ).description;
      }
      // Only supply the requested third-result benefit when not configured yet.
      if (
        builtin.outcomes[2].benefit &&
        existing.outcomes[2] &&
        !Object.hasOwn(existing.outcomes[2], "benefit")
      ) {
        existing.outcomes[2].benefit = builtin.outcomes[2].benefit;
      }
    } else if (result.length < GUIDED_DOWNTIME_TEMPLATE_LIMIT) {
      result.push(normalizeGuidedDowntimeTemplate(builtin));
    }
  }
  return result;
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
  const work = normalizeGuidedWork(raw.work);
  return {
    id,
    name,
    description: text(raw.description, 400),
    image: imagePath(raw.image),
    blockHours:
      work?.output === FIELD_OUTPUT
        ? 1
        : guidedBlockHours(
            raw.blockHours,
            id === "guided-reflection"
              ? 1
              : GUIDED_DOWNTIME_DEFAULT_BLOCK_HOURS,
          ),
    skills:
      work?.output === FIELD_OUTPUT
        ? ["slt", "sur"]
        : normalizeSkills(raw.skills),
    outcomes:
      work?.output === FIELD_OUTPUT
        ? fieldTemplate().outcomes.map((outcome, index) => ({
            ...outcome,
            report: outcomes[index]?.report || outcome.report,
          }))
        : outcomes,
    ...(work ? { work } : {}),
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
    ...(Object.hasOwn(raw, "benefit")
      ? { benefit: normalizeDowntimeBenefit(raw.benefit) }
      : {}),
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
  if (template.work?.output === FIELD_OUTPUT) fieldChoice(raw.targetId);
  return {
    templateId,
    skill: template.skills.length > 0 ? skill : "",
    ...(["scroll", "learn-spell", FIELD_OUTPUT].includes(template.work?.output)
      ? { targetId: idValue(raw.targetId) }
      : {}),
  };
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
    blockHours: template.blockHours,
    skills: [...template.skills],
    ...(template.work ? { work: structuredClone(template.work) } : {}),
  };
}

export function guidedDowntimeBlockHours(value, fallback = 8) {
  return guidedBlockHours(value, fallback);
}

function normalizeSkills(raw) {
  return normalizeGuidedDowntimeSkills(raw);
}

export function normalizeGuidedDowntimeSkills(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map(idValue).filter((skill) => SKILL_IDS.has(skill)))];
}

function decimal(value, minimum, maximum) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.round(numeric * 100) / 100));
}

function guidedBlockHours(value, fallback) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 1 || numeric > 240) {
    return fallback;
  }
  return numeric;
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
