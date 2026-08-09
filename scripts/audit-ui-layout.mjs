import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

import { buildUiHarnessDocument } from "./ui-harness.mjs";

const VIEWPORTS = [
  { name: "desktop", width: 1360, height: 920 },
  { name: "tablet", width: 900, height: 900 },
  { name: "narrow", width: 520, height: 900 },
  { name: "phone", width: 380, height: 900 },
];

async function main() {
  const outDir = path.resolve("tmp", "playwright");
  const outFile = path.join(outDir, "ui-harness.html");

  mkdirSync(outDir, { recursive: true });
  writeFileSync(outFile, buildUiHarnessDocument(), "utf8");

  const browser = await chromium.launch({ headless: true });

  try {
    const fileUrl = pathToFileURL(outFile).href;
    const summary = [];
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: {
          width: viewport.width,
          height: viewport.height,
        },
        screen: {
          width: viewport.width,
          height: viewport.height,
        },
      });
      const page = await context.newPage();
      await page.goto(
        `${fileUrl}?viewport=${encodeURIComponent(viewport.name)}`,
        {
          waitUntil: "load",
        },
      );

      const screenshotFile = path.join(
        outDir,
        `ui-harness-${viewport.name}.png`,
      );
      await page.screenshot({
        path: screenshotFile,
        fullPage: true,
      });

      const result = await page.evaluate(auditPage);
      summary.push({ viewport, screenshotFile, ...result });
      await context.close();
    }

    const issueCount = summary.reduce(
      (total, result) => total + result.issues.length,
      0,
    );
    for (const result of summary) {
      process.stdout.write(
        `${result.viewport.name}: ${result.buttonCount} action button(s), ${result.clickedCount} click(s), ${result.dblclickCount}/${result.openableRowCount} row dbl-click(s), screenshot ${result.screenshotFile}\n`,
      );
      for (const issue of result.issues) {
        process.stdout.write(`  - ${issue}\n`);
      }
    }
    if (issueCount > 0) {
      throw new Error(`${issueCount} UI layout/click audit issue(s) found`);
    }
    process.stdout.write("ui layout audit passed\n");
  } finally {
    await browser.close();
  }
}

