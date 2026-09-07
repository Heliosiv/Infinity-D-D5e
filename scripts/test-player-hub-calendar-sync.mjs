import assert from "node:assert/strict";

import {
  readCalendarLabel,
  syncPlayerHubCalendarLabels,
} from "./player-hub-calendar-sync.js";

const calendarApi = {
  async currentDateTimeDisplay() {
    return {
      date: "Shadowfall 23, 53",
      time: "06:32:15",
      weekday: "3rd",
      yearPostfix: "AAG",
    };
  },
};

assert.equal(
  await readCalendarLabel(calendarApi),
  "Calendar\nShadowfall 23, 53 AAG",
);

const calendarTile = {
  id: "calendar-tile",
  x: 1187,
  y: 1786,
  width: 600,
  height: 220,
  flags: {
    "drakemore-foundry": {
      playerHubControl: { version: 1, key: "calendar" },
    },
  },
};
const calendarDrawing = {
  id: "calendar-drawing",
  x: 1189,
  y: 1780,
  shape: { width: 600, height: 220 },
  text: "Calendar\nShadowfall 21, 53 AAG",
  flags: {
    "drakemore-foundry": {
      playerHubLabel: { version: 1, key: "calendar" },
    },
  },
};
const updates = [];
const hubScene = {
  id: "hub",
  width: 3840,
  height: 2160,
  flags: {
    "drakemore-foundry": {
      playerHub: { kind: "interactive-player-hub", version: 1 },
    },
  },
  tiles: { contents: [calendarTile] },
  drawings: { contents: [calendarDrawing] },
  async updateEmbeddedDocuments(documentName, changes) {
    updates.push({ documentName, changes });
    calendarDrawing.text = changes[0].text;
  },
};
const gameRef = { scenes: { contents: [hubScene] } };

assert.deepEqual(
  await syncPlayerHubCalendarLabels({
    gameRef,
    calendarApi,
    isWriteAuthority: () => true,
  }),
  { updated: 1, unchanged: 0, skipped: 0 },
);
assert.deepEqual(updates, [
  {
    documentName: "Drawing",
    changes: [
      { _id: "calendar-drawing", text: "Calendar\nShadowfall 23, 53 AAG" },
    ],
  },
]);

assert.deepEqual(
  await syncPlayerHubCalendarLabels({
    gameRef,
    calendarApi,
    isWriteAuthority: () => true,
  }),
  { updated: 0, unchanged: 1, skipped: 0 },
  "same-day clock changes do not write the Drawing again",
);
assert.equal(updates.length, 1);

calendarDrawing.text = "Calendar\nShadowfall 21, 53 AAG";
assert.deepEqual(
  await syncPlayerHubCalendarLabels({
    gameRef,
    calendarApi,
    isWriteAuthority: () => false,
  }),
  { updated: 0, unchanged: 0, skipped: 1 },
  "non-authoritative clients never write scene documents",
);
assert.equal(updates.length, 1);

hubScene.drawings.contents.push({
  id: "unrelated-calendar-drawing",
  x: 1189,
  y: 1780,
  shape: { width: 600, height: 220 },
  text: "Calendar\nUnrelated",
  flags: {
    "drakemore-foundry": {
      playerHubLabel: { version: 1, key: "calendar" },
    },
  },
});
assert.deepEqual(
  await syncPlayerHubCalendarLabels({
    gameRef,
    calendarApi,
    isWriteAuthority: () => true,
  }),
  { updated: 0, unchanged: 0, skipped: 1 },
  "ambiguous scene geometry fails closed",
);
assert.equal(updates.length, 1);

process.stdout.write("player-hub calendar sync validation passed\n");
