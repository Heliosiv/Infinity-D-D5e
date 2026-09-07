import assert from "node:assert/strict";
import {
  scheduleCriticalInjuryNote,
  synchronizeCriticalInjuryNoteRange,
} from "./injury/calendar.js";

const scope = "foundryvtt-simple-calendar-reborn";
const moduleId = "infinity-dnd5e";
const actor = { id: "pc", name: "Aric" };
const injury = {
  id: "wound",
  pendingId: "roll",
  injuryName: "Broken arm",
  recoveryStartTs: 0,
  recoveryDueTs: 400,
  remainingDays: 4,
};
let now = 100,
  writes = 0,
  loseReply = false,
  rejectWrite = false;
const notes = [];
const api = {
  timestamp: () => now,
  timestampToDate: (ts) => ({
    year: 1,
    month: Math.floor(ts / 300),
    day: Math.floor(ts / 100) % 3,
    hour: 2,
    minute: 3,
    second: 4,
  }),
  getNotes: () => notes,
  async addNote(name, content, startDate, endDate, allDay) {
    const note = {
      id: `note-${notes.length}`,
      name,
      content,
      ownership: { default: 2 },
      flags: {
        [scope]: {
          noteData: {
            startDate,
            endDate,
            allDay,
            calendarId: "custom-calendar",
            categories: ["Injuries"],
          },
        },
      },
      async update(patch) {
        if (rejectWrite) throw new Error("offline");
        writes++;
        for (const [path, value] of Object.entries(patch)) {
          const keys = path.split(".");
          const key = keys.pop();
          let target = this;
          for (const part of keys) target = target[part] ??= {};
          target[key] = structuredClone(value);
        }
        if (loseReply) throw new Error("response lost after save");
      },
    };
    notes.push(note);
    return note;
  },
};
globalThis.game = {
  modules: new Map([[scope, { active: true, api }]]),
  time: { worldTime: now },
};
const created = await scheduleCriticalInjuryNote({ actor, injury });
injury.calendarEntryId = created.entryId;
const note = notes[0];
const data = note.flags[scope].noteData;
assert.equal(
  data.startDate.day,
  0,
  "world timestamp zero is a valid original start",
);
assert.equal(
  data.endDate.month,
  1,
  "an interval can cross custom calendar months",
);
assert.equal(
  data.endDate.seconds,
  4,
  "DateData.second is converted to DateTimeParts.seconds",
);
const sync = (extra = {}) =>
  synchronizeCriticalInjuryNoteRange({
    actor,
    injury,
    authorizeWrite: () => true,
    ...extra,
  });
assert.equal(await sync(), true);
assert.equal(writes, 0, "unchanged ranges create no writes");
now = 200;
injury.recoveryDueTs = 300;
assert.equal(await sync({ authorizeWrite: () => false }), false);
assert.equal(writes, 0, "authority is required before modifying a note");
assert.equal(await sync(), true);
assert.equal(data.startDate.day, 0, "healing never moves the original start");
assert.equal(data.endDate.day, 0);
assert.equal(data.endDate.month, 1);
assert.equal(note.flags[scope].noteData.calendarId, "custom-calendar");
assert.deepEqual(note.ownership, { default: 2 });
assert.deepEqual(data.categories, ["Injuries"]);
injury.recoveryDueTs = 500;
rejectWrite = true;
assert.equal(
  await sync(),
  false,
  "an unsaved update is not reported as synchronized",
);
rejectWrite = false;
loseReply = true;
assert.equal(
  await sync(),
  true,
  "read-back recovers a saved update with a lost reply",
);
loseReply = false;
rejectWrite = true;
assert.equal(await sync({ completed: true, completionTimestamp: 200 }), false);
rejectWrite = false;
now = 300;
assert.equal(
  await sync({ completed: true, completionTimestamp: 200 }),
  true,
  "a delayed completion retry uses the saved healing time",
);
assert.equal(note.name, "Aric — Broken arm (Recovered)");
assert.equal(
  data.endDate.day,
  2,
  "early healing ends the event at healing time",
);
const completedWrites = writes;
now = 900;
assert.equal(await sync({ completed: true }), true);
assert.equal(
  writes,
  completedWrites,
  "a completion retry never extends a recovered event",
);
assert.equal(notes.length, 1, "range synchronization keeps the same event");
note.content = "An unrelated calendar entry";
assert.equal(
  await sync(),
  false,
  "a reused ID without the injury marker is never changed",
);
assert.equal(writes, completedWrites);
note.content = "An unrelated calendar entry";
assert.equal(
  await sync({ completed: true }),
  false,
  "completion also refuses an unrelated note with the same ID",
);
assert.equal(
  await sync({
    injury: { ...injury, calendarEntryId: "deleted-note" },
    completed: true,
  }),
  true,
  "an already deleted note does not prevent recovery",
);
const manual = {
  ...injury,
  id: "manual",
  calendarEntryId: "",
  recoveryDueTs: 1200,
};
manual.calendarEntryId = (
  await scheduleCriticalInjuryNote({ actor, injury: manual })
).entryId;
assert.equal(
  await sync({ injury: manual, completed: true, recovered: false }),
  true,
);
assert.match(
  notes.at(-1).name,
  /\(Ended\)$/,
  "manual removal is not represented as confirmed healing",
);
assert.equal(
  await sync({ injury: { ...injury, calendarEntryId: "" }, completed: true }),
  true,
  "healing without a calendar link is allowed",
);
console.log(
  "Injury calendar ranges: original date, custom months, dynamic end, completed history, permissions, and replay passed",
);
