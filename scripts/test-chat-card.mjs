import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  buildInfinityChatCard,
  describeChatAudience,
  markTrustedChatHtml,
} from "./chat-card.js";
import { postTransactionReceipt } from "./merchant/transaction.js";
import {
  buildForageDriveReportContent,
  buildUpkeepReportContent,
} from "./resource/calendar-watcher.js";

const malicious = `<img src=x onerror="alert('x')">`;
const plainCard = buildInfinityChatCard({
  title: malicious,
  outcome: malicious,
  audience: malicious,
  details: malicious,
  nextAction: malicious,
  tone: "not-a-tone",
  classes: ["kept-class", `bad\" onclick=\"alert(1)`],
});
assert.match(plainCard, /data-tone="neutral"/);
assert.match(plainCard, /kept-class/);
assert.doesNotMatch(plainCard, /onclick=/);
assert.doesNotMatch(plainCard, /<img/);
assert.ok(
  plainCard.match(/&lt;img/g)?.length >= 5,
  "all plain-text fields are escaped",
);
for (const label of ["Outcome", "Audience", "Details", "Next action"]) {
  assert.match(plainCard, new RegExp(`aria-label="${label}"`));
}

const trustedCard = buildInfinityChatCard({
  details: markTrustedChatHtml("<ul><li>Already sanitized</li></ul>"),
});
assert.match(trustedCard, /<ul><li>Already sanitized<\/li><\/ul>/);

assert.equal(describeChatAudience("public"), "Visible to everyone in chat.");
assert.equal(
  describeChatAudience("whisper-gm-buyer"),
  "Visible to GMs and the character's controlling player.",
);
assert.equal(
  describeChatAudience("owner-gm"),
  "Visible to the character's owner and full GMs.",
);

const forageCard = buildForageDriveReportContent({
  env: { dc: 12 },
  perForager: [
    {
      actorId: "actor-a",
      name: malicious,
      attempted: true,
      success: true,
      food: 2,
      water: 1,
    },
  ],
  stashActor: null,
  totalFood: 2,
  totalWater: 1,
});
assert.match(forageCard, /infinity-chat-card/);
assert.match(forageCard, /Forage Drive — DC 12/);
assert.match(forageCard, /Next action/);
assert.doesNotMatch(forageCard, /<img/);

const mixedForageCard = buildForageDriveReportContent({
  env: { dc: 15, foodDc: 10, waterDc: 15 },
  perForager: [
    {
      actorId: "food-forager",
      name: "Foodfinder",
      forageTarget: "food",
      attempted: true,
      success: true,
      foodSuccess: true,
      waterSuccess: false,
      food: 3,
      water: 0,
    },
    {
      actorId: "water-forager",
      name: "Waterfinder",
      forageTarget: "water",
      attempted: true,
      success: true,
      foodSuccess: false,
      waterSuccess: true,
      food: 0,
      water: 4,
    },
  ],
  forageAssignments: [
    { actorId: "food-forager", forageTarget: "food" },
    { actorId: "water-forager", forageTarget: "water" },
  ],
  stashActor: null,
  totalFood: 3,
  totalWater: 4,
});
assert.match(mixedForageCard, /Forage Drive — DC Food 10 \/ Water 15/);
const foodForagerRow = mixedForageCard.match(
  /<li><strong>Foodfinder<\/strong>[\s\S]*?<\/li>/,
)?.[0];
const waterForagerRow = mixedForageCard.match(
  /<li><strong>Waterfinder<\/strong>[\s\S]*?<\/li>/,
)?.[0];
assert.ok(foodForagerRow, "mixed report includes the food forager");
assert.match(foodForagerRow, /food only, DC 10/);
assert.match(foodForagerRow, /gathered \+3 food/);
assert.doesNotMatch(foodForagerRow, /water/);
assert.ok(waterForagerRow, "mixed report includes the water forager");
assert.match(waterForagerRow, /water only, DC 15/);
assert.match(waterForagerRow, /gathered \+4 water/);
assert.doesNotMatch(waterForagerRow, /food/);

