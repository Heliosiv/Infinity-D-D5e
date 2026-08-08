import assert from "node:assert/strict";

import {
  addInjuryCalendarDays,
  getRemainingInjuryCalendarDays,
  removeCriticalInjuryNote,
  scheduleCriticalInjuryNote,
} from "./injury/calendar.js";

const calls = [];
const notes = [];
let throwAfterAdd = false;
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
    getNotes() {
      calls.push(["get"]);
      return notes;
    },
    async addNote(...args) {
      calls.push(["add", args]);
      const note = {
        id: `note-${notes.length + 1}`,
        pages: { contents: [{ text: { content: args[1] } }] },
      };
      notes.push(note);
      if (throwAfterAdd) {
        throwAfterAdd = false;
        throw new Error("simulated response loss after note commit");
      }
      return note;
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

const actor = { id: "actor-1", name: "Aric" };
const injury = {
  id: "injury-1",
  pendingId: "pending-1",
  injuryName: "Shattered Knee",
  effect: "Speed is halved.",
  recoveryRule: "One week or treatment.",
  remainingDays: 7,
  recoveryDueTs: 1700,
  permanent: false,
};

const created = await scheduleCriticalInjuryNote({ actor, injury });

assert.deepEqual(created, {
  scheduled: true,
  entryId: "note-1",
  created: true,
  reused: false,
  previousEntryId: "",
  reason: "",
});
assert.equal(
  calls.filter(([type]) => type === "add").length,
  1,
  "the first request creates one note",
);

// Simulate the caller being interrupted after Simple Calendar committed the
// note but before the returned entry ID could be persisted on the Actor effect.
const reused = await scheduleCriticalInjuryNote({ actor, injury });

assert.deepEqual(reused, {
  scheduled: true,
  entryId: "note-1",
  created: false,
  reused: true,
  previousEntryId: "",
  reason: "",
});
assert.equal(
  calls.filter(([type]) => type === "add").length,
  1,
  "retry reuses the marker-matched note instead of creating a duplicate",
);

const interruptedInjury = {
  ...injury,
  id: "injury-interrupted",
  pendingId: "pending-interrupted",
};
throwAfterAdd = true;
const recoveredAfterThrow = await scheduleCriticalInjuryNote({
  actor,
  injury: interruptedInjury,
});
assert.deepEqual(recoveredAfterThrow, {
  scheduled: true,
  entryId: "note-2",
  created: false,
  reused: true,
  previousEntryId: "",
  reason: "",
});
assert.equal(
  notes.filter((note) => note.id === "note-2").length,
  1,
  "an add-note response failure reuses the note that was already committed",
);

const result = await scheduleCriticalInjuryNote({
  actor,
  injury,
  existingEntryId: "note-old",
  verifiedReplacement: true,
});

assert.deepEqual(result, {
  scheduled: true,
  entryId: "note-3",
  created: true,
  reused: false,
  previousEntryId: "note-old",
  reason: "",
});
const replacementAddIndex = calls.findLastIndex(
  ([type, args]) => type === "add" && args[0].includes("Shattered Knee"),
);
assert.equal(
  calls.some(([type, id]) => type === "remove" && id === "note-old"),
  false,
  "the caller must persist the replacement ID before deleting the old note",
);
assert.deepEqual(
  calls[replacementAddIndex][1][9],
  ["default"],
  "calendar note is player-visible",
);
notes.push({ id: "note-old", pages: structuredClone(notes[2].pages) });
assert.equal(
  await removeCriticalInjuryNote("note-old", {
    actor,
    injury: interruptedInjury,
  }),
  false,
  "a mismatched injury marker cannot delete the supplied calendar note",
);
assert.equal(
  await removeCriticalInjuryNote("note-old", { actor, injury }),
  true,
  "the exact marker-matched old note can be removed after persistence",
);
const oldNoteRemovalIndex = calls.findIndex(
  ([type, id]) => type === "remove" && id === "note-old",
);
assert.ok(
  replacementAddIndex >= 0 && replacementAddIndex < oldNoteRemovalIndex,
  "replacement persistence precedes verified old-note cleanup",
);
assert.deepEqual(calls[oldNoteRemovalIndex], ["remove", "note-old"]);

delete globalThis.SimpleCalendar;
delete globalThis.game;

process.stdout.write("critical injury calendar validation passed\n");
