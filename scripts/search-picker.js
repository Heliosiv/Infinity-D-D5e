/**
 * Searchable, keyboard-friendly picker over caller-supplied allowlisted data.
 *
 * The picker never discovers documents or writes data itself. Callers build a
 * bounded list of options, then revalidate the returned ids before mutation.
 */

const MODULE_ID = "infinity-dnd5e";
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/search-picker.hbs`;
const MAX_OPTIONS = 5000;
const MAX_TEXT = 300;

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class SearchPickerApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "infinity-dnd5e-search-picker",
    tag: "section",
    classes: ["infinity-dnd5e", "infinity-search-picker"],
    window: {
      title: "Choose an option",
      icon: "fa-solid fa-magnifying-glass",
      resizable: true,
    },
    position: { width: 560, height: 620 },
    actions: {
      toggleOption: SearchPickerApp._onToggleOption,
      confirm: SearchPickerApp._onConfirm,
      cancel: SearchPickerApp._onCancel,
    },
  };

  static PARTS = {
    body: { template: TEMPLATE_PATH },
  };

  constructor({
    title = "Choose an option",
    hint = "Search the available choices, then confirm your selection.",
    options = [],
    multiple = false,
    selectedIds = [],
    confirmLabel = "Choose",
  } = {}) {
    super({ window: { title } });
    this._title = cleanText(title, 100) || "Choose an option";
    this._hint = cleanText(hint, MAX_TEXT);
    this._options = normalizeSearchOptions(options);
    this._multiple = multiple === true;
    this._selectedIds = new Set(
      (Array.isArray(selectedIds) ? selectedIds : [selectedIds])
        .map(cleanId)
        .filter((id) => id && this._options.some((option) => option.id === id)),
    );
    this._confirmLabel = cleanText(confirmLabel, 60) || "Choose";
    this._query = "";
    this._settled = false;
    this._resolve = null;
    this.result = new Promise((resolve) => {
      this._resolve = resolve;
    });
  }

  async _prepareContext() {
    return {
      title: this._title,
      hint: this._hint,
      multiple: this._multiple,
      confirmLabel: this._confirmLabel,
      query: this._query,
      optionCount: this._options.length,
      hasOptions: this._options.length > 0,
      options: this._options.map((option) => ({
        ...option,
        selected: this._selectedIds.has(option.id),
      })),
      selectedCount: this._selectedIds.size,
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const root = this.element;
    const search = root?.querySelector?.("[data-search-picker-query]");
    if (search) search.value = this._query;
    search?.addEventListener?.("input", (event) => {
      this._filter(String(event.target?.value ?? ""));
    });
    this._filter(this._query);
    search?.focus?.();

    const list = root?.querySelector?.("[data-search-picker-list]");
    list?.addEventListener?.("keydown", (event) => this._onListKeyDown(event));
  }

  _filter(query) {
    this._query = String(query ?? "").slice(0, MAX_TEXT);
    const needle = normalizeSearchText(this._query);
    let visible = 0;
    for (const row of this.element?.querySelectorAll?.(
      "[data-search-option]",
    ) ?? []) {
      const matches =
        !needle || String(row.dataset.searchText ?? "").includes(needle);
      row.hidden = !matches;
      if (matches) visible += 1;
    }
    const status = this.element?.querySelector?.("[data-search-picker-status]");
    if (status) {
      status.textContent = `${visible} of ${this._options.length} option${this._options.length === 1 ? "" : "s"} shown`;
    }
  }

  _onListKeyDown(event) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const rows = [
      ...(this.element?.querySelectorAll?.(
        "[data-search-option]:not([hidden]):not([disabled])",
      ) ?? []),
    ];
    if (rows.length === 0) return;
    const current = rows.indexOf(
      event.target?.closest?.("[data-search-option]"),
    );
    let next = current;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = rows.length - 1;
    else if (event.key === "ArrowDown")
      next = current < 0 ? 0 : (current + 1) % rows.length;
    else next = current <= 0 ? rows.length - 1 : current - 1;
    event.preventDefault();
    rows[next]?.focus?.();
  }

  /** @this {SearchPickerApp} */
  static async _onToggleOption(_event, target) {
    const id = cleanId(target?.dataset?.optionId);
    const option = this._options.find((candidate) => candidate.id === id);
    if (!option || option.disabled) return;
    if (this._multiple) {
      if (this._selectedIds.has(id)) this._selectedIds.delete(id);
      else this._selectedIds.add(id);
    } else {
      this._selectedIds.clear();
      this._selectedIds.add(id);
    }
    await this.render(false);
    this.element
      ?.querySelector?.(`[data-option-id="${cssEscape(id)}"]`)
      ?.focus?.();
  }

  /** @this {SearchPickerApp} */
  static async _onConfirm() {
    if (this._selectedIds.size === 0) return;
    const value = this._multiple
      ? [...this._selectedIds]
      : ([...this._selectedIds][0] ?? null);
    this._settle(value);
    await this.close();
  }

  /** @this {SearchPickerApp} */
  static async _onCancel() {
    this._settle(null);
    await this.close();
  }

  _onClose(options) {
    super._onClose?.(options);
    this._settle(null);
  }

  _settle(value) {
    if (this._settled) return;
    this._settled = true;
    this._resolve?.(value);
    this._resolve = null;
  }
}

export async function pickSearchOption(options = {}) {
  const app = new SearchPickerApp(options);
  const { bindFocusRestoration } = await import("./infinity-app.js");
  bindFocusRestoration(app);
  app.render(true);
  return app.result;
}

export function normalizeSearchOptions(options) {
  if (!Array.isArray(options)) return [];
  const normalized = [];
  const seen = new Set();
  for (const raw of options) {
    if (!raw || typeof raw !== "object") continue;
    const id = cleanId(raw.id);
    const label = cleanText(raw.label, 160);
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    const description = cleanText(raw.description, MAX_TEXT);
    const keywords = cleanText(raw.keywords, MAX_TEXT);
    normalized.push({
      id,
      label,
      description,
      img: cleanText(raw.img, MAX_TEXT),
      disabled: raw.disabled === true,
      disabledReason: cleanText(raw.disabledReason, MAX_TEXT),
      searchText: normalizeSearchText(`${label} ${description} ${keywords}`),
    });
    if (normalized.length >= MAX_OPTIONS) break;
  }
  return normalized;
}

export function filterSearchOptions(options, query) {
  const needle = normalizeSearchText(query);
  const normalized = normalizeSearchOptions(options);
  return needle
    ? normalized.filter((option) => option.searchText.includes(needle))
    : normalized;
}

function normalizeSearchText(value) {
  return cleanText(value, MAX_TEXT * 2)
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanText(value, max) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);
}

function cleanId(value) {
  return cleanText(value, 240);
}

function cssEscape(value) {
  return (
    globalThis.CSS?.escape?.(String(value)) ??
    String(value).replace(/["\\]/g, "\\$&")
  );
}
