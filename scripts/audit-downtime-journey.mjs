/** Browser gauntlet: real UI controllers and player adapter; isolated campaign doubles. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import Handlebars from "handlebars";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";

const root = path.resolve(".");
const out = path.resolve("output/playwright/downtime");
mkdirSync(out, { recursive: true });
const templates = Object.fromEntries(
  ["workspace", "activities"].map((name) => [
    name,
    Handlebars.compile(readFileSync(`templates/downtime-${name}.hbs`, "utf8")),
  ]),
);
const css = ["tokens", "ui-system", "downtime"]
  .map((name) => readFileSync(`styles/${name}.css`, "utf8"))
  .join("\n");
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  try {
    if (pathname === "/") {
      response.setHeader("content-type", "text/html");
      response.end(
        `<!doctype html><html lang="en"><head><title>Downtime gauntlet</title><style>${css}\nbody{margin:0;background:#182024;color:#eee;font-family:Arial}#app{height:900px;max-width:1040px;margin:auto}button,input,select,textarea{font:inherit}button{cursor:pointer}</style></head><body><main id="app"></main></body></html>`,
      );
    } else if (pathname === "/render" && request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const { name, context } = JSON.parse(body);
      response.end(templates[name](context));
    } else if (/^\/scripts\/[\w/-]+\.(?:js|mjs)$/.test(pathname)) {
      const filename = path.resolve(root, `.${pathname}`);
      if (!filename.startsWith(`${root}${path.sep}`))
        throw new Error("Invalid path");
      response.setHeader("content-type", "text/javascript");
      response.end(readFileSync(filename));
    } else {
      response.writeHead(404);
      response.end();
    }
  } catch (error) {
    response.writeHead(500);
    response.end(String(error.message));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1100, height: 1000 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async () => {
    globalThis.foundry = {
      utils: { deepClone: (value) => structuredClone(value) },
      applications: {
        api: {
          ApplicationV2: class {},
          HandlebarsApplicationMixin: (Base) => class extends Base {},
        },
      },
    };
    globalThis.game = {
      ready: false,
      user: { id: "gm", isGM: true, role: 4 },
      settings: { get: () => undefined },
    };
    const { DowntimeWorkspaceApp } =
      await import("/scripts/downtime-workspace.js");
    const { DowntimeActivitiesApp } =
      await import("/scripts/downtime-activities.js");
    const { createDowntimePlayerAdapter } =
      await import("/scripts/downtime/ui-adapter.js");
    const { defaultGuidedDowntimeTemplates } =
      await import("/scripts/downtime/dispatch.js");
    const templates = defaultGuidedDowntimeTemplates();
    const actor = {
      id: "mira",
      name: "Mira",
      playerOwned: true,
      checked: true,
      eligible: true,
      img: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
    };
    const state = {
      block: null,
      rolls: 0,
      applied: 0,
      saved: [],
      settlements: [
        {
          id: "haven",
          name: "Haven",
          locationPresetId: "village",
          guidedTemplateIds: ["guided-performance", "guided-reflection"],
          linkedMerchantIds: ["haven-shop"],
        },
      ],
      failSave: false,
      previewHeadingFocusCount: 0,
    };
    document.addEventListener("focusin", (event) => {
      if (event.target?.id === "dt-preview-heading") {
        state.previewHeadingFocusCount += 1;
      }
    });
    const playerProjection = () => ({
      mode: "guided",
      status: state.block.status,
      blockId: state.block.id,
      hasActiveBlock: true,
      hasSettlement: false,
      locationName: state.block.locationName,
      budgetHours: state.block.hours,
      actors: [actor],
      selectedActorId: actor.id,
      submitted: Boolean(state.queue),
      rawQueue: state.queue ?? [],
      queue: state.queue ?? [],
      canSubmit: !state.queue,
      canRecall: Boolean(state.queue),
      activities: templates.map((template) => ({
        id: template.id,
        label: template.name,
        description: template.description,
        available: true,
        fixedHours: 0,
        hourOptions: Array.from(
          {
            length: Math.floor(
              state.block.hours / Math.max(1, template.blockHours ?? 8),
            ),
          },
          (_, index) => (index + 1) * Math.max(1, template.blockHours ?? 8),
        ),
        skills: template.skills.map((id) => ({ id, label: id })),
        category: "guided",
        ...(template.id === "guided-craft-arrows" ? state.toolQuote : {}),
        ...(template.id === "guided-field-ammunition" ? state.fieldQuote : {}),
      })),
      receipt: state.receipt,
    });
    const gmAdapter = {
      saveSettlement: async (payload) => {
        const saved = { ...payload, linkedMerchantIds: payload.merchantIds };
        state.settlements = [saved];
        return saved;
      },
      saveGuidedProject: async (payload) => {
        state.projectSaves = (state.projectSaves || 0) + 1;
        state.lastProjectSave = structuredClone(payload);
        return { ...payload, id: "project-observatory" };
      },
      saveGuidedTemplate: async (payload) => {
        const saved = {
          ...payload,
          id: payload.id || `custom-${state.activitySaves || 0}`,
        };
        const index = templates.findIndex((row) => row.id === saved.id);
        if (index < 0) templates.push(saved);
        else templates[index] = saved;
        state.activitySaves = (state.activitySaves || 0) + 1;
        state.lastActivitySave = structuredClone(payload);
        return saved;
      },
      getWorkspaceProjection: async () => ({
        actors: [actor],
        settlements: state.settlements,
        merchants: [{ id: "haven-shop", name: "Haven Supplies" }],
        guidedTemplates: templates,
        workflow: state.block,
        canCreateBlock: !state.block,
      }),
      createBlock: async (payload) => {
        state.block = {
          id: "block",
          mode: "guided",
          status: "collecting",
          ...payload,
          participants: [{ ...actor, actorId: actor.id, submitted: false }],
        };
        return state.block;
      },
      openForPlayers: async () => true,
      lockBlock: async () => {
        state.block.status = "locked";
        return state.block;
      },
      planBlock: async () => {
        state.block.status = "planned";
        state.block.plan = {
          characters: [
            {
              actorId: actor.id,
              name: actor.name,
              operations: state.queue.map((entry, entryIndex) => {
                const activity = templates.find(
                  (candidate) => candidate.id === entry.activityId,
                );
                return {
                  id: `result-${entryIndex + 1}`,
                  label: activity.name,
                  hours: entry.hours,
                  rollLabel: entry.skill
                    ? `${entry.skill} roll: 17`
                    : "No skill check",
                  report: activity.outcomes[1].report,
                  outcome: activity.outcomes[1].label,
                  outcomeOptions: activity.outcomes.map((option, index) => ({
                    ...option,
                    index,
                    selected: index === 1,
                    rewardLabel: `${option.rewardGp} gp`,
                  })),
                };
              }),
            },
          ],
        };
        return state.block;
      },
      prepareParticipant: async () => {
        state.block.status = "locked";
        return gmAdapter.planBlock();
      },
      chooseGuidedOutcome: async (payload) => {
        if (state.failSave)
          throw new Error("Test report save interrupted. Refresh and retry.");
        const operation = state.block.plan.characters[0].operations.find(
          (entry) => entry.id === payload.operationId,
        );
        const outcome = operation.outcomeOptions[payload.outcomeIndex];
        for (const option of operation.outcomeOptions)
          option.selected = option === outcome;
        operation.report = payload.report ?? outcome.report;
        operation.outcome = outcome.label;
        if (payload.benefitTarget !== undefined) {
          operation.benefitTarget = payload.benefitTarget;
          for (const target of operation.benefitTargets ?? [])
            target.selected = target.id === payload.benefitTarget;
        }
        state.saved.push(payload);
        return state.block;
      },
      applyBlock: async () => {
        state.applied += 1;
        state.block.status = "completed";
        state.receipt = {
          completedAt: Date.parse("2026-09-03T15:00:00Z"),
          summary: "Downtime complete",
          activities: state.block.plan.characters[0].operations.map(
            (operation) => ({
              id: operation.id,
              label: operation.label,
              report: operation.report,
              rewardLabel: "4 gp",
            }),
          ),
        };
        return state.block;
      },
    };
    const playerAdapter = createDowntimePlayerAdapter({
      isAuthority: () => true,
      registerSocket: () => {},
      subscribeSocket: () => () => {},
      getCurrentUserId: () => "player",
      getActor: () => actor,
      getDirectProjection: async () => playerProjection(),
      submitDirect: async ({ queue }) => {
        state.queue = queue;
        state.block.participants[0] = {
          ...state.block.participants[0],
          submitted: true,
          queue,
          usedHours: queue.reduce((sum, entry) => sum + entry.hours, 0),
          canPrepare: true,
          resolutionLabel: "Ready for GM review",
        };
      },
      rollSkill: async () => {
        state.rolls += 1;
        return { ok: true, total: 17, roll: { formula: "1d20 + 5" } };
      },
    });
    async function mount(name) {
      if (globalThis.journey?.app) {
        globalThis.journey.app.rendered = false;
        await globalThis.journey.app.rendering;
      }
      const Type =
        name === "workspace" ? DowntimeWorkspaceApp : DowntimeActivitiesApp;
      const app = Object.create(Type.prototype);
      Object.assign(app, {
        element: document.getElementById("app"),
        _adapter: name === "workspace" ? gmAdapter : playerAdapter,
        _view: "current",
        _actorId: actor.id,
        _busy: false,
        _guidedReportDrafts: new Map(),
        _actorSelectorState: undefined,
        rendered: true,
        _statusMessage: "",
        _errorMessage: "",
        _selectedSettlementId: null,
        _creatingSettlement: false,
      });
      app.captureWorkbenchTarget = undefined;
      app.prepareWorkbenchContext = undefined;
      app.element.className = `infinity-dnd5e infinity-downtime-${name}`;
      app.render = () => {
        app.rendering = (app.rendering ?? Promise.resolve()).then(async () => {
          const context = await app._prepareContext();
          const response = await fetch("/render", {
            method: "POST",
            body: JSON.stringify({ name, context }),
          });
          app.element.innerHTML = await response.text();
          app._onRender(context, {});
          for (const button of app.element.querySelectorAll("[data-action]"))
            button.addEventListener("click", async (event) => {
              if (button.disabled) return;
              try {
                await Type.DEFAULT_OPTIONS.actions[button.dataset.action].call(
                  app,
                  event,
                  button,
                );
              } catch (error) {
                state.error = error.message;
              }
            });
        });
        return app.rendering;
      };
      globalThis.journey.app = app;
      await app.render();
    }
    globalThis.journey = { state, mount, playerAdapter, templates };
    await mount("workspace");
  });

  await page.locator('[data-action="setView"][data-view="projects"]').click();
  await page
    .locator('[data-action="projectPreset"][data-preset="craft"]')
    .click();
  await page.evaluate(() => journey.app.rendering);
  assert.equal(
    await page
      .getByLabel("Total productive hours", { exact: true })
      .inputValue(),
    "40",
  );
  assert.equal(
    await page
      .getByLabel("Total project cost (gp)", { exact: true })
      .inputValue(),
    "100",
  );
  assert.equal(
    await page
      .getByLabel("Successful checks required", { exact: true })
      .inputValue(),
    "3",
  );
  assert.equal(
    await page.getByLabel("Check DC", { exact: true }).inputValue(),
    "15",
  );
  await page.screenshot({
    path: path.join(out, "gm-project-preset-1040.png"),
    fullPage: true,
  });
  await page
    .getByLabel("Project name", { exact: true })
    .fill("Restore the observatory");
  await page.getByLabel("Total productive hours", { exact: true }).fill("0");
  await page.locator('[data-action="saveGuidedProject"]').click();
  assert.equal(await page.evaluate(() => journey.state.projectSaves || 0), 0);
  await page.getByLabel("Total productive hours", { exact: true }).fill("80");
  await page
    .locator('[data-form="guided-project"] [name="skills"][value="arc"]')
    .check();
  await page.locator('[data-action="refresh"]').click();
  await page.evaluate(() => journey.app.rendering);
  assert.equal(
    await page.getByLabel("Project name", { exact: true }).inputValue(),
    "Restore the observatory",
  );
  assert.equal(
    await page
      .getByLabel("Total productive hours", { exact: true })
      .inputValue(),
    "80",
  );
  assert.equal(
    await page
      .locator('[data-form="guided-project"] [name="skills"][value="arc"]')
      .isChecked(),
    true,
  );
  await page.locator('[data-action="setView"][data-view="current"]').click();
  await page.evaluate(() => journey.app.rendering);
  await page.locator('[data-action="setView"][data-view="projects"]').click();
  await page.evaluate(() => journey.app.rendering);
  assert.equal(
    await page.getByLabel("Project name", { exact: true }).inputValue(),
    "Restore the observatory",
  );
  await page.locator('[data-action="saveGuidedProject"]').click();
  await page.waitForFunction(() => journey.state.projectSaves === 1);
  assert.deepEqual(await page.evaluate(() => journey.state.lastProjectSave), {
    id: "",
    name: "Restore the observatory",
    description:
      "Make, repair, or commission a substantial item over several downtime blocks.",
    blockHours: "8",
    requiredHours: "80",
    requiredGp: "100",
    requiredSuccesses: "3",
    checkDc: "15",
    skills: ["arc", "ath", "inv"],
  });
  await page.evaluate(() => journey.app.rendering);
  assert.equal(
    await page.getByLabel("Project name", { exact: true }).inputValue(),
    "",
  );

  await page.locator('[data-action="setView"][data-view="activities"]').click();
  await page.evaluate(() => journey.app.rendering);
  assert.equal(await page.locator('[data-action="craftingPreset"]').count(), 0);
  await page
    .locator(
      '[data-action="selectGuidedTemplate"][data-template-id="guided-training"]',
    )
    .click();
  await page.evaluate(() => journey.app.rendering);
  assert.equal(
    await page.locator('[name="outcomeBenefit"]').nth(2).inputValue(),
    "sparring",
  );
  await page.locator('[data-action="newGuidedTemplate"]').click();
  await page.evaluate(() => journey.app.rendering);
  await page
    .getByLabel("Activity name", { exact: true })
    .fill("Community garden");
  await page
    .locator('[name="outcomeReport"]')
    .nth(0)
    .fill("The seedlings are tended.");
  await page
    .locator('[name="outcomeReport"]')
    .nth(1)
    .fill("The garden is thriving.");
  await page
    .locator('[name="outcomeReport"]')
    .nth(2)
    .fill("A generous harvest is ready.");
  await page.locator('[name="outcomeReward"]').nth(2).fill("-1");
  await page.locator('[data-action="saveGuidedTemplate"]').click();
  assert.equal(
    await page.evaluate(() => journey.state.activitySaves || 0),
    0,
    "invalid activity rewards stay in the editor",
  );
  await page.locator('[name="outcomeReward"]').nth(2).fill("2.5");
  await page.locator('[data-action="setView"][data-view="current"]').click();
  await page.evaluate(() => journey.app.rendering);
  await page.locator('[data-action="setView"][data-view="activities"]').click();
  await page.evaluate(() => journey.app.rendering);
  assert.equal(
    await page.getByLabel("Activity name", { exact: true }).inputValue(),
    "Community garden",
  );
  assert.equal(
    await page.locator('[name="outcomeReward"]').nth(2).inputValue(),
    "2.5",
  );
  for (const width of [1040, 720, 380]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 1,
      ),
      false,
      `activity editor fits ${width}px`,
    );
    const a11y = await new AxeBuilder({ page })
      .include("#app")
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();
    assert.deepEqual(
      a11y.violations.map(({ id, nodes }) => ({
        id,
        targets: nodes.map((node) => node.target),
      })),
      [],
      `accessible activity editor at ${width}px`,
    );
    await page.screenshot({
      path: path.join(out, `gm-activity-editor-${width}.png`),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1100, height: 1000 });
  await page.locator('[data-action="saveGuidedTemplate"]').click();
  await page.waitForFunction(() => journey.state.activitySaves === 1);
  await page
    .locator(
      '[data-action="selectGuidedTemplate"][data-template-id="guided-craft-arrows"]',
    )
    .click();
  await page.evaluate(() => journey.app.rendering);
  assert.equal(
    await page.getByLabel("Activity name", { exact: true }).inputValue(),
    "Craft Arrows",
  );
  assert.equal(
    await page.locator('[name="workOutput"]').inputValue(),
    "arrows",
  );
  assert.equal(await page.locator('[name="workBatchGp"]').inputValue(), "0.5");
  const toolPicker = page.getByLabel("Required tools (all selected are kept)", {
    exact: true,
  });
  assert.deepEqual(
    await toolPicker.locator("option:checked").allTextContents(),
    ["Fletcher's Tools"],
    await toolPicker.evaluate((select) => select.outerHTML),
  );
  await toolPicker.selectOption(["Fletcher's Tools", "Smith's Tools"]);
  for (const width of [1040, 380]) {
    await page.setViewportSize({ width, height: 1000 });
    await toolPicker.scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 1,
      ),
      false,
      `tool picker fits ${width}px`,
    );
    await page.screenshot({
      path: path.join(out, `gm-tool-requirements-${width}.png`),
    });
  }
  await page.setViewportSize({ width: 1100, height: 1000 });
  await page
    .getByLabel("Additional cost per workday (gp)", { exact: true })
    .fill("2");
  await page
    .locator("summary")
    .filter({ hasText: "Inventory materials to consume" })
    .click();
  await page.locator('[name="materialName"]').nth(0).selectOption("Iron");
  assert.equal(
    await page
      .getByLabel("Material 1 custom inventory name", { exact: true })
      .isVisible(),
    false,
  );
  await page.locator('[name="materialName"]').nth(1).selectOption("__custom__");
  await page
    .getByLabel("Material 2 custom inventory name", { exact: true })
    .fill("Workshop binding resin");
  await page.locator('[name="materialQuantity"]').nth(0).fill("3");
  await page.locator('[data-action="refresh"]').click();
  await page.evaluate(() => journey.app.rendering);
  assert.equal(await page.locator('[name="workGpPerDay"]').inputValue(), "2");
  assert.deepEqual(
    await toolPicker.locator("option:checked").allTextContents(),
    ["Fletcher's Tools", "Smith's Tools"],
    "tool selections survive refresh",
  );
  assert.equal(
    await page.locator('[name="materialName"]').nth(0).inputValue(),
    "Iron",
  );
  assert.equal(
    await page
      .getByLabel("Material 2 custom inventory name", { exact: true })
      .inputValue(),
    "Workshop binding resin",
  );
  await page
    .locator("summary")
    .filter({ hasText: "Inventory materials to consume" })
    .click();
  for (const width of [1040, 380]) {
    await page.setViewportSize({ width, height: 1000 });
    await page
      .getByLabel("Material 1 name", { exact: true })
      .scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 1,
      ),
      false,
    );
    await page.screenshot({
      path: path.join(out, `gm-material-picker-${width}.png`),
    });
  }
  await page.setViewportSize({ width: 1100, height: 1000 });
  await page.locator('[data-action="saveGuidedTemplate"]').click();
  await page.waitForFunction(() => journey.state.activitySaves === 2);
  assert.deepEqual(
    await page.evaluate(() =>
      journey.state.lastActivitySave.work.materials
        .slice(0, 2)
        .map((material) => material.name),
    ),
    ["Iron", "Workshop binding resin"],
  );
  assert.deepEqual(
    await page.evaluate(
      () => journey.state.lastActivitySave.work.requiredTools,
    ),
    ["Fletcher's Tools", "Smith's Tools"],
  );
  await page
    .locator(
      '[data-action="selectGuidedTemplate"][data-template-id="guided-scribe-scroll"]',
    )
    .click();
  await page.evaluate(() => journey.app.rendering);
  assert.equal(
    await page.locator('[name="workOutput"]').inputValue(),
    "scroll",
  );
  assert.equal(
    await page.locator('[name="workBatchGp"]').isVisible(),
    false,
    "scroll pricing uses its spell level",
  );
  assert.match(
    await page.locator('[data-work-output="scroll"]').innerText(),
    /original is kept/,
  );
  await page.locator('[data-action="saveGuidedTemplate"]').click();
  await page.waitForFunction(() => journey.state.activitySaves === 3);
  await page.locator('[data-action="setView"][data-view="current"]').click();

  assert.equal(
    await page
      .locator('[name="templateIds"][value="guided-performance"]')
      .isDisabled(),
    true,
  );
  await page.screenshot({
    path: path.join(out, "gm-location-wilderness.png"),
    fullPage: true,
  });
  await page.locator('[name="locationPresetId"]').selectOption("town");
  await page.waitForFunction(
    () =>
      !document.querySelector(
        '[name="templateIds"][value="guided-performance"]',
      ).disabled,
  );
  await page.locator('[name="settlementId"]').selectOption("haven");
  await page.waitForFunction(
    () => document.querySelector('[name="locationPresetId"]').disabled,
  );
  assert.equal(
    await page
      .locator('[name="templateIds"][value="guided-performance"]')
      .isChecked(),
    true,
  );
  assert.equal(
    await page
      .locator('[name="templateIds"][value="guided-labor"]')
      .isDisabled(),
    true,
  );
  assert.match(
    await page.locator('[data-form="new-block"]').innerText(),
    /Haven Supplies/,
  );
  await page
    .locator('[data-action="setView"][data-view="settlements"]')
    .first()
    .click();
  await page
    .locator('[data-action="selectSettlement"][data-settlement-id="haven"]')
    .click();
  await page.evaluate(async () => {
    await journey.app.rendering;
  });
  await page
    .locator('[data-form="settlement-edit"] [name="locationPresetId"]')
    .selectOption("wilderness");
  assert.equal(
    await page
      .locator('[name="guidedTemplateIds"][value="guided-performance"]')
      .isChecked(),
    false,
  );
  await page
    .locator('[name="guidedTemplateIds"][value="guided-performance"]')
    .check();
  await page.screenshot({
    path: path.join(out, "gm-location-settlement-editor.png"),
    fullPage: true,
  });
  await page.locator('[data-action="saveSettlement"]').click();
  await page.waitForFunction(
    () =>
      !journey.app._busy &&
      journey.state.settlements[0].locationPresetId === "wilderness",
  );
  await page.evaluate(async () => {
    await journey.app.rendering;
  });
  assert.equal(
    await page.evaluate(() =>
      journey.state.settlements[0].guidedTemplateIds.includes(
        "guided-craft-arrows",
      ),
    ),
    true,
  );
  assert.equal(
    await page.evaluate(() =>
      journey.state.settlements[0].guidedTemplateIds.includes(
        "guided-performance",
      ),
    ),
    true,
  );
  await page.locator('[data-action="setView"][data-view="current"]').click();
  assert.equal(
    await page.locator('[name="settlementId"]').inputValue(),
    "haven",
  );
  await page.locator('[name="settlementId"]').selectOption("");
  await page.waitForFunction(
    () => !document.querySelector('[name="locationPresetId"]').disabled,
  );
  await page.locator('[name="locationPresetId"]').selectOption("town");
  await page.waitForFunction(
    () =>
      !document.querySelector('[name="templateIds"][value="guided-labor"]')
        .disabled,
  );
  await page.locator('[name="locationName"]').fill("Harbor workshop");
  await page.locator('[name="hours"]').fill("241");
  await page.locator('[data-action="createBlock"]').click();
  assert.equal(await page.evaluate(() => journey.state.block), null);
  await page.locator('[name="hours"]').fill("240");
  await page.locator('[name="templateIds"][value="guided-thievery"]').uncheck();
  await page.locator('[data-action="refresh"]').click();
  await page.evaluate(() => journey.app.rendering);
  assert.equal(
    await page.locator('[name="locationName"]').inputValue(),
    "Harbor workshop",
  );
  assert.equal(await page.locator('[name="hours"]').inputValue(), "240");
  assert.equal(
    await page
      .locator('[name="templateIds"][value="guided-thievery"]')
      .isChecked(),
    false,
  );
  await page.locator('[data-action="createBlock"]').click();
  await page.waitForFunction(() => journey.state.block?.hours === 240);
  assert.deepEqual(await page.evaluate(() => journey.state.block.actorIds), [
    "mira",
  ]);
  await page.evaluate(() => journey.mount("activities"));
  assert.equal(
    await page.locator('[data-action="submitQueue"]').isDisabled(),
    true,
  );
  await page
    .locator('[data-activity-id="guided-research"] [data-action="addActivity"]')
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-action="submitQueue"]')?.disabled === false,
  );
  await page
    .locator('[data-activity-id="guided-reflection"] [name="hours"]')
    .selectOption("1");
  await page
    .locator(
      '[data-activity-id="guided-reflection"] [data-action="addActivity"]',
    )
    .click();
  await page
    .locator('[data-activity-id="guided-labor"] [data-action="addActivity"]')
    .click();
  await page.waitForFunction(() =>
    document.querySelector(".dt-time-meter")?.textContent.includes("17 / 240"),
  );
  assert.equal(await page.locator("li[data-queue-entry-id]").count(), 3);
  assert.equal(await page.locator('[data-action="moveActivityUp"]').count(), 3);
  assert.match(await page.locator(".dt-time-meter").innerText(), /17 \/ 240/);
  await page.locator('[data-action="submitQueue"]').focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => journey.state.queue?.length === 3);
  assert.equal(await page.evaluate(() => journey.state.rolls), 2);
  assert.deepEqual(
    await page.evaluate(() => journey.state.queue.map((entry) => entry.hours)),
    [8, 1, 8],
  );
  await page.evaluate(() => journey.mount("workspace"));
  const plannedFocusCount = await page.evaluate(
    () => journey.state.previewHeadingFocusCount,
  );
  await page.locator('[data-action="prepareParticipant"]').first().click();
  await page.waitForFunction(() =>
    document.querySelector("[data-guided-report]"),
  );
  await page.waitForFunction(
    (previousCount) => journey.state.previewHeadingFocusCount > previousCount,
    plannedFocusCount,
  );
  assert.equal(
    await page.evaluate(() => journey.state.block.status),
    "planned",
  );
  await page
    .locator('[data-action="chooseGuidedOutcome"][data-outcome-index="2"]')
    .first()
    .click();
  await page.waitForFunction(
    () =>
      document
        .querySelector(
          '[data-action="chooseGuidedOutcome"][data-outcome-index="2"]',
        )
        ?.getAttribute("aria-pressed") === "true",
  );
  const report =
    "Mira rebuilt the harbor crane and earned the foreman's thanks.";
  await page.locator("[data-guided-report]").first().fill(report);
  await page.locator('[data-action="refresh"]').click();
  await page.evaluate(() => journey.app.rendering);
  assert.equal(
    await page.locator("[data-guided-report]").first().inputValue(),
    report,
    "refresh retains report edits",
  );

  for (const width of [1040, 720, 380]) {
    await page.setViewportSize({ width, height: 1000 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    );
    assert.equal(overflow, false, `no horizontal page overflow at ${width}px`);
    const a11y = await new AxeBuilder({ page })
      .include("#app")
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();
    assert.deepEqual(
      a11y.violations.map(({ id, nodes }) => ({
        id,
        targets: nodes.map((node) => node.target),
      })),
      [],
      `accessible guided review at ${width}px`,
    );
    await page.locator(".dt-preview").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(out, `gm-review-${width}.png`),
      fullPage: true,
    });
  }
  await page.evaluate(() => {
    journey.state.failSave = true;
  });
  await page.locator('[data-action="applyBlock"]').click();
  await page.waitForFunction(() =>
    document
      .querySelector('[role="alert"]')
      ?.textContent.includes("save interrupted"),
  );
  assert.equal(
    await page.evaluate(() => journey.state.applied),
    0,
    "failed report save stops application",
  );
  assert.equal(
    await page.locator("[data-guided-report]").first().inputValue(),
    report,
  );
  await page.evaluate(() => {
    journey.state.failSave = false;
  });
  await page.locator('[data-action="saveGuidedReport"]').first().click();
  await page.waitForFunction(() =>
    journey.state.saved.some((payload) =>
      payload.report?.includes("harbor crane"),
    ),
  );
  await page.waitForFunction(() => !journey.app._busy);
  await page.evaluate(async () => {
    await journey.app.rendering;
  });
  await page
    .locator("[data-guided-report]")
    .first()
    .fill(`${report} The workshop will welcome her back.`);
  const appliedFocusCount = await page.evaluate(
    () => journey.state.previewHeadingFocusCount,
  );
  await page.locator('[data-action="applyBlock"]').click();
  await page.waitForFunction(() => journey.state.applied === 1);
  await page.waitForFunction(
    (previousCount) => journey.state.previewHeadingFocusCount > previousCount,
    appliedFocusCount,
  );
  await page.evaluate(async () => {
    journey.playerAdapter.invalidate();
    await journey.mount("activities");
  });
  assert.match(
    await page.locator(".dt-receipt").innerText(),
    /workshop will welcome her back/,
  );
  await page.screenshot({
    path: path.join(out, "player-report.png"),
    fullPage: true,
  });
  assert.equal(await page.evaluate(() => journey.state.error ?? ""), "");
  assert.deepEqual(errors, []);
  await page.evaluate(async () => {
    journey.state.block.status = "planned";
    const operation = journey.state.block.plan.characters[0].operations[0];
    operation.label = "Tend the Sick";
    operation.rollLabel = "Medicine roll: 20";
    operation.outcome = "Recovery progress";
    operation.report =
      "Your skilled care helped your patient rest and recover.";
    operation.outcomeOptions = [
      {
        index: 0,
        label: "Comfort and rest",
        report: "Your patient is more comfortable.",
        rewardLabel: "No currency",
        selected: false,
      },
      {
        index: 1,
        label: "Steady care",
        report: "You keep your patient rested.",
        rewardLabel: "No currency",
        selected: false,
      },
      {
        index: 2,
        label: "Recovery progress",
        report: operation.report,
        rewardLabel: "Reduce one injury by 1 day (8 hours of care)",
        selected: true,
      },
    ];
    operation.needsBenefitTarget = true;
    operation.benefitTarget = "";
    operation.benefitSummary =
      "Select one patient and timed injury before applying.";
    operation.benefitTargets = [
      { id: "mira|ribs", label: "Mira — Bruised ribs" },
      { id: "mira|ankle", label: "Mira — Twisted ankle" },
    ];
    await journey.mount("workspace");
  });
  await page.locator("[data-benefit-target]").selectOption("mira|ribs");
  await page.waitForFunction(
    () => journey.state.saved.at(-1)?.benefitTarget === "mira|ribs",
  );
  await page.evaluate(() => journey.app.rendering);
  assert.equal(
    await page.locator("[data-benefit-target]").inputValue(),
    "mira|ribs",
  );
  await page.setViewportSize({ width: 900, height: 760 });
  await page.screenshot({
    path: path.join(out, "gm-injury-care.png"),
    fullPage: true,
  });
  // Applying also saves a changed selection whose change event has not fired.
  await page.locator("[data-benefit-target]").evaluate((select) => {
    select.value = "mira|ankle";
  });
  await page.locator('[data-action="applyBlock"]').click();
  await page.waitForFunction(() => journey.state.applied === 2);
  assert.equal(
    await page.evaluate(() => journey.state.saved.at(-1).benefitTarget),
    "mira|ankle",
  );
  await page.locator('[data-action="setView"][data-view="activities"]').click();
  await page.evaluate(() => journey.app.rendering);
  await page
    .locator(
      '[data-action="selectGuidedTemplate"][data-template-id="guided-field-ammunition"]',
    )
    .click();
  await page.evaluate(() => journey.app.rendering);
  const fieldRisk = page.getByLabel(
    "Gathering complication chance per hour (%)",
    { exact: true },
  );
  assert.equal(await fieldRisk.inputValue(), "5");
  assert.equal(
    await page.locator('[name="workGpPerBlock"]').isVisible(),
    false,
  );
  assert.equal(
    await page.locator('[name="outcomeReward"]').first().isVisible(),
    false,
  );
  assert.equal(
    await page
      .locator('[name="outcomeLabel"]')
      .first()
      .getAttribute("readonly"),
    "",
  );
  await fieldRisk.fill("0");
  await page.locator('[data-action="saveGuidedTemplate"]').click();
  await page.evaluate(() => journey.app.rendering);
  assert.equal(await fieldRisk.inputValue(), "0", "zero risk survives saving");
  await fieldRisk.fill("5");
  await page.locator('[data-action="saveGuidedTemplate"]').click();
  await page.evaluate(() => journey.app.rendering);
  const fieldEditorA11y = await new AxeBuilder({ page })
    .include("#app")
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  assert.deepEqual(
    fieldEditorA11y.violations.map(({ id }) => id),
    [],
  );
  await page.evaluate(async () => {
    const { projectGuidedWork } = await import("/scripts/downtime/work.js");
    journey.state.block.hours = 4;
    journey.state.queue = null;
    journey.state.block.status = "collecting";
    journey.state.fieldQuote = projectGuidedWork(
      {
        id: "mira",
        system: { currency: { gp: 10, sp: 0, cp: 0, pp: 0, ep: 0 } },
        items: [
          {
            id: "fletcher",
            name: "Fletcher's Tools",
            type: "tool",
            system: { quantity: 1 },
          },
        ],
      },
      journey.templates.find((entry) => entry.id === "guided-field-ammunition"),
      1,
      {},
      "wilderness",
      4,
    );
    journey.playerAdapter.invalidate();
    await journey.mount("activities");
  });
  const fieldCard = page.locator(
    '[data-activity-id="guided-field-ammunition"]',
  );
  await fieldCard.locator('[name="targetId"]').selectOption("arrows:gather");
  assert.equal(
    await fieldCard.locator('[data-action="addActivity"]').isDisabled(),
    true,
    "one hour cannot contain both gathering and crafting",
  );
  await fieldCard.locator('[name="hours"]').selectOption("4");
  assert.equal(
    await fieldCard.locator('[data-action="addActivity"]').isEnabled(),
    true,
  );
  assert.match(
    await fieldCard.locator("[data-target-detail]").innerText(),
    /3h crafting/,
  );
  assert.match(
    await fieldCard.locator("[data-target-detail]").innerText(),
    /Complication chance: 5%/,
  );
  assert.doesNotMatch(await fieldCard.innerText(), /DC\s+\d+/);
  for (const width of [1040, 720, 380]) {
    await page.setViewportSize({ width, height: 1000 });
    await fieldCard.scrollIntoViewIfNeeded();
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    );
    await fieldCard.screenshot({
      path: path.join(out, `field-ammunition-${width}.png`),
    });
  }
  const rollsBeforeField = await page.evaluate(() => journey.state.rolls);
  await fieldCard.locator('[data-action="addActivity"]').click();
  await page.evaluate(() => journey.app.rendering);
  assert.match(
    await page.locator(".dt-queue__list").innerText(),
    /Complication chance: 5%/,
  );
  await page.locator('[data-action="submitQueue"]').click();
  await page.evaluate(() => journey.app.rendering);
  assert.equal(
    await page.evaluate(() => journey.state.rolls),
    rollsBeforeField + 2,
  );
  assert.equal(
    await page.evaluate(() => journey.state.queue[0].gatheringRoll.total),
    17,
  );
  assert.equal(errors.length, 0, errors.join("\n"));
  await page.evaluate(async () => {
    const { projectGuidedWork } = await import("/scripts/downtime/work.js");
    journey.toolActor = {
      id: "mira",
      system: { currency: { pp: 0, gp: 100, ep: 0, sp: 0, cp: 0 } },
      items: [
        {
          id: "smith",
          name: "Smith's Tools",
          type: "tool",
          system: { quantity: 1 },
        },
        { id: "iron", name: "Iron", type: "loot", system: { quantity: 3 } },
        {
          id: "resin",
          name: "Workshop binding resin",
          type: "loot",
          system: { quantity: 1 },
        },
      ],
    };
    journey.state.block.hours = 24;
    journey.state.block.status = "collecting";
    journey.state.queue = null;
    journey.state.receipt = null;
    journey.state.toolQuote = projectGuidedWork(
      journey.toolActor,
      journey.templates.find((entry) => entry.id === "guided-craft-arrows"),
      8,
    );
    journey.playerAdapter.invalidate();
    await journey.mount("activities");
  });
  const arrowCard = page.locator('[data-activity-id="guided-craft-arrows"]');
  assert.match(await arrowCard.innerText(), /Fletcher's Tools/);
  assert.equal(
    await arrowCard.locator('[data-action="addActivity"]').count(),
    0,
    "missing required kit prevents selecting Craft Arrows",
  );
  await page.evaluate(async () => {
    const { projectGuidedWork } = await import("/scripts/downtime/work.js");
    journey.toolActor.items.push({
      id: "fletcher",
      name: "Fletcher's Tools",
      type: "tool",
      system: { quantity: 1 },
    });
    journey.state.toolQuote = projectGuidedWork(
      journey.toolActor,
      journey.templates.find((entry) => entry.id === "guided-craft-arrows"),
      8,
    );
    journey.playerAdapter.invalidate();
    await journey.mount("activities");
  });
  await arrowCard
    .getByRole("button", { name: "Allocate Craft Arrows", exact: true })
    .click();
  await page.evaluate(() => journey.app.rendering);
  assert.match(
    await page.locator(".dt-queue__list").innerText(),
    /Craft Arrows/,
  );
  await page.evaluate(async () => {
    const { projectGuidedWork } = await import("/scripts/downtime/work.js");
    journey.toolActor.items.find(
      (item) => item.name === "Iron",
    ).system.quantity = 2;
    journey.state.toolQuote = projectGuidedWork(
      journey.toolActor,
      journey.templates.find((entry) => entry.id === "guided-craft-arrows"),
      8,
    );
    journey.playerAdapter.invalidate();
    await journey.mount("activities");
  });
  assert.match(await arrowCard.innerText(), /Missing 1 × Iron/);
  assert.equal(
    await arrowCard.locator('[data-action="addActivity"]').count(),
    0,
    "insufficient material quantity prevents crafting",
  );
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log(
    "Downtime browser gauntlet passed: included crafting, benefit selector, patient selection and save-before-apply, project preset, setup, a three-entry split allocation with forfeited hours, individual GM review, draft refresh, failed-save stop, apply and receipt; 3 responsive/accessibility sizes.",
  );
} catch (error) {
  const page = browser.contexts()[0]?.pages()[0];
  if (page) {
    await page.screenshot({
      path: path.join(out, "failure.png"),
      fullPage: true,
    });
    console.error((await page.locator("body").innerText()).slice(0, 4000));
  }
  throw error;
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
