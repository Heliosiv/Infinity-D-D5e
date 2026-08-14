const NARROW_SCENARIOS = Object.freeze([
  "comfortable-380",
  "compact-380",
  "short-720",
]);

const WORKSPACE_SCENARIOS = Object.freeze([
  "comfortable-720",
  "compact-380",
  "short-720",
]);

const TARGETS = Object.freeze([
  {
    name: "Launcher and Recovery",
    match:
      /^(?:templates\/(?:dashboard|private-state-recovery)\.hbs|styles\/dashboard\.css|scripts\/(?:dashboard|primary-launcher)\.js)$/,
    fixtures: [
      "dashboard",
      "home-recovery-blocked-authority",
      "home-recovery-blocked-secondary",
      "home-player",
    ],
    scenarios: NARROW_SCENARIOS,
  },
  {
    name: "Settings",
    match:
      /^(?:templates\/settings\.hbs|styles\/settings\.css|scripts\/settings(?:-app)?\.js)$/,
    fixtures: [
      "settings-gm",
      "settings-player",
      "settings-dirty",
      "settings-saved",
      "settings-save-error",
    ],
    scenarios: NARROW_SCENARIOS,
  },
  {
    name: "Merchant workspace",
    match:
      /^(?:templates\/merchant-workspace\.hbs|styles\/merchant-workspace\.css|scripts\/merchant-workspace\.js|scripts\/merchant\/)/,
    fixtures: [
      "merchant-workspace",
      "merchant-workspace-closed",
      "merchant-workspace-save-error",
    ],
    scenarios: WORKSPACE_SCENARIOS,
  },
  {
    name: "Loot Studio",
    match:
      /^(?:templates\/(?:loot-studio|loot-forge|hoard-loot|per-creature-loot|loot-result-item)\.hbs|styles\/(?:loot-studio|loot-forge|hoard-loot|per-creature-loot)\.css|scripts\/(?:loot-studio|hoard-loot|per-creature-loot)\.js|scripts\/loot\/)/,
    fixtures: [
      "per-encounter",
      "per-encounter-loading",
      "per-encounter-unavailable",
      "hoard",
      "hoard-loading",
      "hoard-unavailable",
      "per-creature",
      "per-creature-loading",
      "per-creature-unavailable",
    ],
    scenarios: NARROW_SCENARIOS,
  },
  {
    name: "Downtime",
    match:
      /^(?:templates\/(?:downtime-workspace|downtime-activities)\.hbs|styles\/downtime\.css|scripts\/(?:downtime-workspace|downtime-activities)\.js|scripts\/downtime\/)/,
    fixtures: [
      "downtime-workspace-empty",
      "downtime-workspace-load-error",
      "downtime-workspace-collecting",
      "downtime-workspace-locked",
      "downtime-workspace-preview",
      "downtime-workspace-recovery",
      "downtime-activities-available",
      "downtime-activities-pending",
      "downtime-activities-error",
    ],
    scenarios: WORKSPACE_SCENARIOS,
  },
  {
    name: "Critical Injuries",
    match:
      /^(?:templates\/critical-injury(?:-hud|-triage)?\.hbs|styles\/critical-injury(?:-hud|-triage)?\.css|scripts\/injury\/)/,
    fixtures: [
      "critical-injury",
      "critical-injury-offline",
      "critical-injury-uncertain",
      "critical-injury-triage",
      "critical-injury-hud",
      "critical-injury-hud-offline",
      "critical-injury-hud-uncertain",
    ],
    scenarios: NARROW_SCENARIOS,
  },
]);

const FULL_AUDIT_PATH =
  /^(?:styles\/(?:tokens|ui-system)\.css|scripts\/(?:ui-harness|audit-ui-layout|infinity-app|gm-workbench(?:-routes)?|ui-preferences|ui-util)\.js|templates\/(?:gm-workbench-nav|search-picker)\.hbs)$/;
const UI_PATH =
  /^(?:templates\/|styles\/|scripts\/(?:audit-ui-layout|dashboard|primary-launcher|settings|loot|hoard-loot|per-creature-loot|merchant|downtime|injury|resource|reputation|shop-picker|search-picker|forage-prompt|chat-card|dialog-contract|infinity-app|gm-workbench|ui-))/;

export function selectUiAuditScope(paths = []) {
  const changed = [
    ...new Set(paths.map((path) => String(path).replaceAll("\\", "/"))),
  ];
  const uiPaths = changed.filter((path) => UI_PATH.test(path));
  if (uiPaths.length === 0) {
    return Object.freeze({ kind: "skip", reason: "no UI paths changed" });
  }
  if (uiPaths.some((path) => FULL_AUDIT_PATH.test(path))) {
    return Object.freeze({
      kind: "full",
      reason: "shared UI foundation changed",
    });
  }

  const matched = TARGETS.filter((target) =>
    uiPaths.some((path) => target.match.test(path)),
  );
  if (matched.length === 0) {
    return Object.freeze({
      kind: "full",
      reason: "UI path has no focused audit map",
    });
  }
  const unmatched = uiPaths.filter(
    (path) => !matched.some((target) => target.match.test(path)),
  );
  if (unmatched.length > 0) {
    return Object.freeze({
      kind: "full",
      reason: "UI path has no focused audit map",
    });
  }

  return Object.freeze({
    kind: "targeted",
    fixtures: Object.freeze([
      ...new Set(matched.flatMap((target) => target.fixtures)),
    ]),
    scenarios: Object.freeze([
      ...new Set(matched.flatMap((target) => target.scenarios)),
    ]),
    reason: matched.map((target) => target.name).join(", "),
  });
}
