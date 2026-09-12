/** Production bindings for the durable Resource coordinator. */
import { createResourceOperationCoordinator } from "./operation-coordinator.js";
import { createResourceOperationContext } from "./operation-ledger.js";
import { summarizeResourceInventoryPlan } from "./operation-inventory.js";
import {
  createResourceOperationStoreV5Adapter,
  loadResourceConfig,
  loadRunState,
  resourceOperationMode,
} from "./store.js";
import {
  actorItemSnapshots,
  getPartyRoster,
  resolveForageRollTargets,
  diagnoseResourceWritePreflight,
  buildUpkeepReportContent,
  buildForageDriveReportContent,
  resolveResourceDepositTemplate,
  resolveReportWhisper,
  rollDie,
} from "./calendar-watcher.js";
import { buildUpkeepRunReceipt, buildForageRunReceipt } from "./history.js";
import {
  computeForageYield,
  combineYields,
  forageTargetChannels,
  aggregateForageAssignments,
} from "./forage.js";
import { getWisMod } from "./roll.js";
import { findEnvironment } from "./environment.js";
import { publicForageEnvironment } from "./public-environment.js";
import { suggestExhaustion } from "./consumption.js";
import { normalizeSupplyCredits } from "./demand.js";
import {
  RESOURCE_EVENTS,
  emitResourceEvent,
  isAuthoritativeGM,
} from "./socket.js";
import { getSetting, SETTING_KEYS } from "../settings.js";
import { isFullGM } from "../permissions.js";

let singleton;
let timer;

function liveContext() {
  const config = loadResourceConfig();
  const state = loadRunState();
  const environmentId =
    state.currentEnvironmentId ||
    getSetting(SETTING_KEYS.RESOURCE_DEFAULT_ENVIRONMENT) ||
    "limited";
  return {
    config,
    environmentId,
    supplyCredits: normalizeSupplyCredits(
      state.lastUpkeepResult?.supplyCredits,
    ),
    roster: getPartyRoster(config).map(
      ({ actor, consumes, isStash, drawFromId }) => ({
        actorId: actor.id,
        name: actor.name,
        consumes,
        isStash,
        drawFromId,
      }),
    ),
  };
}