const partialForageCard = buildForageDriveReportContent({
  env: { dc: 15, foodDc: 10, waterDc: 15 },
  perForager: [
    {
      actorId: "partial-forager",
      name: "Partial",
      forageTarget: "food-water",
      attempted: true,
      success: true,
      foodSuccess: true,
      waterSuccess: false,
      food: 2,
      water: 0,
    },
  ],
  stashActor: null,
  totalFood: 2,
  totalWater: 0,
});
assert.match(partialForageCard, /gathered \+2 food; found no water/);

const upkeepCard = buildUpkeepReportContent({
  env: { id: "sparse", label: "Sparse" },
  resources: [{ id: "food", label: "Food", scope: "per-character" }],
  result: {
    days: 1,
    perActor: [{ name: malicious, shortfalls: { food: 1 }, errors: [] }],
    party: {},
  },
});
assert.match(upkeepCard, /Daily Supplies — Shortages/);
assert.match(upkeepCard, /aria-label="Audience"/);
assert.doesNotMatch(upkeepCard, /<img/);

const previousGame = globalThis.game;
const previousChatMessage = globalThis.ChatMessage;
try {
  let mode = "whisper-gm-buyer";
  const messages = [];
  const users = [
    { id: "gm", isGM: true },
    { id: "buyer", isGM: false },
    { id: "other", isGM: false },
  ];
  globalThis.game = {
    user: users[1],
    users,
    settings: { get: () => mode },
  };
  globalThis.ChatMessage = {
    getSpeaker: ({ alias }) => ({ alias }),
    async create(data) {
      messages.push(data);
      return data;
    },
  };
  const actor = {
    testUserPermission: (user) => user.id === "buyer",
  };
  const receipt = {
    side: "buy",
    actor,
    merchant: { name: malicious },
    itemName: malicious,
    qty: 2,
    totalGp: 10,
    unitGp: 5,
  };

  await postTransactionReceipt(receipt);
  assert.deepEqual(messages[0].whisper, ["gm", "buyer"]);
  assert.match(messages[0].content, /infinity-merchant-receipt/);
  assert.match(messages[0].content, /aria-label="Next action"/);
  assert.doesNotMatch(messages[0].content, /<img/);

  mode = "whisper-gm";
  await postTransactionReceipt(receipt);
  assert.deepEqual(messages[1].whisper, ["gm"]);

  mode = "public";
  await postTransactionReceipt(receipt);
  assert.equal(
    Object.prototype.hasOwnProperty.call(messages[2], "whisper"),
    false,
    "public receipts still omit the whisper field",
  );
} finally {
  restoreGlobal("game", previousGame);
  restoreGlobal("ChatMessage", previousChatMessage);
}

for (const file of ["app.js", "hoard-loot.js", "per-creature-loot.js"]) {
  const source = await readFile(new URL(file, import.meta.url), "utf8");
  assert.match(source, /buildInfinityChatCard\(/, `${file} uses the contract`);
  assert.match(source, /escapeHtml\(/, `${file} retains its item sanitizers`);
}

const injurySource = await readFile(
  new URL("injury/service.js", import.meta.url),
  "utf8",
);
assert.match(injurySource, /buildInfinityChatCard\(/);
assert.match(
  injurySource,
  /whisper:\s*whisperRecipients\(ownerUserId\)/,
  "injury recipient selection remains in place",
);

const chatCardCss = await readFile(
  new URL("../styles/chat-card.css", import.meta.url),
  "utf8",
);
const moduleManifest = JSON.parse(
  await readFile(new URL("../module.json", import.meta.url), "utf8"),
);
assert.match(chatCardCss, /\.infinity-chat-card__outcome/);
assert.match(chatCardCss, /\.infinity-chat-card__audience/);
assert.match(chatCardCss, /\.infinity-chat-card__details/);
assert.match(chatCardCss, /\.infinity-chat-card__next/);
assert.match(chatCardCss, /@media \(forced-colors: active\)/);
assert.ok(
  moduleManifest.styles.includes("styles/chat-card.css"),
  "the scoped chat styles load directly from the module manifest",
);

function restoreGlobal(key, value) {
  if (value === undefined) delete globalThis[key];
  else globalThis[key] = value;
}

process.stdout.write("chat-card validation passed\n");
