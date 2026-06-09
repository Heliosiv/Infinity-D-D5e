import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
  const profileDir = path.join(outDir, `chrome-profile-${Date.now()}`);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(outFile, buildUiHarnessDocument(), "utf8");

  const chromeExe = findChromeExecutable();
  const port = 9300 + Math.floor(Math.random() * 500);
  const chrome = spawn(
    chromeExe,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      "--disable-background-networking",
      "--disable-gpu",
      "--disable-sync",
      "--hide-scrollbars=false",
      "--no-default-browser-check",
      "--no-first-run",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let client;
  try {
    await waitForJson(`http://127.0.0.1:${port}/json/version`);
    const pageTarget = await waitForPageTarget(port);
    client = await CdpClient.connect(pageTarget.webSocketDebuggerUrl);
    await client.send("Page.enable");
    await client.send("Runtime.enable");

    const fileUrl = pathToFileURL(outFile).href;
    const summary = [];
    for (const viewport of VIEWPORTS) {
      await client.send("Emulation.setDeviceMetricsOverride", {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: viewport.width <= 560,
        screenWidth: viewport.width,
        screenHeight: viewport.height,
      });
      await client.send("Page.navigate", {
        url: `${fileUrl}?viewport=${encodeURIComponent(viewport.name)}`,
      });
      await client.evaluate(waitForReadyExpression());

      const screenshot = await client.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
      });
      const screenshotFile = path.join(
        outDir,
        `ui-harness-${viewport.name}.png`,
      );
      writeFileSync(screenshotFile, Buffer.from(screenshot.data, "base64"));

      const result = await client.evaluate(`(${auditPage.toString()})()`);
      summary.push({ viewport, screenshotFile, ...result });
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
    await client?.close();
    await stopChrome(chrome);
    // Best-effort: Chrome can briefly hold the profile dir on Windows,
    // throwing EPERM. The temp dir is disposable, so don't fail the run.
    try {
      rmSync(profileDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    } catch (error) {
      console.warn(
        `ui:audit — could not remove temp profile: ${error.message}`,
      );
    }
  }
}

function findChromeExecutable() {
  if (process.env.INFINITY_UI_AUDIT_CHROME) {
    const explicit = process.env.INFINITY_UI_AUDIT_CHROME;
    if (existsSync(explicit)) return explicit;
    throw new Error(`INFINITY_UI_AUDIT_CHROME does not exist: ${explicit}`);
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const browserRoot = path.join(localAppData, "ms-playwright");
    if (existsSync(browserRoot)) {
      const candidates = readdirSync(browserRoot, { withFileTypes: true })
        .filter(
          (entry) => entry.isDirectory() && entry.name.startsWith("chromium"),
        )
        .map((entry) =>
          path.join(browserRoot, entry.name, "chrome-win", "chrome.exe"),
        )
        .filter((candidate) => existsSync(candidate))
        .sort()
        .reverse();
      if (candidates.length > 0) return candidates[0];
    }
  }

  const programFiles = [
    process.env.PROGRAMFILES,
    process.env["PROGRAMFILES(X86)"],
  ].filter(Boolean);
  for (const base of programFiles) {
    for (const relative of [
      path.join("Google", "Chrome", "Application", "chrome.exe"),
      path.join("Microsoft", "Edge", "Application", "msedge.exe"),
    ]) {
      const candidate = path.join(base, relative);
      if (existsSync(candidate)) return candidate;
    }
  }

  throw new Error(
    "No Chromium/Chrome executable found. Install Playwright browsers or set INFINITY_UI_AUDIT_CHROME.",
  );
}

async function waitForJson(url) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < 15000) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(
    `Timed out waiting for Chrome DevTools at ${url}: ${lastError?.message ?? "unknown"}`,
  );
}

async function waitForPageTarget(port) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < 15000) {
    try {
      const targets = await waitForJson(`http://127.0.0.1:${port}/json/list`);
      const page = targets.find(
        (target) => target.type === "page" && target.webSocketDebuggerUrl,
      );
      if (page) return page;
      lastError = new Error("no page target");
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(
    `Timed out waiting for page target: ${lastError?.message ?? "unknown"}`,
  );
}

function waitForReadyExpression() {
  return `new Promise((resolve) => {
    if (document.readyState === "complete") resolve(true);
    else window.addEventListener("load", () => resolve(true), { once: true });
  })`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopChrome(process) {
  if (process.exitCode !== null || process.signalCode !== null) return;
  process.kill();
  await Promise.race([once(process, "exit"), delay(3000)]);
}

class CdpClient {
  static async connect(url) {
    const client = new CdpClient(url);
    await client.open();
    return client;
  }

  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.socket = null;
  }

  open() {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", (event) =>
        reject(event.error ?? new Error("WebSocket error")),
      );
      socket.addEventListener("message", (event) => this.onMessage(event.data));
    });
  }

  close() {
    this.socket?.close();
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.socket.send(payload);
    });
  }

  async evaluate(expression) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      const text =
        response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text ??
        "Runtime.evaluate failed";
      throw new Error(text);
    }
    return response.result?.value;
  }

  onMessage(raw) {
    const message = JSON.parse(raw);
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(`${pending.method}: ${message.error.message}`));
    } else {
      pending.resolve(message.result);
    }
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
      ".lf-shell, .hl-shell, .pc-shell, .id-shell, .mw-shell, .ms-shell, .rm-shell, .fp-shell, .sp-shell",
    );
    for (const element of [content, shell].filter(Boolean)) {
      if (element.scrollWidth > element.clientWidth + 2) {
        issues.push(
          `${root.dataset.harnessWindow}: horizontal overflow in ${describe(element)} (${element.scrollWidth}px > ${element.clientWidth}px)`,
        );
      }
    }
  }

  async function auditButton(button, { skipCover = false } = {}) {
    button.scrollIntoView({ block: "center", inline: "center" });
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
    if (rect.width < 18 || rect.height < 18) {
      issues.push(
        `${windowName}: "${label}" action target is too small (${rect.width}x${rect.height})`,
      );
      return;
    }
    if (
      rect.right < 0 ||
      rect.bottom < 0 ||
      rect.left > innerWidth ||
      rect.top > innerHeight
    ) {
      issues.push(
        `${windowName}: "${label}" action target is outside the viewport`,
      );
      return;
    }

    const centerX = Math.max(
      0,
      Math.min(innerWidth - 1, rect.left + rect.width / 2),
    );
    const centerY = Math.max(
      0,
      Math.min(innerHeight - 1, rect.top + rect.height / 2),
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

  // Everything else, with menus collapsed.
  for (const button of buttons) {
    if (button.closest("details.lf-menu")) continue;
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
    row.scrollIntoView({ block: "center", inline: "center" });
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
