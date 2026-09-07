import assert from "node:assert/strict";
const gm = { id: "gm", role: 4, isGM: true, active: true };
const player = { id: "player", role: 1, isGM: false, character: "actor" };
const users = [gm, player];
users.contents = users;
users.activeGM = gm;
users.get = (id) => users.find((user) => user.id === id);
const settings = new Map();
const injury = {
  id: "injury",
  pendingId: "pending",
  injuryName: "Bruised ribs",
  injuryRoll: 12,
  effect: "Painful movement",
  recoveryDueTs: 1800,
  remainingDays: 8,
  permanent: false,
  calendarEntryId: "",
};
let effectWrites = 0;
const effect = {
  id: "effect0000000001",
  flags: { "infinity-dnd5e": { criticalInjury: injury } },
  async update(patch) {
    effectWrites++;
    assert.deepEqual(Object.keys(patch), [
      "flags.infinity-dnd5e.criticalInjury.calendarEntryId",
    ]);
    injury.calendarEntryId =
      patch["flags.infinity-dnd5e.criticalInjury.calendarEntryId"];
  },
};
const actor = {
  id: "actor",
  type: "character",
  name: "Aric",
  ownership: { player: 3 },
  effects: { contents: [effect] },
};
globalThis.game = {
  ready: false,
  user: gm,
  users,
  time: { worldTime: 1000, serverTime: 1000 },
  actors: { contents: [actor], get: (id) => (id === actor.id ? actor : null) },
  modules: new Map(),
  settings: {
    get: (_module, key) => settings.get(key),
    set: async (_module, key, value) => {
      settings.set(key, structuredClone(value));
      return value;
    },
  },
};
globalThis.CONST = { USER_ROLES: { GAMEMASTER: 4 } };
const store = await import("./injury/workflow-store.js");
await store.createCriticalInjuryApproval({
  pendingId: "pending",
  actorId: "actor",
  targetUserId: "player",
});
await store.claimCriticalInjuryApplication("pending", {
  id: "lease",
  claimedBy: "gm",
});
await store.persistCriticalInjuryResolution(
  "pending",
  {
    injuryId: "injury",
    effectDocumentId: effect.id,
    injuryKey: "bruised-ribs",
    injuryRoll: 12,
    tableVersion: 2,
    recoveryFormula: "1d8",
    recoveryDays: 8,
    detailTotal: null,
    recoveryStartTs: 900,
    recoveryDueTs: 1800,
    requestedBy: "player",
    resolvedBy: "gm",
    resolvedAt: 1000,
  },
  { applicationLeaseId: "lease" },
);
await store.completeCriticalInjuryWorkflow("pending", {
  result: { ...injury },
  effectId: effect.id,
  applicationLeaseId: "lease",
});
const notes = [];
let afterAdd = null;
let additions = 0;
let calendarWrites = 0;
let afterCalendarUpdate = null;
let rejectCalendarUpdate = false;
const api = {
  timestamp: () => 1000,
  timestampToDate: (timestamp) => ({ year: 1, month: 0, day: timestamp / 100 }),
  getNotes: () => notes,
  removeNote: async (id) => {
    const index = notes.findIndex((note) => note.id === id);
    if (index >= 0) notes.splice(index, 1);
    return true;
  },
  async addNote(_title, content, start, end) {
    assert.equal(start.day, 9, "repair preserves the original injury date");
    assert.equal(end.day, 18);
    const note = {
      id: `note-${++additions}`,
      content,
      flags: {
        "foundryvtt-simple-calendar-reborn": {
          noteData: { startDate: start, endDate: end, allDay: true },
        },
      },
      async update(patch) {
        if (rejectCalendarUpdate) throw new Error("calendar unavailable");
        calendarWrites++;
        for (const [path, value] of Object.entries(patch)) {
          const keys = path.split(".");
          const key = keys.pop();
          let target = this;
          for (const part of keys) target = target[part] ??= {};
          target[key] = value;
        }
        afterCalendarUpdate?.();
      },
    };
    notes.push(note);
    afterAdd?.();
    return note;
  },
};
game.modules.set("foundryvtt-simple-calendar-reborn", { active: true, api });
const { syncCriticalInjuryCalendar } =
  await import("./injury/calendar-sync.js");
