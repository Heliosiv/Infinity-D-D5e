import assert from "node:assert/strict";

import {
  addInjuryCalendarDays,
  getRemainingInjuryCalendarDays,
  scheduleCriticalInjuryNote,
} from "./injury/calendar.js";

const calls = [];
globalThis.game = {
  modules: new Map([["foundryvtt-simple-calendar", { active: true }]]),
  time: { worldTime: 1000 },
};
globalThis.SimpleCalendar = {
  api: {
    NoteRepeat: { Never: 0 },
    timestamp: () => 1000,
    timestampPlusInterval: (timestamp, interval) =>
      timestamp + Number(interval.day ?? 0) * 100,
    timestampToDate: (timestamp) => ({
      year: 1492,
      month: 7,
      day: Math.floor(Number(timestamp) / 100),
      hour: 0,
      minute: 0,
      seconds: 0,
    }),
    async addNote(...args) {
      calls.push(["add", args]);
      return { id: "note-new" };
    },
    async removeNote(id) {
      calls.push(["remove", id]);
      return true;
    },
  },
};

assert.equal(addInjuryCalendarDays(1000, 4), 1400);
assert.equal(getRemainingInjuryCalendarDays(1350, 1000), 4);
assert.equal(getRemainingInjuryCalendarDays(1000, 1000), 0);

const result = await scheduleCriticalInjuryNote({
  actor: { id: "actor-1", name: "Aric" },
  injury: {
    injuryName: "Shattered Knee",
    effect: "Speed is halved.",
    recoveryRule: "One week or treatment.",
    remainingDays: 7,
    recoveryDueTs: 1700,
    permanent: false,
  },
  existingEntryId: "note-old",
});

assert.deepEqual(result, {
  scheduled: true,
  entryId: "note-new",
  reason: "",
});
assert.equal(calls[0][0], "add", "replacement note is created first");
assert.deepEqual(
  calls[0][1][9],
  ["default"],
  "calendar note is player-visible",
);
assert.deepEqual(calls[1], ["remove", "note-old"]);

delete globalThis.SimpleCalendar;
delete globalThis.game;

process.stdout.write("critical injury calendar validation passed\n");
