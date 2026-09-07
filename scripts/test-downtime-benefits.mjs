import assert from "node:assert/strict";
import {
  buildDowntimeBenefitPlan,
  applyDowntimeBenefit,
  inspectDowntimeBenefit,
} from "./downtime/benefits.js";
import { DOWNTIME_BENEFITS } from "./downtime/benefit-rules.js";
import {
  downtimeCareTargets,
  planDowntimeCare,
} from "./injury/downtime-care.js";
import {
  buildCriticalInjuryEffectData,
  getCriticalInjuryData,
} from "./injury/effects.js";
import { scheduleCriticalInjuryNote } from "./injury/calendar.js";
import {
  defaultGuidedDowntimeTemplates,
  includeCampaignDowntimeTemplates,
  normalizeGuidedDowntimeTemplate,
  projectGuidedDowntimeTemplate,
} from "./downtime/dispatch.js";
import { normalizeDowntimeConfig } from "./downtime/settlements.js";
import {
  loadDowntimeConfig,
  resetDowntimeWorkflowStoreForTests,
} from "./downtime/store.js";

const moduleId = "infinity-dnd5e";
const clone = (value) => structuredClone(value);
const authorized = { authorizeWrite: () => true };
const settings = new Map();
globalThis.game = {
  time: { worldTime: 1000 },
  actors: new Map(),
  users: new Map([["player", { id: "player", isGM: false, role: 1 }]]),
  modules: new Map(
    ["dae", "midi-qol", "times-up"].map((id) => [id, { active: true }]),
  ),
  settings: { get: (_module, key) => settings.get(key) },
};
globalThis.CONST = {
  ACTIVE_EFFECT_MODES: { MULTIPLY: 1, ADD: 2, OVERRIDE: 5 },
};

function actor(id) {
  const a = {
    id,
    uuid: `Actor.${id}`,
    name: id,
    type: "character",
    ownership: { player: 3 },
    flags: {},
    effects: { contents: [] },
    writes: 0,
    getFlag(namespace, key) {
      return this.flags[namespace]?.[key];
    },
    async update(changes) {
      this.writes++;
      for (const [key, value] of Object.entries(changes)) {
        const parts = key.split(".");
        let object = this;
        for (const part of parts.slice(0, -1)) object = object[part] ??= {};
        object[parts.at(-1)] = clone(value);
      }
      if (this.receiptResponseLost) throw new Error("receipt response lost");
    },
    async createEmbeddedDocuments(type, rows, options) {
      assert.equal(type, "ActiveEffect");
      assert.equal(options.keepId, true);
      if (this.createFails) throw new Error("create failed");
      const result = rows.map((row) => this.add(row));
      if (this.createResponseLost) throw new Error("create response lost");
      return result;
    },
    async deleteEmbeddedDocuments(type, ids) {
      assert.equal(type, "ActiveEffect");
      this.writes++;
      this.effects.contents = this.effects.contents.filter(
        (effect) => !ids.includes(effect.id),
      );
    },
    add(row) {
      this.writes++;
      const effect = {
        id: row._id,
        ...clone(row),
        getFlag(namespace, key) {
          return this.flags[namespace]?.[key];
        },
        toObject() {
          const {
            id: _id,
            getFlag: _get,
            toObject: _toObject,
            update: _update,
            ...data
          } = this;
          return clone(data);
        },
        async update(changes) {
          a.writes++;
          Object.assign(this, clone(changes));
          if (a.effectResponseLost) throw new Error("effect response lost");
        },
      };
      this.effects.contents.push(effect);
      return effect;
    },
  };
  game.actors.set(id, a);
  return a;
}
function operation(a, type = "sparring", extra = {}) {
  const operationId = extra.operationId ?? `op-${a.id}`;
  return {
    actorId: a.id,
    operationId,
    benefit: buildDowntimeBenefitPlan({
      actor: a,
      benefit: type,
      hours: 8,
      ...extra,
      operationId,
    }),
  };
}
function injury(a, extra = {}) {
  return a.add({
    _id: `effect-${a.id}`,
    ...buildCriticalInjuryEffectData(
      {
        id: `injury-${a.id}`,
        actorId: a.id,
        injuryKey: "test-injury",
        injuryName: "Bruised ribs",
        effect: "Rest until recovered",
        recoveryRule: "Rest",
        remainingDays: 4,
        permanent: false,
        recoveryDueTs: game.time.worldTime + 4 * 86400,
        ...extra,
      },
      { startTime: game.time.worldTime },
    ),
  });
}