async function auditPage() {
  const issues = [];
  // Disabled buttons are intentionally inert (e.g. a pending shop row, a
  // gated Open Session) — don't count them as "should be clickable".
  const buttons = [
    ...document.querySelectorAll(
      "[data-harness-window] button[data-action]:not([disabled])",
    ),
  ];
  const windows = [...document.querySelectorAll("[data-harness-window]")];

  // Overflow check runs with all popover menus collapsed (their default).
  for (const root of windows) {
    const content = root.querySelector(".window-content");
    const shell = root.querySelector(
      ".lf-shell, .hl-shell, .pc-shell, .id-shell, .mw-shell, .ms-shell, .rm-shell, .fp-shell, .sp-shell, .rw-shell, .rv-shell, .ci-shell, .ci-hud-shell, .dt-shell",
    );
    const isOverlay = root.matches(".infinity-critical-injury-hud");
    for (const element of [content, shell].filter(Boolean)) {
      // The HUD's pinned card deliberately escapes its 124px silhouette root.
      // Its controls and nested contents are still audited below.
      if (isOverlay) continue;
      if (element.scrollWidth > element.clientWidth + 2) {
        issues.push(
          `${root.dataset.harnessWindow}: horizontal overflow in ${describe(element)} (${element.scrollWidth}px > ${element.clientWidth}px)`,
        );
      }
    }
    for (const element of shell?.querySelectorAll("*") ?? []) {
      if (element.dataset.allowHorizontalScroll === "true") continue;
      if (
        element.matches(
          "input, select, textarea, .lf-sr-only, .rm-sr, [aria-hidden='true']",
        )
      ) {
        continue;
      }
      const style = getComputedStyle(element);
      if (!["block", "flex", "grid", "table"].includes(style.display)) continue;
      if (element.clientWidth <= 0) continue;
      if (["auto", "scroll", "hidden", "clip"].includes(style.overflowX)) {
        continue;
      }
      const rect = element.getBoundingClientRect();
      const hasVisibleChildOverflow = [...element.children].some((child) => {
        const childStyle = getComputedStyle(child);
        if (
          childStyle.display === "none" ||
          ["absolute", "fixed"].includes(childStyle.position)
        ) {
          return false;
        }
        const childRect = child.getBoundingClientRect();
        if (childRect.width <= 0 || childRect.height <= 0) return false;
        return (
          childRect.left < rect.left - 2 || childRect.right > rect.right + 2
        );
      });
      const hasVisibleTextOverflow =
        element.children.length === 0 &&
        element.scrollWidth > element.clientWidth + 2;
      if (hasVisibleChildOverflow || hasVisibleTextOverflow) {
        issues.push(
          `${root.dataset.harnessWindow}: nested horizontal overflow in ${describe(element)} (${element.scrollWidth}px > ${element.clientWidth}px)`,
        );
      }
    }
  }

  if (document.documentElement.clientWidth <= 460) {
    for (const summary of document.querySelectorAll(
      '[data-harness-window="resource-manager-recent-runs"] .rm-run > summary',
    )) {
      const height = summary.getBoundingClientRect().height;
      if (height > 300) {
        issues.push(
          `resource-manager-recent-runs: phone receipt summary is too tall (${Math.round(height)}px)`,
        );
      }
    }
  }

  async function auditButton(button, { skipCover = false } = {}) {
    button.scrollIntoView({ block: "center", inline: "nearest" });
    await nextFrame();
    await nextFrame();

    const rect = button.getBoundingClientRect();
    const label =
      button.textContent.trim().replace(/\s+/g, " ") ||
      button.getAttribute("aria-label") ||
      button.getAttribute("title") ||
      button.dataset.action;
    const windowName =
      button.closest("[data-harness-window]")?.dataset.harnessWindow ??
      "unknown";
    if (rect.width < 24 || rect.height < 24) {
      issues.push(
        `${windowName}: "${label}" action target is too small (${rect.width}x${rect.height})`,
      );
      return;
    }
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    if (
      rect.right < 0 ||
      rect.bottom < 0 ||
      rect.left > viewportWidth ||
      rect.top > viewportHeight
    ) {
      issues.push(
        `${windowName}: "${label}" action target is outside the viewport ` +
          `(${Math.round(rect.left)},${Math.round(rect.top)} to ` +
          `${Math.round(rect.right)},${Math.round(rect.bottom)} within ` +
          `${viewportWidth}x${viewportHeight})`,
      );
      return;
    }

    const centerX = Math.max(
      0,
      Math.min(viewportWidth - 1, rect.left + rect.width / 2),
    );
    const centerY = Math.max(
      0,
      Math.min(viewportHeight - 1, rect.top + rect.height / 2),
    );
    // Popover-menu buttons float over content and can be clipped by the
    // harness window's overflow:hidden (a harness artifact, not a real
    // Foundry layout), so the cover check is skipped for them.
    if (!skipCover) {
      const top = document.elementFromPoint(centerX, centerY);
      const topButton = top?.closest?.("button");
      if (topButton !== button) {
        issues.push(
          `${windowName}: "${label}" action center is covered by ${top ? describe(top) : "nothing"}`,
        );
        return;
      }
    }
    button.click();
  }

  // Popover menu buttons live inside a collapsed <details>; audit each
  // menu in isolation (open it, click its buttons, close it) so the
  // panel never covers the rest of the window's controls.
  for (const menu of document.querySelectorAll(
    "[data-harness-window] details.lf-menu",
  )) {
    menu.open = true;
    await nextFrame();
    await nextFrame();
    for (const button of menu.querySelectorAll("button[data-action]")) {
      await auditButton(button, { skipCover: true });
    }
    menu.open = false;
  }

  // Quartermaster setup is intentionally collapsed in the routine-first
  // fixture. Open each disclosure before auditing the controls it contains,
  // then restore the fixture's original state.
  for (const setup of document.querySelectorAll(
    "[data-harness-window] details.rm-setup",
  )) {
    const wasOpen = setup.open;
    setup.open = true;
    await nextFrame();
    await nextFrame();
    for (const button of setup.querySelectorAll(
      "button[data-action]:not([disabled])",
    )) {
      await auditButton(button);
    }
    setup.open = wasOpen;
  }

  // Everything else, with transient disclosures restored.
  for (const button of buttons) {
    if (button.closest("details.lf-menu, details.rm-setup")) continue;
    await auditButton(button);
  }

  const clickedCount = window.__uiClicks?.length ?? 0;
  if (clickedCount !== buttons.length) {
    issues.push(`clicked ${clickedCount} of ${buttons.length} action buttons`);
  }

  // Double-click-to-open coverage: every item row carries data-uuid and
  // must open its sheet on double-click. Dispatch on the row itself (not
  // an interactive child) and confirm the production-mirroring tracker saw
  // each one.
  const openableRows = [
    ...document.querySelectorAll(
      "[data-harness-window] li[data-uuid], [data-harness-window] .mw-inv__row[data-uuid], [data-harness-window] .ms-row[data-uuid]",
    ),
  ];
  for (const row of openableRows) {
    row.scrollIntoView({ block: "center", inline: "nearest" });
    await nextFrame();
    row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  }
  const dblclickCount = window.__uiDblclicks?.length ?? 0;
  if (dblclickCount !== openableRows.length) {
    issues.push(
      `double-click opened ${dblclickCount} of ${openableRows.length} item rows`,
    );
  }

  return {
    issues,
    buttonCount: buttons.length,
    clickedCount,
    dblclickCount,
    openableRowCount: openableRows.length,
    windows: windows.map((root) => root.dataset.harnessWindow),
  };

  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(resolve));
  }

  function describe(element) {
    const tag = element.tagName.toLowerCase();
    const id = element.id ? `#${element.id}` : "";
    const classes = [...element.classList]
      .slice(0, 3)
      .map((name) => `.${name}`)
      .join("");
    return `${tag}${id}${classes}`;
  }
}

await main();
