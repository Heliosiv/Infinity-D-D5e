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
assert.deepEqual(
  filterSearchOptions(raw, "BOW arcane rare").map((option) => option.id),
  ["a"],
  "all words match across name, description and keywords in any order",
);
assert.equal(filterSearchOptions(raw, "arcane gear").length, 0);
assert.equal(filterSearchOptions(raw, "   ").length, 2);

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
  for (const [key, expected] of [
    ["ArrowDown", "a"],
    ["ArrowUp", "c"],
  ]) {
    calls.length = 0;
    picker._onListKeyDown({
      key,
      target: { closest: () => null },
      preventDefault: () => calls.push("preventDefault"),
    });
    assert.deepEqual(calls, ["preventDefault", `focus:${expected}`]);
  }
}

{
  function createPickerRoot() {
    const input = {
      value: "",
      addEventListener() {},
      focus() {},
    };
    const status = { textContent: "" };
    const empty = { hidden: true };
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
        if (selector === "[data-search-picker-empty]") return empty;
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
    return { root, input, status, rows, empty };
  }

  const picker = Object.create(SearchPickerApp.prototype);
  picker._options = normalized;
  picker._multiple = true;
  picker._selectedIds = new Set();
  picker._query = "";
  let rendered = createPickerRoot();
  picker.element = rendered.root;
  picker._filter("bow arcane");
  assert.equal(rendered.rows[0].hidden, false);
  assert.equal(rendered.rows[1].hidden, true);
  assert.equal(rendered.empty.hidden, true);
  picker._filter("unmatched");
  assert.equal(rendered.empty.hidden, false);
  assert.match(rendered.status.textContent, /^0 of 2 options shown$/);
  picker._filter("");
  assert.equal(rendered.empty.hidden, true);
  assert.ok(rendered.rows.every((row) => !row.hidden));
  picker._filter("arcane");
  assert.equal(rendered.rows[1].hidden, true);

  picker.render = async () => {
    assert.fail("toggling a choice must not rebuild the list");
  };
  picker._onRender({}, {});
  await SearchPickerApp.DEFAULT_OPTIONS.actions.toggleOption.call(
    picker,
    null,
    { dataset: { optionId: "a" } },
  );

  assert.equal(picker._query, "arcane", "selection preserves the active query");
  assert.equal(rendered.input.value, "arcane");
  assert.equal(
    rendered.rows[1].hidden,
    true,
    "selection keeps the existing filter",
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
