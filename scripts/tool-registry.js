/**
 * Infinity D&D5e — Tool Registry
 *
 * Module-level registry of GM tools that the dashboard surfaces as
 * launcher tiles. Each tool registers itself once during the `init`
 * hook; the dashboard reads back from `getTools()` at render time.
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
 *     category:    string,   // grouping bucket (e.g. "loot", "party")
 *     status:      "available" | "coming-soon",
 *     open:        () => void  // invoked on tile click when status === "available"
 *   }
 */

const tools = new Map();

const VALID_STATUS = new Set(["available", "coming-soon"]);

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
  const normalized = Object.freeze({
    id,
    title: String(tool.title ?? id),
    description: String(tool.description ?? ""),
    icon: String(tool.icon ?? "fa-solid fa-toolbox"),
    category: String(tool.category ?? "misc"),
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
