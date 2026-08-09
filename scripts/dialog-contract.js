/**
 * Infinity D&D5e — shared DialogV2 contract.
 *
 * Static DialogV2 helpers differ slightly across supported Foundry releases:
 * closing can reject, and focus is not always returned to the control that
 * opened the dialog. These wrappers keep the native callback result intact
 * while making cancellation and focus behavior predictable.
 */

export const INFINITY_DIALOG_CLASSES = Object.freeze([
  "infinity-dnd5e",
  "infinity-ui",
  "infinity-dialog",
]);

/** Return true when the requested DialogV2 static helper is available. */
export function isInfinityDialogAvailable(method = null) {
  const DialogV2 = globalThis.foundry?.applications?.api?.DialogV2;
  if (!method) return Boolean(DialogV2);
  return typeof DialogV2?.[method] === "function";
}

/**
 * Clone DialogV2 options and add the module's root classes. Caller-owned
 * objects are never mutated, and an explicit rejectClose value is preserved.
 */
export function applyInfinityDialogContract(options = {}) {
  const source = isPlainObject(options) ? options : {};
  const classes = mergeClassNames(source.classes, INFINITY_DIALOG_CLASSES);
  const contracted = { ...source, classes };
  if (isPlainObject(source.window)) contracted.window = { ...source.window };
  if (!Object.prototype.hasOwnProperty.call(source, "rejectClose")) {
    contracted.rejectClose = false;
  }
  return contracted;
}

/**
 * Open a safe confirm dialog. Native return values (including false, zero,
 * empty strings, objects, null, and undefined) pass through unchanged.
 * Unavailable/throwing dialogs resolve to the caller's cancellation value.
 */
export function confirmInfinityDialog(options = {}, contract = {}) {
  return invokeDialog("confirm", options, {
    cancelValue: false,
    ...normalizeContract(contract),
  });
}

/**
 * Open a safe prompt dialog. Native callback values pass through unchanged;
 * unavailable/throwing prompts resolve to null unless overridden.
 */
export function promptInfinityDialog(options = {}, contract = {}) {
  return invokeDialog("prompt", options, {
    cancelValue: null,
    ...normalizeContract(contract),
  });
}

async function invokeDialog(method, options, contract) {
  const focusOrigin = captureFocusOrigin();
  try {
    const DialogV2 = globalThis.foundry?.applications?.api?.DialogV2;
    const invoke = DialogV2?.[method];
    if (typeof invoke !== "function") return contract.cancelValue;
    return await invoke.call(DialogV2, applyInfinityDialogContract(options));
  } catch (error) {
    try {
      contract.onError?.(error);
    } catch {
      // Recovery logging must never turn a dismissed dialog into a failure.
    }
    return contract.cancelValue;
  } finally {
    scheduleFocusRestoration(focusOrigin);
  }
}

function normalizeContract(contract) {
  if (!isPlainObject(contract)) return {};
  const normalized = {};
  if (Object.prototype.hasOwnProperty.call(contract, "cancelValue")) {
    normalized.cancelValue = contract.cancelValue;
  }
  if (typeof contract.onError === "function") {
    normalized.onError = contract.onError;
  }
  return normalized;
}

function captureFocusOrigin() {
  const document = globalThis.document;
  const active = document?.activeElement;
  if (!active || active === document?.body || !isFocusable(active)) return null;
  return active;
}

function scheduleFocusRestoration(target) {
  if (!isFocusable(target) || target?.isConnected === false) return;
  const restore = () => {
    if (!isFocusable(target) || target?.isConnected === false) return;
    try {
      target.focus({ preventScroll: true });
    } catch {
      target.focus?.();
    }
  };
  if (typeof globalThis.requestAnimationFrame === "function") {
    globalThis.requestAnimationFrame(restore);
  } else if (typeof globalThis.queueMicrotask === "function") {
    globalThis.queueMicrotask(restore);
  } else {
    globalThis.setTimeout?.(restore, 0);
  }
}

function mergeClassNames(...values) {
  const out = new Set();
  for (const value of values) {
    const entries =
      typeof value === "string"
        ? value.split(/\s+/)
        : Array.isArray(value) || value instanceof Set
          ? value
          : [];
    for (const entry of entries) {
      const token = String(entry ?? "").trim();
      if (token) out.add(token);
    }
  }
  return [...out];
}

function isFocusable(target) {
  return Boolean(
    target && typeof target.focus === "function" && target.disabled !== true,
  );
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