// Existing libraries gain the campaign activities without replacing saved prose or recipes.
const defaults = defaultGuidedDowntimeTemplates();
assert.equal(defaults.length, 26);
assert.equal(
  defaults.find((row) => row.work?.output === "arrows").work.batchHours,
  8,
);
const training = defaults.find((row) => row.id === "guided-training");
assert.equal(training.outcomes[2].benefit, "sparring");
assert.equal(
  defaults.find((row) => row.id === "guided-focused-study").outcomes[2].benefit,
  "focused-study",
);
assert.equal(
  defaults.find((row) => row.id === "guided-trail-conditioning").outcomes[2]
    .benefit,
  "trail-ready",
);
assert.equal(
  defaults.find((row) => row.id === "guided-seek-blessing").outcomes[2].benefit,
  "blessed-resolve",
);
assert.equal(
  defaults.find((row) => row.id === "guided-defensive-drills").outcomes[2]
    .benefit,
  "guarded-drills",
);
assert.deepEqual(
  DOWNTIME_BENEFITS.map(({ id }) => id),
  [
    "",
    "sparring",
    "focused-study",
    "blessed-resolve",
    "guarded-drills",
    "trail-ready",
    "injury-care",
  ],
);
const previousTraining = clone(training);
previousTraining.description =
  "Practice footwork, endurance, or technique with a willing partner or instructor. Instruction costs 1 gp per workday. The GM records progress; this does not automatically grant proficiency or combat bonuses.";
assert.equal(
  includeCampaignDowntimeTemplates([previousTraining])[0].description,
  training.description,
);
previousTraining.description = "A custom campaign training rule.";
assert.equal(
  includeCampaignDowntimeTemplates([previousTraining])[0].description,
  previousTraining.description,
);
assert.equal(
  Object.hasOwn(projectGuidedDowntimeTemplate(training), "outcomes"),
  false,
);
assert.throws(
  () =>
    normalizeGuidedDowntimeTemplate({
      ...training,
      outcomes: training.outcomes.map((row) => ({
        ...row,
        benefit: "run-arbitrary-macro",
      })),
    }),
  /benefit/i,
);
const custom = clone(training);
custom.id = "my-sparring";
custom.name = "Train and Spar";
delete custom.outcomes[2].benefit;
custom.outcomes[2].report = "Keep my campaign report";
const upgraded = includeCampaignDowntimeTemplates([custom]);
assert.equal(upgraded.length, 17);
assert.equal(upgraded[0].outcomes[2].report, "Keep my campaign report");
assert.equal(upgraded[0].outcomes[2].benefit, "sparring");
custom.outcomes[2].benefit = "";
assert.equal(
  includeCampaignDowntimeTemplates([custom])[0].outcomes[2].benefit,
  "",
);
const oldConfig = normalizeDowntimeConfig({
  guidedTemplates: Array.from({ length: 24 }, (_, i) => ({
    ...defaults[0],
    id: `custom-${i}`,
    name: `Custom ${i}`,
  })),
});
oldConfig.guidedTemplates = oldConfig.guidedTemplates.map((template) => {
  const { blockHours: _blockHours, ...historicalTemplate } = template;
  return historicalTemplate;
});
oldConfig.guidedProjects = oldConfig.guidedProjects.map((project) => {
  const { blockHours: _blockHours, ...historicalProject } = project;
  return historicalProject;
});
oldConfig.version = 6;
settings.set("downtimeConfig", clone(oldConfig));
resetDowntimeWorkflowStoreForTests();
const migrated = loadDowntimeConfig();
assert.equal(migrated.version, 11);
assert.equal(migrated.guidedTemplates.length, 41);
assert.deepEqual(
  migrated.guidedTemplates.slice(0, 24).map((template) => {
    const { blockHours: _blockHours, ...historicalTemplate } = template;
    return historicalTemplate;
  }),
  oldConfig.guidedTemplates,
);
assert.ok(
  migrated.guidedTemplates
    .slice(0, 24)
    .every(({ blockHours }) => blockHours === 8),
);
assert.deepEqual(
  settings.get("downtimeConfig"),
  oldConfig,
  "loading migration does not rewrite the old record",
);

