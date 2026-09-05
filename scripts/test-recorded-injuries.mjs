import assert from "node:assert/strict";
import {
  createRecordedInjuryApi,
  normalizeRecordedInjury,
  getRecordedInjuryRows,
} from "./injury/recorded-injuries.js";
import { createHash, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import Handlebars from "handlebars";
globalThis.crypto ??= webcrypto;
const clone = (v) => structuredClone(v);
const sanitizeJournalHtml = (html) => html.replace(/<!--[\s\S]*?-->/g, "");
const hash = async (v) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const aid = "abcdefghijklmnop";
const eid = "ponmlkjihgfedcba";
function fixture() {
  let clock = 1000,
    fullGM = true,
    authority = true,
    assigned = true,
    failure = "";
  let writes = 0;
  const docs = new Map();
  const actor = {
    id: aid,
    uuid: `Actor.${aid}`,
    name: "Patient",
    type: "character",
    flags: {},
    effects: [],
    system: { hp: 12 },
    toObject() {
      return clone({
        _id: this.id,
        flags: this.flags,
        system: this.system,
        effects: this.effects.map((e) => e.toObject()),
      });
    },
    async update(changes) {
      writes++;
      if (failure === "actor") throw new Error("lost actor response");
      for (const [path, v] of Object.entries(changes)) {
        const keys = path.split(".");
        let o = this;
        for (const k of keys.slice(0, -1)) o = o[k] ??= {};
        o[keys.at(-1)] = clone(v);
      }
    },
  };
  const effect = {
    uuid: `${actor.uuid}.ActiveEffect.${eid}`,
    name: "Old scar",
    description: "Existing scar",
    documentName: "ActiveEffect",
    parent: actor,
    disabled: false,
    toObject() {
      return { name: this.name, description: this.description, changes: [] };
    },
  };
  actor.effects.push(effect);
  docs.set(actor.uuid, actor);
  docs.set(effect.uuid, effect);
  const journal = [];
  const calendar = {
    id: "default",
    name: "Campaign",
    months: [{ name: "Shadowfall", numberOfDays: 30 }],
  };
  const gm = { id: "gm", role: 4 };
  const game = {
    user: gm,
    users: [gm, { id: "player", role: 1, character: aid }],
    actors: [actor],
    journal,
    messages: [],
    modules: new Map([["infinity-dnd5e", { version: "test" }]]),
  };
  const addNote = async (
    title,
    content,
    start,
    end,
    allDay,
    repeats,
    cats,
    cid,
  ) => {
    writes++;
    const id = String(journal.length + 1).padStart(16, "0");
    const p = {
      type: "text",
      text: { content: sanitizeJournalHtml(content) },
      toObject() {
        return { text: clone(this.text) };
      },
      async update(c) {
        writes++;
        this.text.content = sanitizeJournalHtml(c["text.content"]);
      },
    };
    const n = {
      uuid: `JournalEntry.${id}`,
      name: title,
      pages: [p],
      flags: {
        "foundryvtt-simple-calendar-reborn": {
          noteData: {
            calendarId: cid,
            startDate: clone(start),
            endDate: clone(end),
            allDay,
            repeats,
            macro: "none",
          },
        },
      },
      toObject() {
        return {
          name: this.name,
          flags: clone(this.flags),
          pages: [p.toObject()],
        };
      },
    };
    journal.push(n);
    docs.set(n.uuid, n);
    if (failure === "calendar-response") {
      failure = "";
      throw new Error("lost calendar response");
    }
    return n;
  };
  const api = createRecordedInjuryApi({
    game: () => game,
    fromUuid: async (u) => docs.get(u),
    isFullGM: () => fullGM,
    canWrite: () => authority,
    isAssigned: () => assigned,
    calendar: () => ({ getCurrentCalendar: () => calendar, addNote }),
    hash,
    now: () => clock,
  });
  const input = {
    actorUuid: actor.uuid,
    sourceUuid: effect.uuid,
    label: "Heavy scarring",
    status: "permanent",
    notes: "Existing penalty preserved.",
    date: { year: 53, month: 0, day: 20 },
    dateMeaning: "recorded",
    reason: "Reconcile existing injury.",
  };
  return {
    api,
    input,
    actor,
    effect,
    game,
    journal,
    addNote,
    setFailure: (v) => (failure = v),
    setFull: (v) => (fullGM = v),
    setAuthority: (v) => (authority = v),
    setAssigned: (v) => (assigned = v),
    advance: () => (clock += 600001),
    get writes() {
      return writes;
    },
  };
}
for (const patch of [
  { actorUuid: "Actor.wrong" },
  { sourceUuid: "Actor.1111111111111111.ActiveEffect.2222222222222222" },
  { label: "<script>alert(1)</script>" },
  { status: "rolling" },
  { date: { year: 53, month: 0, day: -1 } },
  { dateMeaning: "recovery" },
  { ownership: { default: 3 } },
])
  assert.throws(() =>
    normalizeRecordedInjury({ ...fixture().input, ...patch }),
  );
{
  const f = fixture();
  const original = f.actor.toObject();
  const p = await f.api.preview(f.input);
  assert.equal(f.writes, 0);
  const result = await f.api.apply(p);
  assert.equal(result.ok, true);
  assert.equal(f.journal.length, 1);
  assert.equal(getRecordedInjuryRows(f.actor).length, 1);
  assert.deepEqual(f.actor.toObject().system, original.system);
  assert.deepEqual(f.actor.toObject().effects, original.effects);
  const count = f.writes;
  assert.equal((await f.api.apply(p)).replayed, true);
  assert.equal(f.writes, count);
  const second = await f.api.preview(f.input);
  await f.api.apply(second);
  assert.equal(f.journal.length, 1);
  assert.equal(getRecordedInjuryRows(f.actor).length, 1);
  assert.match(result.calendar.content, /original injury date is unknown/);
}
for (const mutation of [
  (f) => f.actor.system.hp++,
  (f) => f.advance(),
  (f) => (f.game.user = { id: "other", role: 4 }),
  (f) => f.setFull(false),
  (f) => f.setAuthority(false),
  (f) => f.setAssigned(false),
]) {
  const f = fixture();
  const p = await f.api.preview(f.input);
  mutation(f);
  await assert.rejects(f.api.apply(p));
  assert.equal(f.writes, 0);
}
{
  const f = fixture();
  f.setFailure("calendar-response");
  const p = await f.api.preview(f.input);
  await assert.rejects(f.api.apply(p), (e) => e.partialWritePossible === true);
  const retry = await f.api.preview(f.input);
  await f.api.apply(retry);
  assert.equal(f.journal.length, 1);
}
{
  const f = fixture();
  f.setFailure("actor");
  const p = await f.api.preview(f.input);
  await assert.rejects(f.api.apply(p));
  assert.equal(f.journal.length, 1);
  f.setFailure("");
  await f.api.apply(await f.api.preview(f.input));
  assert.equal(f.journal.length, 1);
}
{
  const f = fixture();
  const date = { year: 53, month: 0, day: 23 };
  const note = await f.addNote(
    "Existing recovery",
    "<p>Original</p>",
    date,
    date,
    true,
    0,
    [],
    "default",
  );
  const input = {
    ...f.input,
    date: undefined,
    calendarUuid: note.uuid,
    status: "active",
    dateMeaning: "recovery",
  };
  const before = clone(note.flags);
  const p = await f.api.preview(input);
  f.game.users.push({ id: "late", active: true, name: "Late player" }); // membership changes are guarded
  await assert.rejects(f.api.apply(p));
  const p2 = await f.api.preview(input);
  f.game.users.at(-1).active = false;
  await f.api.apply(p2);
  assert.deepEqual(note.flags, before);
  assert.match(note.pages[0].text.content, /Original/);
  assert.equal(f.journal.length, 1);
}
{
  const f = fixture();
  const date = { year: 53, month: 0, day: 23 };
  const note = await f.addNote(
    "Existing recovery",
    "<section>Original</section>",
    date,
    date,
    true,
    0,
    [],
    "default",
  );
  const input = {
    ...f.input,
    date: undefined,
    calendarUuid: note.uuid,
    status: "active",
    dateMeaning: "recovery",
  };
  const first = await f.api.preview(input);
  // Reproduce the real partial write: Foundry retained visible content but removed old comments.
  note.pages[0].text.content = first.proposed.calendarContent.replace(
    / data-infinity-recorded-injury="[^"]+"/,
    "",
  );
  const recovered = await f.api.apply(await f.api.preview(input));
  assert.equal(f.journal.length, 1);
  assert.equal(
    recovered.calendar.content.split("<h2>Injury record:").length - 1,
    1,
  );
  assert.match(recovered.calendar.content, /data-infinity-recorded-injury=/);
  assert.ok(
    recovered.calendar.content.startsWith("<section>Original</section>"),
  );
  await f.api.apply(
    await f.api.preview({ ...input, notes: "Updated recovery note." }),
  );
  assert.equal(
    note.pages[0].text.content.split("<h2>Injury record:").length - 1,
    1,
  );
  assert.match(note.pages[0].text.content, /Updated recovery note/);
}
console.log(
  "Recorded injury transactions: authority, input bounds, preview, concurrency, replay, partial-write recovery, date preservation, and unchanged mechanics passed.",
);

{
  const f = fixture();
  await f.api.apply(await f.api.preview(f.input));
  const html = Handlebars.compile(
    readFileSync(
      new URL("../templates/critical-injury-triage.hbs", import.meta.url),
      "utf8",
    ),
  )({
    canMutate: true,
    hasPlayerCharacters: true,
    partyRows: [
      {
        name: "Patient",
        recordedInjuries: getRecordedInjuryRows(f.actor),
        injuries: [],
      },
    ],
  });
  assert.match(html, /Recorded injuries and history/);
  assert.match(html, /Heavy scarring/);
  assert.match(html, /Shadowfall 21, 53/);
  f.journal[0].pages[0].text.content = "Edited outside the injury API";
  await assert.rejects(f.api.preview(f.input), /LinkedCalendarMarkerChanged/);
  f.setFull(false);
  await assert.rejects(f.api.read(), /FullGMRequired/);
}
