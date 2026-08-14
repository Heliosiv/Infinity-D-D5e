import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

import { buildHarnessViews, buildUiHarnessDocument } from "./ui-harness.mjs";

const SCENARIOS = [
  {
    name: "comfortable-1040",
    appWidth: 1040,
    height: 920,
    density: "comfortable",
    targetSize: 44,
  },
  {
    name: "comfortable-720",
    appWidth: 720,
    height: 900,
    density: "comfortable",
    targetSize: 44,
  },
  {
    name: "comfortable-520",
    appWidth: 520,
    height: 900,
    density: "comfortable",
    targetSize: 44,
  },
  {
    name: "comfortable-380",
    appWidth: 380,
    height: 900,
    density: "comfortable",
    targetSize: 44,
  },
  {
    name: "compact-720",
    appWidth: 720,
    height: 900,
    density: "compact",
    targetSize: 32,
  },
  {
    name: "compact-380",
    appWidth: 380,
    height: 900,
    density: "compact",
    targetSize: 32,
  },
  {
    name: "coarse-380",
    appWidth: 380,
    height: 900,
    density: "compact",
    targetSize: 44,
    coarse: true,
  },
  {
    name: "short-720",
    appWidth: 720,
    height: 500,
    density: "comfortable",
    targetSize: 44,
  },
  {
    name: "zoom-200",
    appWidth: 520,
    height: 900,
    density: "comfortable",
    targetSize: 44,
    zoom: 2,
  },
  {
    name: "reduced-motion",
    appWidth: 720,
    height: 900,
    density: "comfortable",
    targetSize: 44,
    reducedMotion: "reduce",
  },
  {
    name: "forced-colors",
    appWidth: 720,
    height: 900,
    density: "comfortable",
    targetSize: 44,
    forcedColors: "active",
  },
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
    const requestedScenarios = splitSelection(
      process.env.INFINITY_UI_AUDIT_SCENARIO,
    );
    const scenarios =
      requestedScenarios.length > 0
        ? SCENARIOS.filter((scenario) =>
            requestedScenarios.includes(scenario.name),
          )
        : SCENARIOS;
    if (scenarios.length === 0) {
      throw new Error(
        `Unknown UI audit scenario: ${requestedScenarios.join(", ")}`,
      );
    }
    const requestedFixtures = splitSelection(
      process.env.INFINITY_UI_AUDIT_FIXTURE,
    );
    const fixtures =
      requestedFixtures.length > 0
        ? buildHarnessViews().filter((fixture) =>
            requestedFixtures.includes(fixture.id),
          )
        : buildHarnessViews();
    if (fixtures.length === 0) {
      throw new Error(
        `Unknown UI audit fixture: ${requestedFixtures.join(", ")}`,
      );
    }
    for (const scenario of scenarios) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: scenario.height },
        screen: { width: 1440, height: scenario.height },
        hasTouch: scenario.coarse === true,
        isMobile: scenario.coarse === true,
      });
      const page = await context.newPage();
      await page.emulateMedia({
        reducedMotion: scenario.reducedMotion ?? "no-preference",
        forcedColors: scenario.forcedColors ?? "none",
      });
      await page.goto(
        `${fileUrl}?scenario=${encodeURIComponent(scenario.name)}`,
        {
          waitUntil: "load",
        },
      );
      await page.evaluate((options) => {
        document.body.style.zoom = String(options.zoom ?? 1);
        for (const root of document.querySelectorAll("[data-harness-window]")) {
          root.style.setProperty("--harness-width", `${options.appWidth}px`);
          root.dataset.infinityDensity = options.density;
          root.classList.toggle(
            "infinity-density--comfortable",
            options.density === "comfortable",
          );
          root.classList.toggle(
            "infinity-density--compact",
            options.density === "compact",
          );
        }
        for (const stage of document.querySelectorAll(
          ".ui-harness__overlay-stage",
        )) {
          stage.style.setProperty("--harness-width", `${options.appWidth}px`);
        }
      }, scenario);

      const aggregate = {
        issues: [],
        buttonCount: 0,
        clickedCount: 0,
        dblclickCount: 0,
        openableRowCount: 0,
        windows: [],
      };
      for (const fixture of fixtures) {
        await page.evaluate((fixtureId) => {
          for (const section of document.querySelectorAll(
            "[data-harness-section]",
          )) {
            section.hidden = section.dataset.harnessSection !== fixtureId;
          }
          window.__uiClicks = [];
          window.__uiDblclicks = [];
          document.scrollingElement?.scrollTo?.(0, 0);
        }, fixture.id);
        const result = await page.evaluate(auditPage, scenario);
        aggregate.issues.push(...result.issues);
        aggregate.buttonCount += result.buttonCount;
        aggregate.clickedCount += result.clickedCount;
        aggregate.dblclickCount += result.dblclickCount;
        aggregate.openableRowCount += result.openableRowCount;
        aggregate.windows.push(...result.windows);
      }

      const screenshotFile = path.join(
        outDir,
        `ui-harness-${scenario.name}.png`,
      );
      await page.evaluate(() => {
        for (const section of document.querySelectorAll(
          "[data-harness-section]",
        )) {
          section.hidden = false;
        }
      });
      await page.screenshot({ path: screenshotFile, fullPage: true });

      summary.push({ scenario, screenshotFile, ...aggregate });
      await context.close();
    }

    const issueCount = summary.reduce(
      (total, result) => total + result.issues.length,
      0,
    );
    for (const result of summary) {
      process.stdout.write(
        `${result.scenario.name}: ${result.buttonCount} action button(s), ${result.clickedCount} click(s), ${result.dblclickCount}/${result.openableRowCount} row dbl-click(s), screenshot ${result.screenshotFile}\n`,
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

function splitSelection(value) {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function auditPage(scenario) {
  const issues = [];
  const actionSelector = "button[data-action]:not([disabled])";
  const auditedButtons = new Set();
  let successfulClicks = 0;
  // Disabled buttons are intentionally inert (e.g. a pending shop row, a
  // gated Open Session) — don't count them as "should be clickable".
  const buttons = [
    ...document.querySelectorAll(
      `[data-harness-section]:not([hidden]) [data-harness-window] ${actionSelector}`,
    ),
  ].filter(
    (button) => !button.closest("details") && isRenderedForAudit(button),
  );
  const windows = [
    ...document.querySelectorAll(
      "[data-harness-section]:not([hidden]) [data-harness-window]",
    ),
  ].filter((root) => root.getClientRects().length > 0);

  // Overflow check runs with all popover menus collapsed (their default).
  for (const root of windows) {
    const content = root.querySelector(".window-content");
    const shell = root.querySelector(
      ".infinity-app-shell, .lf-shell, .hl-shell, .pc-shell, .id-shell, .mw-shell, .ms-shell, .rm-shell, .fp-shell, .sp-shell, .rw-shell, .rv-shell, .ci-shell, .ci-triage-shell, .ci-hud-shell, .dt-shell",
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
      if (!isRenderedForAudit(element)) continue;
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

    const terminal = findTerminalContent(shell);
    if (terminal) {
      bringIntoAuditView(terminal, { block: 0.9 });
      const reachability = findVerticalReachability(terminal, root);
      if (!reachability.reachable) {
        issues.push(
          `${root.dataset.harnessWindow}: bottom content cannot be reached because ${describe(reachability.clippingElement)} clips it without a working vertical scroll path`,
        );
      }
    }
  }

  if (scenario.appWidth <= 460) {
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
    if (auditedButtons.has(button) || !isRenderedForAudit(button)) return false;
    auditedButtons.add(button);
    bringIntoAuditView(button);
    await nextFrame();
    await nextFrame();

    let rect = button.getBoundingClientRect();
    const label =
      button.textContent.trim().replace(/\s+/g, " ") ||
      button.getAttribute("aria-label") ||
      button.getAttribute("title") ||
      button.dataset.action;
    const windowName =
      button.closest("[data-harness-window]")?.dataset.harnessWindow ??
      "unknown";
    const minimum = Number(scenario.targetSize) || 44;
    if (rect.width + 0.5 < minimum || rect.height + 0.5 < minimum) {
      issues.push(
        `${windowName}: "${label}" action target is too small for ${scenario.name} (${Math.round(rect.width)}x${Math.round(rect.height)}; expected ${minimum}px)`,
      );
      return false;
    }
    let reachable = findReachablePoint(button, { skipCover });
    if (!reachable.point) {
      for (const block of [0.25, 0.75, 0.1, 0.9]) {
        bringIntoAuditView(button, { block });
        await nextFrame();
        reachable = findReachablePoint(button, { skipCover });
        if (reachable.point) break;
      }
      rect = button.getBoundingClientRect();
    }
    if (!reachable.point && reachable.outsideViewport) {
      issues.push(
        `${windowName}: "${label}" action target is outside the viewport ` +
          `(${Math.round(rect.left)},${Math.round(rect.top)} to ` +
          `${Math.round(rect.right)},${Math.round(rect.bottom)} within ` +
          `${reachable.viewportWidth}x${reachable.viewportHeight})`,
      );
      return false;
    }
    if (!reachable.point) {
      issues.push(
        `${windowName}: "${label}" action target is covered by ${
          reachable.coveringElement
            ? describe(reachable.coveringElement)
            : "nothing"
        }`,
      );
      return false;
    }

    const clicksBefore = window.__uiClicks?.length ?? 0;
    button.click();
    const clicksAfter = window.__uiClicks?.length ?? 0;
    if (clicksAfter !== clicksBefore + 1) {
      issues.push(
        `${windowName}: "${label}" did not dispatch its action click`,
      );
      return false;
    }
    successfulClicks += 1;
    return true;
  }

  // Descendants of a closed <details> can retain layout rectangles despite
  // being clipped from paint and hit testing. Audit each disclosure in its
  // intended open state, in isolation, and keep those controls out of the
  // base-state denominator.
  for (const disclosure of document.querySelectorAll(
    "[data-harness-section]:not([hidden]) [data-harness-window] details",
  )) {
    const disclosureChain = [];
    for (let current = disclosure; current; current = current.parentElement) {
      if (!current.matches?.("details")) continue;
      disclosureChain.push({ element: current, open: current.open });
      current.open = true;
    }
    await nextFrame();
    await nextFrame();
    for (const button of disclosure.querySelectorAll(actionSelector)) {
      if (button.closest("details") !== disclosure) continue;
      await auditButton(button, {
        // Loot popovers escape normal flow. Foundry allows that paint while
        // the static harness frame deliberately clips it.
        skipCover: disclosure.matches(".lf-menu"),
      });
    }
    for (const state of disclosureChain) {
      state.element.open = state.open;
    }
  }

  // Everything else, with transient disclosures restored.
  for (const button of buttons) {
    await auditButton(button);
  }

  const clickedCount = window.__uiClicks?.length ?? 0;
  if (clickedCount !== successfulClicks) {
    issues.push(
      `click tracker recorded ${clickedCount} of ${successfulClicks} successful action clicks`,
    );
  }

  // Double-click-to-open coverage: every item row carries data-uuid and
  // must open its sheet on double-click. Dispatch on the row itself (not
  // an interactive child) and confirm the production-mirroring tracker saw
  // each one.
  const openableRows = [
    ...document.querySelectorAll(
      "[data-harness-section]:not([hidden]) [data-harness-window] li[data-uuid], [data-harness-section]:not([hidden]) [data-harness-window] .mw-inv__row[data-uuid], [data-harness-section]:not([hidden]) [data-harness-window] .ms-row[data-uuid]",
    ),
  ].filter((row) => isRenderedForAudit(row));
  for (const row of openableRows) {
    bringIntoAuditView(row);
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
    buttonCount: auditedButtons.size,
    clickedCount,
    dblclickCount,
    openableRowCount: openableRows.length,
    windows: windows.map((root) => root.dataset.harnessWindow),
  };

  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(resolve));
  }

  function bringIntoAuditView(element, { block = 0.5, inline = 0.5 } = {}) {
    for (
      let ancestor = element.parentElement;
      ancestor && ancestor !== document.body;
      ancestor = ancestor.parentElement
    ) {
      const style = getComputedStyle(ancestor);
      const canScrollY =
        ["auto", "scroll"].includes(style.overflowY) &&
        ancestor.scrollHeight > ancestor.clientHeight;
      const canScrollX =
        ["auto", "scroll"].includes(style.overflowX) &&
        ancestor.scrollWidth > ancestor.clientWidth;
      if (!canScrollY && !canScrollX) continue;
      const targetRect = element.getBoundingClientRect();
      const ancestorRect = ancestor.getBoundingClientRect();
      const scaleX = Math.max(
        0.01,
        ancestorRect.width / Math.max(1, ancestor.offsetWidth),
      );
      const scaleY = Math.max(
        0.01,
        ancestorRect.height / Math.max(1, ancestor.offsetHeight),
      );
      if (canScrollY) {
        ancestor.scrollTop +=
          (targetRect.top +
            targetRect.height / 2 -
            (ancestorRect.top + ancestorRect.height * block)) /
          scaleY;
      }
      if (canScrollX) {
        ancestor.scrollLeft +=
          (targetRect.left +
            targetRect.width / 2 -
            (ancestorRect.left + ancestorRect.width * inline)) /
          scaleX;
      }
    }
    const rect = element.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > document.documentElement.clientHeight) {
      const bodyRect = document.body.getBoundingClientRect();
      const bodyScale = Math.max(
        0.01,
        bodyRect.width / Math.max(1, document.body.offsetWidth),
      );
      window.scrollBy({
        top:
          (rect.top +
            rect.height / 2 -
            document.documentElement.clientHeight * block) /
          bodyScale,
        behavior: "instant",
      });
    }

    // Let the browser make the final visibility adjustment. Chromium's Linux
    // scrollbar and font metrics can clamp the arithmetic above a few pixels
    // outside a nested scrollport at narrow widths. `nearest` only moves a
    // clipped target; the hit-test below still rejects genuinely covered UI.
    element.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: "instant",
    });
  }

  function isRenderedForAudit(element) {
    if (!(element instanceof Element) || element.closest("[hidden]")) {
      return false;
    }
    for (let current = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse"
      ) {
        return false;
      }
      if (current.matches("details:not([open])")) {
        const summary = current.querySelector(":scope > summary");
        if (!summary?.contains(element)) return false;
      }
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findTerminalContent(shell) {
    if (!shell) return null;
    const candidates = [...shell.querySelectorAll("*")].filter((element) => {
      if (!isRenderedForAudit(element) || element.children.length > 0) {
        return false;
      }
      if (element.matches("option, script, style, .lf-sr-only")) return false;
      const style = getComputedStyle(element);
      return !["absolute", "fixed"].includes(style.position);
    });
    return candidates.reduce((terminal, element) => {
      if (!terminal) return element;
      return element.getBoundingClientRect().bottom >
        terminal.getBoundingClientRect().bottom
        ? element
        : terminal;
    }, null);
  }

  function findVerticalReachability(element, root) {
    const rect = element.getBoundingClientRect();
    let top = Math.max(0, rect.top);
    let bottom = Math.min(document.documentElement.clientHeight, rect.bottom);
    let clippingElement = root;
    for (
      let ancestor = element.parentElement;
      ancestor;
      ancestor = ancestor.parentElement
    ) {
      const style = getComputedStyle(ancestor);
      if (["auto", "scroll", "hidden", "clip"].includes(style.overflowY)) {
        const ancestorRect = ancestor.getBoundingClientRect();
        top = Math.max(top, ancestorRect.top);
        bottom = Math.min(bottom, ancestorRect.bottom);
        if (bottom <= top) clippingElement = ancestor;
      }
      if (ancestor === root) break;
    }
    return { reachable: bottom > top, clippingElement };
  }

  function findReachablePoint(button, { skipCover }) {
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const rect = button.getBoundingClientRect();
    const visible = {
      left: Math.max(0, rect.left),
      right: Math.min(viewportWidth, rect.right),
      top: Math.max(0, rect.top),
      bottom: Math.min(viewportHeight, rect.bottom),
    };

    if (!skipCover) {
      for (
        let ancestor = button.parentElement;
        ancestor;
        ancestor = ancestor.parentElement
      ) {
        const style = getComputedStyle(ancestor);
        const ancestorRect = ancestor.getBoundingClientRect();
        if (["auto", "scroll", "hidden", "clip"].includes(style.overflowX)) {
          visible.left = Math.max(visible.left, ancestorRect.left);
          visible.right = Math.min(visible.right, ancestorRect.right);
        }
        if (["auto", "scroll", "hidden", "clip"].includes(style.overflowY)) {
          visible.top = Math.max(visible.top, ancestorRect.top);
          visible.bottom = Math.min(visible.bottom, ancestorRect.bottom);
        }
      }
    }

    if (visible.right <= visible.left || visible.bottom <= visible.top) {
      return {
        point: null,
        outsideViewport:
          rect.right <= 0 ||
          rect.bottom <= 0 ||
          rect.left >= viewportWidth ||
          rect.top >= viewportHeight,
        viewportWidth,
        viewportHeight,
        coveringElement: null,
      };
    }

    const fractions = [0.5, 0.2, 0.8];
    let coveringElement = null;
    for (const yFraction of fractions) {
      for (const xFraction of fractions) {
        const x = Math.max(
          0,
          Math.min(
            viewportWidth - 1,
            visible.left + (visible.right - visible.left) * xFraction,
          ),
        );
        const y = Math.max(
          0,
          Math.min(
            viewportHeight - 1,
            visible.top + (visible.bottom - visible.top) * yFraction,
          ),
        );
        if (skipCover) {
          return { point: { x, y }, viewportWidth, viewportHeight };
        }
        const top = document.elementFromPoint(x, y);
        coveringElement ??= top;
        if (top?.closest?.("button") === button) {
          return { point: { x, y }, viewportWidth, viewportHeight };
        }
      }
    }
    return {
      point: null,
      outsideViewport: false,
      viewportWidth,
      viewportHeight,
      coveringElement,
    };
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
