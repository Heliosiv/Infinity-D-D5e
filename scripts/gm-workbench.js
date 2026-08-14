/**
 * Infinity D&D5e - routed full-GM Workbench foundation.
 *
 * Each route remains its established ApplicationV2 controller. This shared
 * base owns only bounded navigation, remembered client route, position handoff,
 * and lifecycle coordination; it never reads or writes campaign data.
 */

import { applyUiFoundation } from "./infinity-app.js";
import { isFullGM } from "./permissions.js";
import { getUiPreferences, updateUiPreferences } from "./ui-preferences.js";
import {
  buildGmWorkbenchNavigationContext,
  DEFAULT_GM_WORKBENCH_ROUTE,
  GM_WORKBENCH_ROUTES,
  normalizeGmWorkbenchTarget,
  sanitizeGmWorkbenchRoute,
} from "./gm-workbench-routes.js";

const MODULE_ID = "infinity-dnd5e";
export const GM_WORKBENCH_TEMPLATE_PATH = `modules/${MODULE_ID}/templates/gm-workbench-nav.hbs`;
const routeAdapters = new Map();
const utilityAdapters = new Map();
const rememberedTargets = new Map();
let activeApplication = null;

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class GmWorkbenchApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    actions: {
      navigateGmWorkbench: GmWorkbenchApp._onNavigate,
      openGmWorkbenchUtility: GmWorkbenchApp._onOpenUtility,
    },
  };

  static open(options = {}) {
    return openGmWorkbench(options);
  }

  constructor(options = {}) {
    const { workbench = null, ...applicationOptions } = options;
    super(applicationOptions);
    this._gmWorkbenchTarget = normalizeGmWorkbenchTarget(
      workbench,
      this.constructor.WORKBENCH_ROUTE ?? DEFAULT_GM_WORKBENCH_ROUTE,
    );
    this._gmWorkbenchSwitching = false;
  }

  prepareWorkbenchContext(overrides = {}) {
    return {
      ...buildGmWorkbenchNavigationContext(this.captureWorkbenchTarget()),
      ...overrides,
    };
  }

  setWorkbenchTarget(target) {
    this._gmWorkbenchTarget = normalizeGmWorkbenchTarget(
      target,
      this.constructor.WORKBENCH_ROUTE,
    );
    this._applyWorkbenchTarget?.(this._gmWorkbenchTarget);
    return this._gmWorkbenchTarget;
  }

  captureWorkbenchTarget() {
    return normalizeGmWorkbenchTarget(
      this._captureWorkbenchTarget?.() ?? this._gmWorkbenchTarget,
      this.constructor.WORKBENCH_ROUTE,
    );
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    if (typeof this.captureWorkbenchTarget !== "function") return;
    if (this._gmWorkbenchSwitching) {
      void this.close?.({ animate: false });
      return;
    }
    activeApplication = this;
    const target = this.captureWorkbenchTarget();
    rememberedTargets.set(target.route, target);
    applyUiFoundation(this.element);
    this.element?.classList?.add?.("infinity-gm-workbench");
    if (this.element?.dataset) {
      this.element.dataset.gmWorkbenchRoute = target.route;
      this.element.dataset.infinityTheme =
        buildGmWorkbenchNavigationContext(target).theme;
    }
    void rememberGmWorkbenchRoute(target.route);
  }

  _onClose(options) {
    if (typeof this.captureWorkbenchTarget === "function") {
      const target = this.captureWorkbenchTarget();
      rememberedTargets.set(target.route, target);
    }
    if (activeApplication === this) activeApplication = null;
    super._onClose?.(options);
  }

  /** @this {GmWorkbenchApp} */
  static async _onNavigate(event, target) {
    event?.preventDefault?.();
    const route = String(target?.dataset?.workbenchRoute ?? "").trim();
    const subview = String(target?.dataset?.workbenchSubview ?? "").trim();
    const entityId = String(target?.dataset?.workbenchEntityId ?? "").trim();
    try {
      const ready = await this._beforeWorkbenchNavigate?.();
      if (ready === false) return null;
    } catch (error) {
      console.warn(`${MODULE_ID} | Workbench route change was stopped`, error);
      globalThis.ui?.notifications?.error?.(
        "This workspace still has a change that could not be saved. Review it before switching tools.",
      );
      return null;
    }
    return openGmWorkbench({
      route,
      subview,
      entityId,
      _sourceApplication: this,
    });
  }

  /** @this {GmWorkbenchApp} */
  static async _onOpenUtility(event, target) {
    event?.preventDefault?.();
    if (!isFullGM()) {
      globalThis.ui?.notifications?.warn?.(
        "Workbench utilities are available to full Game Masters only.",
      );
      return null;
    }
    const utility = String(target?.dataset?.workbenchUtility ?? "").trim();
    const adapter = utilityAdapters.get(utility);
    if (!adapter) {
      globalThis.ui?.notifications?.warn?.(
        "That Workbench utility is not available. Nothing changed.",
      );
      return null;
    }
    try {
      return await adapter.open();
    } catch (error) {
      console.warn(`${MODULE_ID} | Workbench utility did not open`, error);
      globalThis.ui?.notifications?.error?.(
        "That Workbench utility did not open. Nothing changed; try again.",
      );
      return null;
    }
  }
}

