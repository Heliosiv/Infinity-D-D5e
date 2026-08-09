/**
 * Infinity D&D5e — Tool Registry
 *
 * Module-level registry of GM tools that the role-aware Home surface exposes
 * to full GMs. Each tool registers itself once during the `init` hook; Home
 * reads back from `getTools()` at render time.
 *
 * Pure data — no Foundry imports, no DOM. The `open()` callback is
 * provided by the registrant and is the only piece the dashboard
 * actually invokes.
 *
 * Tool shape:
 *   {
 *     id:          string,   // stable kebab-case id
 *     title:       string,   // user-facing tile label
 *     description: string,   // one-sentence blurb shown under the title
 *     icon:        string,   // Font Awesome class (e.g. "fa-solid fa-coins")
 *     category:    string,   // domain bucket (e.g. "loot", "party")
 *     intent:      string,   // optional Home group; inferred when omitted
 *     status:      "available" | "coming-soon",
 *     open:        () => void  // invoked on tile click when status === "available"
 *   }
 */

const tools = new Map();

const VALID_STATUS = new Set(["available", "coming-soon"]);

/** Stable role-aware Home groups, in display order. */
export const TOOL_INTENTS = Object.freeze({
  PREPARE: "prepare",
  RUN_SESSION: "run-session",
  TRACK_CAMPAIGN: "track-campaign",
});

const VALID_INTENT = new Set(Object.values(TOOL_INTENTS));

const INTENT_BY_TOOL_ID = Object.freeze({
  "downtime-workspace": TOOL_INTENTS.RUN_SESSION,
  reputation: TOOL_INTENTS.TRACK_CAMPAIGN,
  "resource-manager": TOOL_INTENTS.TRACK_CAMPAIGN,
});

const INTENT_BY_CATEGORY = Object.freeze({
  loot: TOOL_INTENTS.RUN_SESSION,
  merchants: TOOL_INTENTS.PREPARE,
  party: TOOL_INTENTS.TRACK_CAMPAIGN,
});

/**
 * Register a tool. Re-registering with the same id replaces the
 * previous entry — useful for hot-reloading during development.
 */
export function registerTool(tool) {
  if (!tool || typeof tool !== "object") {
    throw new TypeError("registerTool: tool must be an object");
  }
  const id = String(tool.id ?? "").trim();
  if (!id) throw new TypeError("registerTool: tool.id is required");
  if (!VALID_STATUS.has(tool.status)) {
    throw new TypeError(
      `registerTool: tool.status must be one of ${[...VALID_STATUS].join(", ")} (got "${tool.status}")`,
    );
  }
  const category = String(tool.category ?? "misc");
  const suppliedIntent =
    tool.intent === undefined || tool.intent === null
      ? null
      : String(tool.intent).trim();
  if (suppliedIntent && !VALID_INTENT.has(suppliedIntent)) {
    throw new TypeError(
      `registerTool: tool.intent must be one of ${[...VALID_INTENT].join(", ")} (got "${tool.intent}")`,
    );
  }
  const normalized = Object.freeze({
    id,
    title: String(tool.title ?? id),
    description: String(tool.description ?? ""),
    icon: String(tool.icon ?? "fa-solid fa-toolbox"),
    category,
    intent:
      suppliedIntent ||
      INTENT_BY_TOOL_ID[id] ||
      INTENT_BY_CATEGORY[category] ||
      TOOL_INTENTS.PREPARE,
    status: tool.status,
    open: typeof tool.open === "function" ? tool.open : () => {},
  });
  tools.set(id, normalized);
  return normalized;
}

/** All registered tools, in registration order. */
export function getTools() {
  return [...tools.values()];
}

/** Lookup a single tool by id, or null if it's not registered. */
export function getTool(id) {
  return tools.get(String(id ?? "").trim()) ?? null;
}

/** Drop every registered tool. Test-only convenience. */
export function clearTools() {
  tools.clear();
}
