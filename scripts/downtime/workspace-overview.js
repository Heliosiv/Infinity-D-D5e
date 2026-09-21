/**
 * Derive the compact navigation and status summary for the GM Downtime
 * workspace. This is presentation-only: authoritative workflow gates and all
 * campaign writes remain in the downtime service/adapter.
 */
export function buildDowntimeWorkspaceOverview({
  view = "current",
  currentBlock = null,
  guidedTemplates = [],
  guidedProjects = [],
  researchSeeds = [],
  researchCases = [],
  settlements = [],
  history = [],
  needsRecovery = false,
} = {}) {
  const participants = rows(currentBlock?.participants);
  const readyCount = countWhere(
    participants,
    (row) => row?.canPrepare === true,
  );
  const resolvedCount = Number.isFinite(Number(currentBlock?.resolvedCount))
    ? Math.max(0, Number(currentBlock.resolvedCount))
    : countWhere(participants, (row) => row?.resolved === true);
  const submittedCount = Number.isFinite(Number(currentBlock?.submittedCount))
    ? Math.max(0, Number(currentBlock.submittedCount))
    : countWhere(participants, (row) => row?.submitted === true);
  const waitingCount = Math.max(
    0,
    participants.length - resolvedCount - readyCount,
  );
  const researchAttentionCount = countWhere(
    rows(researchCases),
    (entry) => entry?.needsWorldBuilding === true || entry?.approved !== true,
  );

  return {
    guide: guideFor(view),
    navigation: {
      current: needsRecovery
        ? { count: 1, label: "recovery needed", tone: "danger" }
        : currentBlock
          ? {
              count: readyCount,
              label:
                readyCount === 1 ? "submission ready" : "submissions ready",
              tone: readyCount > 0 ? "accent" : "muted",
            }
          : { count: 0, label: "no active block", tone: "muted" },
      activities: countBadge(guidedTemplates, "activity", "activities"),
      projects: countBadge(guidedProjects, "project", "projects"),
      research:
        researchAttentionCount > 0
          ? {
              count: researchAttentionCount,
              label:
                researchAttentionCount === 1
                  ? "case needs attention"
                  : "cases need attention",
              tone: "warning",
            }
          : countBadge(researchSeeds, "seed", "seeds"),
      settlements: countBadge(settlements, "settlement", "settlements"),
      history: countBadge(history, "receipt", "receipts"),
    },
    block: {
      participantCount: participants.length,
      submittedCount,
      readyCount,
      resolvedCount,
      waitingCount,
      hasReady: readyCount > 0,
    },
  };
}

function guideFor(view) {
  const guides = {
    current: {
      eyebrow: "Run the table",
      title: "Current downtime",
      description:
        "Follow the highlighted next action. Player submissions and GM review can progress without losing anyone's place.",
      icon: "fa-route",
    },
    activities: {
      eyebrow: "Player choices",
      title: "Activity library",
      description:
        "Define reusable choices for future blocks. Open blocks keep their frozen rules and rewards.",
      icon: "fa-list-check",
    },
    projects: {
      eyebrow: "Long-term progress",
      title: "Projects",
      description:
        "Prepare shared or personal goals, then offer them alongside activities in a future block.",
      icon: "fa-diagram-project",
    },
    research: {
      eyebrow: "Private preparation",
      title: "Research & Rumors",
      description:
        "Curate discoverable subjects and finish cases that need GM-authored world-building.",
      icon: "fa-book-open-reader",
    },
    settlements: {
      eyebrow: "Reusable locations",
      title: "Settlement profiles",
      description:
        "Choose which activities and shops belong to a saved location without opening or moving those shops.",
      icon: "fa-city",
    },
    history: {
      eyebrow: "Receipts",
      title: "Downtime history",
      description:
        "Review completed and cancelled blocks. Historical results remain read-only campaign evidence.",
      icon: "fa-clock-rotate-left",
    },
  };
  return guides[view] ?? guides.current;
}

function countBadge(value, singular, plural) {
  const count = rows(value).length;
  return {
    count,
    label: count === 1 ? singular : plural,
    tone: "muted",
  };
}

function countWhere(value, predicate) {
  return value.reduce((count, entry) => count + Number(predicate(entry)), 0);
}

function rows(value) {
  return Array.isArray(value) ? value : [];
}