/** Configure route adapters once the established applications are imported. */
export function configureGmWorkbench(adapters = {}, utilities = {}) {
  routeAdapters.clear();
  for (const route of GM_WORKBENCH_ROUTES) {
    const adapter = adapters[route];
    if (typeof adapter?.open !== "function") continue;
    routeAdapters.set(route, adapter);
  }
  utilityAdapters.clear();
  for (const [utility, adapter] of Object.entries(utilities)) {
    if (typeof adapter?.open !== "function") continue;
    utilityAdapters.set(utility, adapter);
  }
  return routeAdapters.size;
}

/** Open a sanitized route and hand the previous Workbench position across. */
export function openGmWorkbench(options = {}) {
  if (!isFullGM()) {
    globalThis.ui?.notifications?.warn?.(
      "The GM Workbench is available to full Game Masters only.",
    );
    return null;
  }

  const requested = normalizeGmWorkbenchTarget(
    options,
    Object.hasOwn(options ?? {}, "route")
      ? DEFAULT_GM_WORKBENCH_ROUTE
      : rememberedRoute(),
  );
  const adapter =
    routeAdapters.get(requested.route) ??
    routeAdapters.get(DEFAULT_GM_WORKBENCH_ROUTE) ??
    routeAdapters.values().next().value;
  if (!adapter) {
    globalThis.ui?.notifications?.error?.(
      "The GM Workbench is still starting. Try opening it again in a moment.",
    );
    return null;
  }

  const fallbackTarget = rememberedTargets.get(requested.route);
  const explicitSubview = Object.hasOwn(options ?? {}, "subview");
  const explicitEntity = Object.hasOwn(options ?? {}, "entityId");
  const target = normalizeGmWorkbenchTarget(
    {
      ...(fallbackTarget ?? {}),
      ...requested,
      ...(explicitSubview ? { subview: requested.subview } : {}),
      ...(explicitEntity ? { entityId: requested.entityId } : {}),
    },
    requested.route,
  );

  if (
    activeApplication?.rendered &&
    activeApplication.captureWorkbenchTarget?.().route === target.route
  ) {
    activeApplication.setWorkbenchTarget?.(target);
    void activeApplication.render?.(false);
    activeApplication.bringToFront?.();
    return activeApplication;
  }

  const previous = options?._sourceApplication ?? activeApplication;
  const position = capturePosition(previous?.position);
  if (previous) {
    previous._gmWorkbenchSwitching = true;
    try {
      const closing = previous.close?.({ animate: false });
      closing?.catch?.((error) =>
        console.warn(
          `${MODULE_ID} | previous Workbench route did not close`,
          error,
        ),
      );
    } catch (error) {
      console.warn(
        `${MODULE_ID} | previous Workbench route did not close`,
        error,
      );
    }
  }

  const app = adapter.open({
    workbench: target,
    ...target,
    ...(position ? { position } : {}),
  });
  if (!app) return null;
  app._gmWorkbenchSwitching = false;
  app.setWorkbenchTarget?.(target);
  if (position && app.element?.style) app.setPosition?.(position);
  activeApplication = app;
  rememberedTargets.set(target.route, target);
  void rememberGmWorkbenchRoute(target.route);
  return app;
}

export function getActiveGmWorkbenchApplication() {
  return activeApplication;
}

function rememberedRoute() {
  return sanitizeGmWorkbenchRoute(
    getUiPreferences()?.lastGmWorkbenchRoute,
    DEFAULT_GM_WORKBENCH_ROUTE,
  );
}

async function rememberGmWorkbenchRoute(route) {
  const safeRoute = sanitizeGmWorkbenchRoute(route);
  if (getUiPreferences()?.lastGmWorkbenchRoute === safeRoute) return;
  try {
    await updateUiPreferences({ lastGmWorkbenchRoute: safeRoute });
  } catch (error) {
    console.warn(
      `${MODULE_ID} | could not remember the GM Workbench route`,
      error,
    );
  }
}

function capturePosition(position) {
  if (!position || typeof position !== "object") return null;
  const safe = {};
  for (const key of ["left", "top", "width", "height"]) {
    const value = Number(position[key]);
    if (Number.isFinite(value)) safe[key] = value;
  }
  return Object.keys(safe).length > 0 ? safe : null;
}
