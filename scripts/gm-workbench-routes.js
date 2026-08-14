/**
 * Infinity D&D5e - bounded GM Workbench navigation contract.
 *
 * This module is intentionally Foundry-free so route sanitization and the
 * player/privacy boundary remain executable in Node tests.
 */

export const GM_WORKBENCH_ROUTES = Object.freeze([
  "merchants",
  "quartermaster",
  "downtime",
  "factions",
  "injuries",
]);

export const DEFAULT_GM_WORKBENCH_ROUTE = GM_WORKBENCH_ROUTES[0];

export const GM_WORKBENCH_ROUTE_DEFINITIONS = Object.freeze([
  Object.freeze({
    route: "merchants",
    label: "Merchants",
    shortLabel: "Merchants",
    icon: "fa-solid fa-store",
    description:
      "Curate inventories and access, then open safe player shopping sessions.",
    theme: "merchant",
  }),
  Object.freeze({
    route: "quartermaster",
    label: "Quartermaster",
    shortLabel: "Supplies",
    icon: "fa-solid fa-campground",
    description:
      "Run daily supplies, review receipts, and maintain party resource rules.",
    theme: "quartermaster",
  }),
  Object.freeze({
    route: "downtime",
    label: "Downtime",
    shortLabel: "Downtime",
    icon: "fa-solid fa-hourglass-half",
    description:
      "Coordinate current blocks, long-term projects, settlements, and history.",
    theme: "downtime",
  }),
  Object.freeze({
    route: "factions",
    label: "Factions",
    shortLabel: "Factions",
    icon: "fa-solid fa-handshake",
    description:
      "Track standing, player reveals, character context, and reasoned history.",
    theme: "factions",
  }),
  Object.freeze({
    route: "injuries",
    label: "Injury Triage",
    shortLabel: "Injuries",
    icon: "fa-solid fa-heart-pulse",
    description:
      "Review recoveries, send private rolls, and follow active party injuries.",
    theme: "injury",
  }),
]);

const ROUTE_SET = new Set(GM_WORKBENCH_ROUTES);
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,79}$/i;
const SUBVIEW_BY_ROUTE = Object.freeze({
  merchants: new Set(["overview", "pricing", "stock", "access", "sessions"]),
  quartermaster: new Set(["today", "recent", "setup"]),
  downtime: new Set(["current", "projects", "settlements", "history"]),
  factions: new Set(["overview", "visibility", "history"]),
  injuries: new Set(["triage", "recovery"]),
});

export function isGmWorkbenchRoute(value) {
  return ROUTE_SET.has(String(value ?? "").trim());
}

export function sanitizeGmWorkbenchRoute(
  value,
  fallback = DEFAULT_GM_WORKBENCH_ROUTE,
) {
  const route = String(value ?? "").trim();
  if (ROUTE_SET.has(route)) return route;
  const safeFallback = String(fallback ?? "").trim();
  return ROUTE_SET.has(safeFallback)
    ? safeFallback
    : DEFAULT_GM_WORKBENCH_ROUTE;
}

export function sanitizeGmWorkbenchSubView(route, value) {
  const candidate = String(value ?? "").trim();
  return SUBVIEW_BY_ROUTE[sanitizeGmWorkbenchRoute(route)]?.has(candidate)
    ? candidate
    : "";
}

export function sanitizeGmWorkbenchEntityId(value) {
  if (typeof value !== "string") return "";
  const identifier = value.trim();
  return IDENTIFIER_PATTERN.test(identifier) ? identifier : "";
}

/** Reduce external, remembered, or data-attribute input to the public shape. */
export function normalizeGmWorkbenchTarget(value, fallbackRoute) {
  const source = value && typeof value === "object" ? value : {};
  const route = sanitizeGmWorkbenchRoute(source.route, fallbackRoute);
  const target = { route };
  const subview = sanitizeGmWorkbenchSubView(route, source.subview);
  const entityId = sanitizeGmWorkbenchEntityId(source.entityId);
  if (subview) target.subview = subview;
  if (entityId) target.entityId = entityId;
  return target;
}

export function getGmWorkbenchRouteDefinition(route) {
  const safeRoute = sanitizeGmWorkbenchRoute(route);
  return (
    GM_WORKBENCH_ROUTE_DEFINITIONS.find(
      (definition) => definition.route === safeRoute,
    ) ?? GM_WORKBENCH_ROUTE_DEFINITIONS[0]
  );
}

export function buildGmWorkbenchNavigationContext(target) {
  const normalized = normalizeGmWorkbenchTarget(target);
  const active = getGmWorkbenchRouteDefinition(normalized.route);
  return {
    ...normalized,
    label: active.label,
    description: active.description,
    theme: active.theme,
    routes: GM_WORKBENCH_ROUTE_DEFINITIONS.map((definition) => ({
      ...definition,
      active: definition.route === normalized.route,
    })),
  };
}