const fighter = actor("fighter");
const spar = operation(fighter);
assert.equal(inspectDowntimeBenefit(fighter, spar), "unapplied");
const first = await applyDowntimeBenefit(fighter, spar, authorized);
assert.equal(first.ok, true, first.reason);
const buff = fighter.effects.contents[0];
assert.equal(buff.duration.seconds, 43200);
assert.equal(buff.duration.startTime, 87400);
assert.deepEqual(buff.flags[moduleId].downtimeBenefit.timing, {
  grantedAt: 1000,
  startsAt: 87400,
  expiresAt: 130600,
  durationSeconds: 43200,
  productiveDays: 1,
  productiveHoursPerDay: 8,
});
assert.deepEqual(buff.flags.dae.specialDuration, ["1Attack"]);
assert.deepEqual(
  buff.changes.map((row) => row.key),
  ["mwak", "rwak", "msak", "rsak"].map(
    (kind) => `system.bonuses.${kind}.attack`,
  ),
);
assert.ok(buff.changes.every((row) => row.value === "1" && row.mode === 2));

for (const [type, expectedKey, expectedValue] of [
  ["focused-study", "system.bonuses.abilities.check", "1"],
  ["blessed-resolve", "system.bonuses.abilities.save", "1"],
  ["guarded-drills", "system.attributes.ac.bonus", "1"],
  ["trail-ready", "system.attributes.movement.walk", "5"],
]) {
  const recipient = actor(`recipient-${type}`);
  const benefitOperation = operation(recipient, type, {
    operationId: `operation-${type}`,
    blockHours: 40,
  });
  assert.equal(
    (await applyDowntimeBenefit(recipient, benefitOperation, authorized)).ok,
    true,
  );
  const effect = recipient.effects.contents[0];
  assert.equal(effect.duration.startTime, 433000);
  assert.equal(effect.duration.seconds, 28800);
  assert.equal(effect.flags[moduleId].downtimeBenefit.timing.productiveDays, 5);
  assert.deepEqual(effect.flags.dae.specialDuration, []);
  assert.equal(effect.changes[0].key, expectedKey);
  assert.equal(effect.changes[0].value, expectedValue);
}
assert.equal(
  operation(fighter, "sparring", { operationId: "second-block" }).benefit.type,
  "none",
);
fighter.effects.contents = []; // Midi consumed it, or Times Up expired it.
const writes = fighter.writes;
assert.equal(
  (await applyDowntimeBenefit(fighter, spar, authorized)).alreadyApplied,
  true,
);
assert.equal(
  fighter.writes,
  writes,
  "recovery never recreates a consumed bonus",
);

const raceActor = actor("race");
const reviewed = operation(raceActor);
await applyDowntimeBenefit(
  raceActor,
  operation(raceActor, "sparring", { operationId: "another-block" }),
  authorized,
);
assert.equal(
  inspectDowntimeBenefit(raceActor, reviewed),
  "uncertain",
  "a new bonus after review blocks stacking",
);
assert.equal(
  (await applyDowntimeBenefit(raceActor, reviewed, authorized)).ok,
  false,
);
assert.equal(raceActor.effects.contents.length, 1);

const interrupted = actor("interrupted");
interrupted.createResponseLost = true;
interrupted.receiptResponseLost = true;
assert.equal(
  (await applyDowntimeBenefit(interrupted, operation(interrupted), authorized))
    .ok,
  true,
  "readback handles lost responses",
);
assert.equal(interrupted.effects.contents.length, 1);
const failed = actor("failed");
failed.createFails = true;
const uncertain = operation(failed);
assert.equal(
  (await applyDowntimeBenefit(failed, uncertain, authorized)).ok,
  false,
);
failed.createFails = false;
assert.equal(
  (await applyDowntimeBenefit(failed, uncertain, authorized)).ok,
  false,
  "an interrupted receipt cannot prove an absent bonus was never consumed",
);
assert.equal(failed.effects.contents.length, 0);
const denied = actor("denied");
assert.equal(
  (
    await applyDowntimeBenefit(denied, operation(denied), {
      authorizeWrite: () => false,
    })
  ).ok,
  false,
);
assert.equal(denied.writes, 0);
game.modules.get("midi-qol").active = false;
const noMidi = actor("no-midi");
assert.equal(
  (await applyDowntimeBenefit(noMidi, operation(noMidi), authorized)).ok,
  false,
);
assert.equal(noMidi.writes, 0);
const daeOnlyBenefit = actor("dae-only-benefit");
assert.equal(
  (
    await applyDowntimeBenefit(
      daeOnlyBenefit,
      operation(daeOnlyBenefit, "focused-study"),
      authorized,
    )
  ).ok,
  true,
  "a timed DAE modifier does not require Midi QOL when it has no roll expiry",
);
game.modules.get("midi-qol").active = true;
game.modules.get("dae").active = false;
const noDae = actor("no-dae");
assert.equal(
  (
    await applyDowntimeBenefit(
      noDae,
      operation(noDae, "focused-study"),
      authorized,
    )
  ).ok,
  false,
);
assert.equal(noDae.writes, 0);
game.modules.get("dae").active = true;

