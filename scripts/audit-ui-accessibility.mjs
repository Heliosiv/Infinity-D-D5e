import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright";

import { buildHarnessViews, buildUiHarnessDocument } from "./ui-harness.mjs";

const REQUIRED_AXE_RULES = new Set([
  "aria-input-field-name",
  "aria-required-children",
  "aria-required-parent",
  "aria-valid-attr-value",
  "button-name",
  "color-contrast",
  "duplicate-id",
  "duplicate-id-aria",
  "input-button-name",
  "label",
  "link-name",
  "select-name",
]);

async function main() {
  const outDir = path.resolve("tmp", "playwright");
  const outFile = path.join(outDir, "ui-harness-accessibility.html");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outFile, buildUiHarnessDocument(), "utf8");

  const browser = await chromium.launch({ headless: true });
  const issues = [];
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      screen: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    const fileUrl = pathToFileURL(outFile).href;

    for (const fixture of buildHarnessViews()) {
      await page.goto(fileUrl, { waitUntil: "load" });
      await isolateFixture(page, fixture.id);

      const contractIssues = await page.evaluate(auditSemanticContract);
      for (const issue of contractIssues) {
        issues.push(`${fixture.id}: ${issue}`);
      }

      const results = await new AxeBuilder({ page })
        .include(`[data-harness-window="${cssAttribute(fixture.id)}"]`)
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      for (const violation of results.violations) {
        if (
          !["serious", "critical"].includes(violation.impact) &&
          !REQUIRED_AXE_RULES.has(violation.id)
        ) {
          continue;
        }
        for (const node of violation.nodes) {
          issues.push(
            `${fixture.id}: axe ${violation.id} (${violation.impact ?? "unknown"}) at ${node.target.join(" ")} — ${node.failureSummary ?? violation.help}`,
          );
        }
      }
    }
    await context.close();
  } finally {
    await browser.close();
  }

  if (issues.length > 0) {
    for (const issue of issues) process.stdout.write(`  - ${issue}\n`);
    throw new Error(`${issues.length} accessibility issue(s) found`);
  }
  process.stdout.write(
    `${buildHarnessViews().length} isolated UI fixtures passed the accessibility audit\n`,
  );
}

async function isolateFixture(page, fixtureId) {
  await page.evaluate((id) => {
    for (const section of document.querySelectorAll("[data-harness-section]")) {
      if (section.dataset.harnessSection !== id) section.remove();
    }
    const root = document.querySelector("[data-harness-window]");
    root?.setAttribute("data-infinity-density", "comfortable");
    root?.classList.add("infinity-density--comfortable");
    for (const disclosure of root?.querySelectorAll?.("details") ?? []) {
      disclosure.open = true;
    }
  }, fixtureId);
}

async function auditSemanticContract() {
  const issues = [];
  const root = document.querySelector("[data-harness-window]");
  if (!root) return ["fixture root is missing"];

  const ids = new Map();
  for (const element of root.querySelectorAll("[id]")) {
    const id = String(element.id ?? "").trim();
    if (!id) continue;
    ids.set(id, (ids.get(id) ?? 0) + 1);
  }
  for (const [id, count] of ids) {
    if (count > 1) issues.push(`duplicate id #${id} appears ${count} times`);
  }

  for (const control of root.querySelectorAll(
    "button, a[href], input, select, textarea, [role='button'], [role='tab']",
  )) {
    if (control.matches("input[type='hidden']")) continue;
    const name = accessibleName(control);
    if (!name) issues.push(`unnamed control ${describe(control)}`);
  }

  for (const input of root.querySelectorAll(
    "input:not([type='hidden'], [type='button'], [type='submit']), select, textarea",
  )) {
    const id = input.id;
    const labelled =
      input.closest("label") ||
      (id && root.querySelector(`label[for="${cssEscape(id)}"]`)) ||
      input.getAttribute("aria-label") ||
      input.getAttribute("aria-labelledby") ||
      input.getAttribute("title");
    if (!labelled)
      issues.push(`control has no label relationship: ${describe(input)}`);
  }

  for (const tablist of root.querySelectorAll("[role='tablist']")) {
    const tabs = [...tablist.querySelectorAll("[role='tab']")];
    if (tabs.length === 0) issues.push("tablist has no tabs");
    if (
      tabs.filter((tab) => tab.getAttribute("aria-selected") === "true")
        .length !== 1
    ) {
      issues.push("tablist must have exactly one selected tab");
    }
    for (const tab of tabs) {
      const panelId = tab.getAttribute("aria-controls");
      const panel = panelId
        ? root.querySelector(`#${cssEscape(panelId)}`)
        : null;
      if (!panel || panel.getAttribute("role") !== "tabpanel") {
        issues.push(`${describe(tab)} does not control a valid tabpanel`);
      } else if (panel.getAttribute("aria-labelledby") !== tab.id) {
        issues.push(
          `${describe(tab)} and its tabpanel are not mutually labelled`,
        );
      }
    }
  }

  for (const live of root.querySelectorAll(
    "[aria-live], [role='status'], [role='alert']",
  )) {
    if (live.getAttribute("aria-live") === "off") {
      issues.push(`live status is disabled: ${describe(live)}`);
    }
  }

  return issues;

  function accessibleName(element) {
    const labelledBy = String(element.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => root.querySelector(`#${cssEscape(id)}`)?.textContent ?? "")
      .join(" ");
    return String(
      element.getAttribute("aria-label") ||
        labelledBy ||
        element.getAttribute("title") ||
        element.textContent ||
        element.value ||
        "",
    ).trim();
  }

  function describe(element) {
    return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${element.getAttribute("name") ? `[name=${element.getAttribute("name")}]` : ""}`;
  }

  function cssEscape(value) {
    return (
      globalThis.CSS?.escape?.(String(value)) ??
      String(value).replace(/["\\]/g, "\\$&")
    );
  }
}

function cssAttribute(value) {
  return String(value ?? "").replace(/["\\]/g, "\\$&");
}

await main();