/** Injectable domain bindings let tests exercise the same production flow. */
export function createResourceOperationRuntime({
  store = createResourceOperationStoreV5Adapter(),
  readContext = liveContext,
  actors = () => globalThis.game?.actors,
  now = () => Date.now(),
  resolveTargets = resolveForageRollTargets,
  yieldDie = rollDie,
  resolveTemplate = resolveResourceDepositTemplate,
  emitPrompt = (payload) =>
    emitResourceEvent(RESOURCE_EVENTS.DAY_PROMPT, payload),
  deliveryBindings,
} = {}) {
  const currentSnapshot = (record) => ({
    ...record.context.snapshot,
    ...readContext(),
  });
  const assertContext = (record) => {
    if (
      createResourceOperationContext(currentSnapshot(record)).fingerprint !==
      record.context.fingerprint
    )
      throw new Error(
        "Supplies, roster or environment changed; review this run before continuing",
      );
  };
  const selectedResources = (record) => {
    const { config, resourceIds } = record.context.snapshot;
    return config.resources.filter(
      (r) =>
        (config.waterEnabled !== false ||
          (r.id !== "water" && r.forageYields !== "water")) &&
        (resourceIds === null || resourceIds.includes(r.id)),
    );
  };
  const inventoryRoster = (record) =>
    record.context.snapshot.roster.map((member) => {
      const actor = actors()?.get?.(member.actorId);
      if (!actor) throw new Error("A supply actor is no longer available");
      return { ...member, items: actorItemSnapshots(actor) };
    });
  const preflight = (record) => {
    assertContext(record);
    const config = record.context.snapshot.config;
    const roster = record.context.snapshot.roster.map((member) =>
      actors()?.get?.(member.actorId),
    );
    if (
      roster.some((actor) => !actor) ||
      diagnoseResourceWritePreflight({ config, actors: roster }).blocked
    )
      throw new Error(
        "Supply inventory is missing or has overlapping resource rules",
      );
  };
  const domain = {
    captureCurrentContext: currentSnapshot,
    resolveActors(record) {
      preflight(record);
      return actors();
    },
    resolveResources(record) {
      assertContext(record);
      return record.context.snapshot.config.resources;
    },
    buildPromptAssignments(record, { assignedAt }) {
      preflight(record);
      const { config, forageAssignments, forageEnabled } =
        record.context.snapshot;
      if (!forageEnabled) return [];
      const wanted = new Set(forageAssignments.map((entry) => entry.actorId));
      const party = record.context.snapshot.roster
        .filter(
          (entry) =>
            entry.consumes &&
            (record.kind !== "forage" || wanted.has(entry.actorId)),
        )
        .map((entry) => actors().get(entry.actorId));
      return resolveTargets(party, {
        allowGmRolls: record.kind === "forage",
        forageAssignments,
        waterEnabled: config.waterEnabled,
      }).map((target, index) => ({
        promptId: `${record.runId}:p${index}`,
        actorId: target.actor.id,
        userId: target.userId || record.initiator.userId,
        forageTarget: target.forageTarget,
        dc: record.environment.dc,
        foodDc: record.environment.foodDc,
        waterDc: record.environment.waterDc,
        assignedAt,
        deadlineAt:
          assignedAt +
          Math.max(0, Number(config.forageTimeoutSeconds ?? 120)) * 1000,
      }));
    },
    buildPromptPayload(record, assignment) {
      return {
        day: record.day,
        actorName: actors()?.get?.(assignment.actorId)?.name ?? "Character",
        environment: publicForageEnvironment(record.environment, {
          waterEnabled: record.context.snapshot.config.waterEnabled !== false,
        }),
      };
    },
    normalizePromptResponse(record, payload) {
      const assignment = record.prompts.assignments.find(
        (entry) =>
          entry.promptId === payload.promptId &&
          entry.actorId === payload.actorId &&
          entry.userId === payload.originUserId,
      );
      const actor = actors()?.get?.(payload.actorId);
      const user = globalThis.game?.users?.get?.(payload.originUserId);
      if (
        !assignment ||
        !actor ||
        !user?.active ||
        (!isFullGM(user) && actor.testUserPermission?.(user, "OWNER") !== true)
      )
        throw new Error(
          "Forage result no longer belongs to the prompted owner",
        );
      const rollTotal = Number(payload.rollTotal);
      if (
        !Number.isInteger(rollTotal) ||
        rollTotal < -50 ||
        rollTotal > 100 ||
        (payload.skipped === true && rollTotal !== 0)
      )
        throw new Error("Invalid forage total");
      return {
        promptId: assignment.promptId,
        actorId: assignment.actorId,
        userId: assignment.userId,
        rollTotal,
        wisMod: getWisMod(actor),
        skipped: payload.skipped === true,
        receivedAt: now(),
      };
    },
    async preparePlan(record) {
      preflight(record);
      const { config, supplyCredits, environment } = record.context.snapshot;
      const perForager = [];
      for (const assignment of record.prompts.assignments) {
        const response = record.prompts.responses.find(
          (entry) => entry.promptId === assignment.promptId,
        );
        const channels = forageTargetChannels(assignment.forageTarget);
        const result =
          response && !response.skipped
            ? computeForageYield({
                rollTotal: response.rollTotal,
                wisMod: response.wisMod,
                env: environment,
                foodDie: channels.food
                  ? await yieldDie(environment.yieldFood)
                  : 0,
                waterDie:
                  channels.water && config.waterEnabled !== false
                    ? await yieldDie(environment.yieldWater)
                    : 0,
                foodEnabled: channels.food,
                waterEnabled: channels.water && config.waterEnabled !== false,
              })
            : {
                food: 0,
                water: 0,
                foodSuccess: false,
                waterSuccess: false,
                success: false,
              };
        perForager.push({
          actorId: assignment.actorId,
          forageTarget: assignment.forageTarget,
          ...result,
          rollTotal: response?.rollTotal ?? null,
          wisMod: response?.wisMod ?? null,
        });
      }
      const yields = combineYields(perForager, config.forageMode).map(
        (entry) => ({
          actorId: entry.actorId,
          forageTarget: entry.forageTarget,
          rollTotal: entry.rollTotal,
          wisMod: entry.wisMod,
          food: entry.food,
          water: entry.water,
          foodSuccess: entry.foodSuccess,
          waterSuccess: entry.waterSuccess,
          suppressedFood: entry.foodSuppressed === true,
          suppressedWater: entry.waterSuppressed === true,
        }),
      );
      preflight(record);
      return {
        yields,
        inventory: {
          roster: inventoryRoster(record),
          resources: selectedResources(record),
          days: record.days,
          halfRations: config.halfRations,
          supplyCredits,
          waterEnabled: config.waterEnabled,
          partyStashId: config.partyStashId,
          includeConsumption: record.kind === "upkeep",
          resolveTemplate,
          forage: yields.length
            ? {
                foraged: yields.map((entry) => ({
                  ...entry,
                  success: entry.foodSuccess || entry.waterSuccess,
                })),
                selectedIds: yields.map((entry) => entry.actorId),
                forageTargets: Object.fromEntries(
                  yields.map((entry) => [entry.actorId, entry.forageTarget]),
                ),
              }
            : null,
        },
      };
    },
    buildTerminalArtifacts(record) {
      const { config, supplyCredits, roster, environment, forageAssignments } =
        record.context.snapshot;
      const resources = selectedResources(record);
      const summary = summarizeResourceInventoryPlan({
        record,
        roster,
        resources,
        halfRations: config.halfRations,
        supplyCredits,
        waterEnabled: config.waterEnabled,
      });
      const perForager = record.yields.map((entry) => ({
        ...entry,
        name:
          roster.find((member) => member.actorId === entry.actorId)?.name ??
          "Character",
        attempted: true,
        success: entry.foodSuccess || entry.waterSuccess,
        suppressed: entry.suppressedFood || entry.suppressedWater,
      }));
      const result = {
        runId: record.runId,
        trigger: record.trigger,
        day: record.day,
        days: record.days,
        ranAt: now(),
        environmentId: environment.id,
        resourceSnapshot: resources.map(({ id, label, scope }) => ({
          id,
          label,
          scope,
        })),
        ...structuredClone(summary.accounting),
        supplyCredits: summary.supplyCredits,
        status: "complete",
        hasErrors: false,
      };
      result.suggestions = suggestExhaustion({
        days: record.days,
        shortfalls: result.perActor.map((row) => ({
          actorId: row.actorId,
          name: row.name,
          food: row.canonicalShortfalls.food,
          water: row.canonicalShortfalls.water,
        })),
      });
      for (const row of result.perActor) {
        const forage = perForager.find(
          (entry) => entry.actorId === row.actorId,
        );
        row.foraged = forage
          ? { ...forage, attempted: true }
          : { attempted: false };
      }
      const destination = config.partyStashId
        ? {
            mode: "party-stash",
            actorId: config.partyStashId,
            name:
              roster.find((entry) => entry.actorId === config.partyStashId)
                ?.name ?? "Party stash",
          }
        : {
            mode: "draw-sources",
            actorId: null,
            name: "Each forager's draw source",
          };
      const forageOptions = {
        runId: record.runId,
        day: record.day,
        environment,
        env: environment,
        stashActor: config.partyStashId
          ? actors()?.get?.(config.partyStashId)
          : null,
        perForager,
        forageTarget:
          aggregateForageAssignments(forageAssignments).target ?? "food-water",
        forageAssignments,
        forageMode: config.forageMode,
        destination,
        totalFood: summary.forage.food,
        totalWater: summary.forage.water,
      };
      const receipt =
        record.kind === "forage"
          ? buildForageRunReceipt(forageOptions)
          : buildUpkeepRunReceipt({ result, environment });
      const whisper =
        record.kind === "forage"
          ? Array.from(globalThis.game?.users ?? [])
              .filter(isFullGM)
              .map((user) => user.id)
          : (resolveReportWhisper(result) ?? []);
      return {
        report: result,
        result,
        receipt,
        persistResult: record.kind === "upkeep",
        chat: {
          content:
            record.kind === "forage"
              ? buildForageDriveReportContent(forageOptions)
              : buildUpkeepReportContent({
                  env: environment,
                  result,
                  resources,
                }),
          speaker: { alias: "Quartermaster" },
          whisper,
        },
      };
    },
  };
  const coordinator = createResourceOperationCoordinator({
    store,
    domain,
    currentGuard: () => store.currentGuard(),
    emitPrompt,
    now,
    deliveryBindings,
  });
  return {
    coordinator,
    domain,
    async start({
      kind = "upkeep",
      manual = false,
      day = null,
      days = 1,
      resourceIds = null,
      skipForaging = false,
      environment = null,
      forageAssignments = [],
    } = {}) {
      const live = readContext();
      if (!live.roster.some((member) => member.consumes))
        throw new Error("No consuming characters are configured");
      const env =
        environment ??
        findEnvironment(live.config.environments, live.environmentId);
      if (!env) throw new Error("Select a valid supply environment");
      if (
        resourceIds !== null &&
        (!resourceIds.length ||
          resourceIds.some(
            (id) =>
              !live.config.resources.some((resource) => resource.id === id),
          ))
      )
        throw new Error("Invalid supply selection");
      const runId = `supplies-${now()}-${Math.random().toString(36).slice(2, 10)}`;
      const context = createResourceOperationContext({
        ...live,
        environment: env,
        resourceIds,
        forageAssignments,
        forageEnabled: !skipForaging && !manual && env.forageable !== false,
      });
      const input = {
        operationId: runId,
        runId,
        kind,
        trigger: kind === "forage" ? "forage" : manual ? "manual" : "calendar",
        day,
        days,
        context,
        environment: {
          id: env.id,
          label: env.label,
          dc: env.dc,
          foodDc: env.foodDc ?? env.dc,
          waterDc: env.waterDc ?? env.dc,
        },
        initiator: {
          userId: globalThis.game?.user?.id,
          name: globalThis.game?.user?.name ?? "GM",
        },
        actors: live.roster.map((member) => ({
          actorId: member.actorId,
          name: member.name,
          role: member.consumes ? "participant-inventory" : "inventory",
          forageTarget:
            context.snapshot.forageEnabled && member.consumes
              ? (forageAssignments.find(
                  (entry) => entry.actorId === member.actorId,
                )?.forageTarget ??
                (kind === "upkeep"
                  ? live.config.waterEnabled === false
                    ? "food"
                    : "food-water"
                  : null))
              : null,
        })),
        createdAt: now(),
      };
      preflight(input);
      return coordinator.startOperation(input);
    },
  };
}