const healer = actor("healer");
const patient = actor("patient");
const wound = injury(patient);
const target = `${patient.id}|${getCriticalInjuryData(wound).id}`;
assert.equal(
  operation(healer, "injury-care", { hours: 7, target }).benefit.type,
  "none",
);
assert.equal(operation(healer, "injury-care").benefit.needsTarget, true);
assert.ok(downtimeCareTargets().some((row) => row.id === target));
const care = operation(healer, "injury-care", { target });
patient.effectResponseLost = true;
const treated = await applyDowntimeBenefit(healer, care, authorized);
assert.equal(treated.ok, true, treated.reason);
assert.equal(getCriticalInjuryData(wound).remainingDays, 3);
assert.equal(getCriticalInjuryData(wound).recoveryDueTs, 1000 + 3 * 86400);
assert.equal(patient.effects.contents.length, 1);
const patientWrites = patient.writes;
assert.equal(
  (await applyDowntimeBenefit(healer, care, authorized)).alreadyApplied,
  true,
);
assert.equal(patient.writes, patientWrites);
assert.ok(
  !JSON.stringify(healer.flags).includes("effectBefore"),
  "private injury snapshots never enter player-readable receipts",
);
for (const extra of [
  { permanent: true },
  { canBecomePermanent: true, stabilized: false },
  { recoveryDueTs: 900 },
]) {
  const excluded = actor(`excluded-${game.actors.size}`);
  const effect = injury(excluded, extra);
  assert.throws(
    () =>
      planDowntimeCare(
        `${excluded.id}|${getCriticalInjuryData(effect).id}`,
        "invalid",
      ),
    /timed injury/,
  );
}
const stalePatient = actor("stale-patient");
const unowned = actor("unowned");
unowned.ownership = {};
const unownedInjury = injury(unowned);
assert.ok(!downtimeCareTargets().some((row) => row.id.startsWith("unowned|")));
assert.throws(
  () =>
    planDowntimeCare(
      `unowned|${getCriticalInjuryData(unownedInjury).id}`,
      "unowned-op",
    ),
  /timed injury/,
);
const staleWound = injury(stalePatient);
const staleCare = operation(healer, "injury-care", {
  operationId: "stale-op",
  target: `${stalePatient.id}|${getCriticalInjuryData(staleWound).id}`,
});
staleWound.disabled = true;
assert.equal(inspectDowntimeBenefit(healer, staleCare), "uncertain");
assert.equal(
  (await applyDowntimeBenefit(healer, staleCare, authorized)).ok,
  false,
);