const { getCriticalInjuryLogRows } = await import("./injury/injury-log.js");
assert.equal(getCriticalInjuryLogRows().length, 1);
assert.equal(getCriticalInjuryLogRows()[0].status, "Active");
const left = syncCriticalInjuryCalendar();
const right = syncCriticalInjuryCalendar();
assert.equal(left, right, "double clicks share one repair run");
assert.deepEqual(await left, { linked: 1, skipped: 0, failed: 0 });
assert.equal(injury.calendarEntryId, "note-1");
assert.equal(effectWrites, 1);
injury.recoveryDueTs = 1700;
assert.deepEqual(await syncCriticalInjuryCalendar(), {
  linked: 0,
  skipped: 0,
  failed: 0,
});
assert.equal(
  notes[0].flags["foundryvtt-simple-calendar-reborn"].noteData.endDate.day,
  17,
  "linked events follow changed recovery dates",
);
assert.equal(
  notes[0].flags["foundryvtt-simple-calendar-reborn"].noteData.startDate.day,
  9,
);
assert.equal(calendarWrites, 1);
await syncCriticalInjuryCalendar();
assert.equal(
  calendarWrites,
  1,
  "repeated synchronization leaves unchanged events alone",
);
injury.recoveryDueTs = 1800;
await syncCriticalInjuryCalendar();
assert.equal(calendarWrites, 2, "longer recovery also extends the same event");
injury.recoveryDueTs = 1500;
afterCalendarUpdate = () => {
  afterCalendarUpdate = null;
  injury.recoveryDueTs = 1700;
  void syncCriticalInjuryCalendar();
};
await syncCriticalInjuryCalendar();
assert.equal(
  notes[0].flags["foundryvtt-simple-calendar-reborn"].noteData.endDate.day,
  17,
  "an update during synchronization receives a follow-up pass",
);
injury.recoveryDueTs = 1800;
await syncCriticalInjuryCalendar();
assert.equal(additions, 1, "repeated sync adds no duplicates");
assert.equal(effectWrites, 1);
injury.calendarEntryId = "";
await syncCriticalInjuryCalendar();
assert.equal(additions, 1, "lost effect link reuses the saved note");
notes.length = 0;
await syncCriticalInjuryCalendar();
assert.equal(
  injury.calendarEntryId,
  "note-2",
  "a deleted calendar entry is repaired",
);
const before = effectWrites;
notes.length = 0;
afterAdd = () => {
  injury.remainingDays = 4;
};
assert.equal((await syncCriticalInjuryCalendar()).skipped, 1);
assert.equal(
  effectWrites,
  before,
  "concurrent injury change is never overwritten",
);
afterAdd = null;
const savedNotes = api.getNotes;
api.getNotes = () => {
  throw new Error("offline");
};
await assert.rejects(syncCriticalInjuryCalendar(), /could not be read/);
assert.equal(effectWrites, before);
api.getNotes = savedNotes;
game.user = player;
await assert.rejects(syncCriticalInjuryCalendar(), /active GM/);
assert.deepEqual(
  getCriticalInjuryLogRows(),
  [],
  "private injury history is never projected to players",
);
game.user = gm;
actor.effects.contents = [];
assert.equal(
  getCriticalInjuryLogRows()[0].status,
  "No longer active",
  "saved injury log survives effect removal",
);
store.resetCriticalInjuryWorkflowStoreForTests();
assert.equal(
  getCriticalInjuryLogRows().length,
  1,
  "log survives a store reload",
);
actor.effects.contents = [effect];
actor.uuid = "Actor.aaaaaaaaaaaaaaaa";
actor.flags = {
  "infinity-dnd5e": {
    recordedInjuries: {
      old: {
        schema: 1,
        actorUuid: actor.uuid,
        id: "old",
        label: "Old scar",
        status: "permanent",
        notes: "Original injury date unknown",
      },
      healed: {
        schema: 1,
        actorUuid: actor.uuid,
        id: "healed",
        label: "Healed wound",
        status: "recovered",
      },
    },
  },
};
const historicalRows = getCriticalInjuryLogRows();
assert.equal(
  historicalRows.length,
  3,
  "recorded and automated history both remain visible",
);
assert.equal(
  historicalRows.find((row) => row.name === "Old scar").roll,
  undefined,
  "a historical record never fabricates a roll",
);
assert.equal(
  historicalRows.find((row) => row.name === "Healed wound").status,
  "Recovered",
);
game.user = player;
assert.deepEqual(
  getCriticalInjuryLogRows(),
  [],
  "merged history remains GM-private",
);
game.user = gm;
injury.pendingId = "forged";
assert.equal(
  (await syncCriticalInjuryCalendar()).skipped,
  1,
  "owner-writable flags cannot authorize calendar repair",
);
console.log("injury calendar repair and saved log checks passed");

injury.pendingId = "pending";
await syncCriticalInjuryCalendar();
const expiryNote = notes.find((note) => note.id === injury.calendarEntryId);
effect.delete = async () => {
  actor.effects.contents = [];
};
api.timestamp = () => 1900;
game.time.worldTime = 1900;
const { processExpiredCriticalInjuries } = await import("./injury/service.js");
rejectCalendarUpdate = true;
await processExpiredCriticalInjuries();
assert.equal(
  actor.effects.contents.length,
  1,
  "calendar failure leaves automatic recovery retryable",
);
rejectCalendarUpdate = false;
await processExpiredCriticalInjuries();
assert.equal(actor.effects.contents.length, 0);
assert.equal(
  expiryNote.flags["foundryvtt-simple-calendar-reborn"].noteData.endDate.day,
  18,
  "late expiry processing retains the actual due date",
);
assert.match(expiryNote.name, /\(Recovered\)$/);
assert.ok(
  notes.includes(expiryNote),
  "automatic recovery retains its completed interval",
);
console.log(
  "Automatic injury expiry saves its completed event before removing penalties",
);