function runtime() {
  return (singleton ??= createResourceOperationRuntime());
}

export async function startDurableResourceRun(options) {
  const result = await runtime().start(options);
  await scheduleResourceRecovery();
  emitResourceEvent(RESOURCE_EVENTS.STATE_UPDATE, { reason: "upkeep" });
  return result;
}

export async function recoverDurableResources() {
  if (!resourceOperationMode() || !isAuthoritativeGM()) return;
  const result = await runtime().coordinator.recover();
  await scheduleResourceRecovery();
  emitResourceEvent(RESOURCE_EVENTS.STATE_UPDATE, { reason: "upkeep" });
  return result;
}

export async function routeDurableResourceEvent(type, payload) {
  if (!resourceOperationMode() || !isAuthoritativeGM()) return false;
  const coordinator = runtime().coordinator;
  if (type === RESOURCE_EVENTS.FORAGE_RESULT)
    await coordinator.acceptPromptResult(payload);
  if (type === RESOURCE_EVENTS.PROMPT_SYNC_REQUEST)
    await coordinator.syncPlayerPrompt(payload);
  if (type === RESOURCE_EVENTS.ACK_DELIVERY_CONFIRM)
    await coordinator.confirmPromptDelivery(payload);
  await scheduleResourceRecovery();
  emitResourceEvent(RESOURCE_EVENTS.STATE_UPDATE, { reason: "upkeep" });
  return true;
}

async function scheduleResourceRecovery() {
  if (timer) clearTimeout(timer);
  timer = null;
  const active =
    await createResourceOperationStoreV5Adapter().loadActiveResourceOperation();
  if (!active || active.phase !== "prompting") return;
  const resolved = new Set(
    [...active.prompts.responses, ...active.prompts.timeouts].map(
      (entry) => entry.promptId,
    ),
  );
  const deadlines = active.prompts.assignments
    .filter((entry) => !resolved.has(entry.promptId))
    .map((entry) => entry.deadlineAt);
  if (!deadlines.length) return;
  timer = setTimeout(
    () => {
      void recoverDurableResources().catch((error) =>
        console.warn("infinity-dnd5e | supply recovery stopped", error),
      );
    },
    Math.max(0, Math.min(...deadlines) - Date.now()),
  );
}