// A custom calendar day and an interrupted calendar write are reconciled once.
const notes = [];
let noteSerial = 0;
let failNote = false;
let failRemoval = false;
const calendarApi = {
  NoteRepeat: { Never: 0 },
  timestamp: () => game.time.worldTime,
  getCurrentCalendar: () => ({
    time: { hoursInDay: 10, minutesInHour: 10, secondsInMinute: 1 },
  }),
  timestampPlusInterval: (timestamp, interval) =>
    timestamp + interval.day * 100,
  timestampToDate: (timestamp) => ({
    year: 1492,
    month: 1,
    day: Math.floor(timestamp / 100),
    hour: 0,
    minute: 0,
    seconds: 0,
  }),
  getNotes: () => notes,
  async addNote(...args) {
    if (failNote) throw new Error("calendar unavailable");
    const note = {
      id: `note-${++noteSerial}`,
      pages: { contents: [{ text: { content: args[1] } }] },
      name: args[0],
      flags: {
        "foundryvtt-simple-calendar-reborn": {
          noteData: { startDate: args[2], endDate: args[3], allDay: args[4] },
        },
      },
      async update(patch) {
        for (const [path, value] of Object.entries(patch)) {
          const keys = path.split(".");
          const key = keys.pop();
          let target = this;
          for (const part of keys) target = target[part] ??= {};
          target[key] = clone(value);
        }
      },
    };
    notes.push(note);
    return note;
  },
  async removeNote(id) {
    if (failRemoval) return false;
    const index = notes.findIndex((note) => note.id === id);
    if (index >= 0) notes.splice(index, 1);
    return true;
  },
};
game.modules.set("foundryvtt-simple-calendar-reborn", {
  active: true,
  api: calendarApi,
});
globalThis.SimpleCalendar = { api: calendarApi };
const calendarBenefitActor = actor("calendar-benefit");
const calendarBenefit = operation(calendarBenefitActor, "focused-study", {
  operationId: "calendar-benefit-op",
  blockHours: 16,
});
assert.equal(
  (
    await applyDowntimeBenefit(
      calendarBenefitActor,
      calendarBenefit,
      authorized,
    )
  ).ok,
  true,
);
assert.equal(calendarBenefitActor.effects.contents[0].duration.startTime, 1200);
assert.equal(calendarBenefitActor.effects.contents[0].duration.seconds, 80);
assert.equal(
  calendarBenefitActor.effects.contents[0].flags[moduleId].downtimeBenefit
    .timing.expiresAt,
  1280,
);
const calendarPatient = actor("calendar-patient");
const calendarWound = injury(calendarPatient, {
  recoveryDueTs: 1400,
  remainingDays: 8,
  stabilized: true,
});
const initial = await scheduleCriticalInjuryNote({
  actor: calendarPatient,
  injury: getCriticalInjuryData(calendarWound),
});
getCriticalInjuryData(calendarWound).calendarEntryId = initial.entryId;
const calendarCare = operation(healer, "injury-care", {
  operationId: "calendar-op",
  target: `${calendarPatient.id}|${getCriticalInjuryData(calendarWound).id}`,
});
failNote = true;
assert.equal(
  (await applyDowntimeBenefit(healer, calendarCare, authorized)).ok,
  false,
);
assert.equal(getCriticalInjuryData(calendarWound).recoveryDueTs, 1300);
failNote = false;
failRemoval = true;
assert.equal(
  (await applyDowntimeBenefit(healer, calendarCare, authorized)).ok,
  false,
);
assert.equal(notes.length, 2, "unverified removal keeps the operation pending");
failRemoval = false;
const recovered = await applyDowntimeBenefit(healer, calendarCare, authorized);
assert.equal(recovered.ok, true, recovered.reason);
assert.equal(
  getCriticalInjuryData(calendarWound).remainingDays,
  6,
  "stabilized injury retains its double recovery rate",
);
assert.equal(notes.length, 1);
assert.notEqual(notes[0].id, initial.entryId);
assert.equal(getCriticalInjuryData(calendarWound).calendarEntryId, notes[0].id);
assert.equal(
  (await applyDowntimeBenefit(healer, calendarCare, authorized)).alreadyApplied,
  true,
);
assert.equal(notes.length, 1);

const nearRecovery = actor("near-recovery");
const nearWound = injury(nearRecovery, {
  recoveryDueTs: 1050,
  remainingDays: 1,
});
const nearNote = await scheduleCriticalInjuryNote({
  actor: nearRecovery,
  injury: getCriticalInjuryData(nearWound),
});
getCriticalInjuryData(nearWound).calendarEntryId = nearNote.entryId;
const finish = operation(healer, "injury-care", {
  operationId: "finish-op",
  target: `${nearRecovery.id}|${getCriticalInjuryData(nearWound).id}`,
});
assert.equal((await applyDowntimeBenefit(healer, finish, authorized)).ok, true);
assert.equal(
  nearRecovery.effects.contents.length,
  0,
  "care can complete the last recovery day",
);
const completedNote = notes.find((note) => note.id === nearNote.entryId);
assert.ok(completedNote, "completed care keeps the original calendar event");
assert.match(completedNote.name, /\(Recovered\)$/);
assert.equal(
  completedNote.flags[moduleId].criticalInjuryCalendar.completedAtTs,
  1000,
);
assert.equal(
  (await applyDowntimeBenefit(healer, finish, authorized)).alreadyApplied,
  true,
);

console.log(
  "Downtime benefits: defaults, migration, expiry contract, recovery, care, calendar and authority passed",
);
