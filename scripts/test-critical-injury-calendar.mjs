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
      return structuredClone(notes);
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
      const index = notes.findIndex((note) => note.id === id);
      if (index < 0) return false;
      notes.splice(index, 1);
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

const treatmentInjury = {
  ...injury,
  id: "injury-treatment",
  pendingId: "pending-treatment",
};
const treatmentAddsBefore = calls.filter(([type]) => type === "add").length;
const [concurrentLeft, concurrentRight] = await Promise.all([
  scheduleCriticalInjuryNote({
    actor,
    injury: treatmentInjury,
    existingEntryId: "note-treatment-old",
    verifiedReplacement: true,
    operationId: "treatment-concurrent",
  }),
  scheduleCriticalInjuryNote({
    actor,
    injury: treatmentInjury,
    existingEntryId: "note-treatment-old",
    verifiedReplacement: true,
    operationId: "treatment-concurrent",
  }),
]);
assert.equal(
  calls.filter(([type]) => type === "add").length - treatmentAddsBefore,
  2,
  "concurrent authorities can both reach Simple Calendar before reconciliation",
);
assert.equal(concurrentLeft.scheduled, true);
assert.equal(concurrentRight.scheduled, true);
assert.equal(
  concurrentLeft.entryId,
  concurrentRight.entryId,
  "both authorities converge on the same deterministic calendar entry",
);
const concurrentContent = notes.find(
  (note) => note.id === concurrentLeft.entryId,
)?.pages?.contents?.[0]?.text?.content;
assert.match(concurrentContent, /critical-injury%3Av1/);
assert.match(concurrentContent, /critical-injury-treatment%3Av1/);
assert.equal(
  notes.filter((note) =>
    note.pages?.contents?.some((page) =>
      page.text?.content?.includes("treatment-concurrent"),
    ),
  ).length,
  1,
  "marker-identical concurrent notes are reconciled to one survivor",
);

const canonicalTreatmentNote = notes.find(
  (note) => note.id === concurrentLeft.entryId,
);
notes.push({
  id: "zz-treatment-duplicate",
  pages: structuredClone(canonicalTreatmentNote.pages),
});
notes.push({
  id: "unrelated-operation-marker-only",
  pages: {
    contents: [
      {
        text: {
          content:
            canonicalTreatmentNote.pages.contents[0].text.content.replace(
              /<p><small>Infinity D&amp;D5e recovery tracking:.*?<\/small><\/p>/,
              "",
            ),
        },
      },
    ],
  },
});
const reconciledDuplicate = await scheduleCriticalInjuryNote({
  actor,
  injury: treatmentInjury,
  existingEntryId: "note-treatment-old",
  verifiedReplacement: true,
  operationId: "treatment-concurrent",
});
assert.equal(reconciledDuplicate.entryId, concurrentLeft.entryId);
assert.equal(
  notes.some((note) => note.id === "zz-treatment-duplicate"),
  false,
  "an exact duplicate carrying both markers is removed",
);
assert.equal(
  notes.some((note) => note.id === "unrelated-operation-marker-only"),
  true,
  "a note without the matching base injury marker is never removed",
);

notes.push({
  id: "zz-treatment-removal-uncertain",
  pages: structuredClone(canonicalTreatmentNote.pages),
});
const verifiedRemoveNote = globalThis.SimpleCalendar.api.removeNote;
globalThis.SimpleCalendar.api.removeNote = async (id) => {
  calls.push(["remove-uncertain", id]);
  throw new Error("simulated uncertain duplicate removal");
};
const uncertainRemoval = await scheduleCriticalInjuryNote({
  actor,
  injury: treatmentInjury,
  existingEntryId: "note-treatment-old",
  verifiedReplacement: true,
  operationId: "treatment-concurrent",
});
assert.equal(uncertainRemoval.scheduled, false);
assert.match(uncertainRemoval.reason, /removal-unverified/);
assert.equal(
  notes.some((note) => note.id === "zz-treatment-removal-uncertain"),
  true,
  "an unverified removal fails closed without claiming one note is canonical",
);
globalThis.SimpleCalendar.api.removeNote = verifiedRemoveNote;
const verifiedCleanup = await scheduleCriticalInjuryNote({
  actor,
  injury: treatmentInjury,
  existingEntryId: "note-treatment-old",
  verifiedReplacement: true,
  operationId: "treatment-concurrent",
});
assert.equal(verifiedCleanup.scheduled, true);
assert.equal(
  notes.some((note) => note.id === "zz-treatment-removal-uncertain"),
  false,
  "a later verified pass safely removes the exact duplicate",
);

const interruptedTreatmentInjury = {
  ...injury,
  id: "injury-treatment-interrupted",
  pendingId: "pending-treatment-interrupted",
};
throwAfterAdd = true;
const recoveredTreatmentAfterThrow = await scheduleCriticalInjuryNote({
  actor,
  injury: interruptedTreatmentInjury,
  existingEntryId: "note-treatment-interrupted-old",
  verifiedReplacement: true,
  operationId: "treatment-interrupted",
});
assert.equal(recoveredTreatmentAfterThrow.scheduled, true);
assert.equal(recoveredTreatmentAfterThrow.reused, true);
assert.equal(
  notes.filter((note) =>
    note.pages?.contents?.some((page) =>
      page.text?.content?.includes("treatment-interrupted"),
    ),
  ).length,
  1,
  "an apply-then-throw treatment add is recovered and reconciled",
);

const result = await scheduleCriticalInjuryNote({
  actor,
  injury,
  existingEntryId: "note-old",
  verifiedReplacement: true,
});

assert.deepEqual(result, {
  scheduled: true,
  entryId: result.entryId,
  created: true,
  reused: false,
  previousEntryId: "note-old",
  reason: "",
});
assert.match(result.entryId, /^note-\d+$/);
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
notes.push({
  id: "note-old",
  pages: structuredClone(
    notes.find((note) => note.id === result.entryId).pages,
  ),
});
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
