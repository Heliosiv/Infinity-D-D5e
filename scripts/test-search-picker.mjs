import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.foundry = {
  applications: {
    api: {
      ApplicationV2: class {},
      HandlebarsApplicationMixin: (Base) => class extends Base {},
    },
  },
};

const { SearchPickerApp, filterSearchOptions, normalizeSearchOptions } =
  await import("./search-picker.js");

const raw = [
  {
    id: "a",
    label: "Árcane Arrow",
    description: "Rare ammunition",
    keywords: "bow",
  },
  { id: "b", label: "Bedroll", description: "Adventuring gear" },
  { id: "a", label: "Duplicate" },
  { id: "", label: "Missing id" },
];

const normalized = normalizeSearchOptions(raw);
assert.equal(normalized.length, 2, "invalid and duplicate options are removed");
assert.equal(
  filterSearchOptions(raw, "arcane")[0]?.id,
  "a",
  "search ignores accents and casing",
);
assert.equal(
  filterSearchOptions(raw, "BOW")[0]?.id,
  "a",
  "keywords are searchable",
);
assert.deepEqual(
  filterSearchOptions(raw, "missing"),
  [],
  "unmatched search is empty",
);

{
  const calls = [];
  const options = ["a", "b", "c"].map((id) => ({
    closest: (selector) => {
      assert.equal(selector, "[data-search-option]");
      return options.find((option) => option.id === id);
    },
    focus: () => calls.push(`focus:${id}`),
    id,
  }));
  const picker = Object.create(SearchPickerApp.prototype);
  picker.element = {
    querySelectorAll: (selector) => {
      assert.equal(
        selector,
        "[data-search-option]:not([hidden]):not([disabled])",
      );
      return options;
    },
  };
  picker._onListKeyDown({
    key: "ArrowDown",
    target: options[0],
    preventDefault: () => calls.push("preventDefault"),
  });
  assert.deepEqual(
    calls,
    ["preventDefault", "focus:b"],
    "arrow navigation follows the option controls after removing nested buttons",
  );
}

{
  function createPickerRoot() {
    const input = {
      value: "",
      addEventListener() {},
      focus() {},
    };
    const status = { textContent: "" };
    const list = { addEventListener() {} };
    const rows = normalized.map((option) => ({
      dataset: { optionId: option.id, searchText: option.searchText },
      hidden: false,
      focus() {},
    }));
    const root = {
      querySelector(selector) {
        if (selector === "[data-search-picker-query]") return input;
        if (selector === "[data-search-picker-status]") return status;
        if (selector === "[data-search-picker-list]") return list;
        const id = selector.match(/^\[data-option-id="(.+)"\]$/)?.[1];
        return id
          ? (rows.find((row) => row.dataset.optionId === id) ?? null)
          : null;
      },
      querySelectorAll(selector) {
        assert.equal(selector, "[data-search-option]");
        return rows;
      },
    };
    return { root, input, status, rows };
  }

  const picker = Object.create(SearchPickerApp.prototype);
  picker._options = normalized;
  picker._multiple = true;
  picker._selectedIds = new Set();
  picker._query = "";
  let rendered = createPickerRoot();
  picker.element = rendered.root;
  picker._filter("arcane");
  assert.equal(rendered.rows[1].hidden, true);

  picker.render = async () => {
    rendered = createPickerRoot();
    picker.element = rendered.root;
    picker._onRender({}, {});
    return picker;
  };
  await SearchPickerApp.DEFAULT_OPTIONS.actions.toggleOption.call(
    picker,
    null,
    { dataset: { optionId: "a" } },
  );

  assert.equal(
    picker._query,
    "arcane",
    "selection rerenders preserve the active query",
  );
  assert.equal(rendered.input.value, "arcane");
  assert.equal(
    rendered.rows[1].hidden,
    true,
    "the preserved query is reapplied to the freshly rendered options",
  );
  assert.match(rendered.status.textContent, /^1 of 2 options shown$/);
}

const templateSource = readFileSync("templates/search-picker.hbs", "utf8");
assert.match(templateSource, /role="listbox"[^>]*aria-label=/);
assert.match(templateSource, /<button[\s\S]*?role="option"/);
assert.doesNotMatch(
  templateSource,
  /<div[^>]*role="option"[^>]*>[\s\S]*?<button/,
  "listbox options are the controls instead of containing nested controls",
);

process.stdout.write("search picker validation passed\n");
