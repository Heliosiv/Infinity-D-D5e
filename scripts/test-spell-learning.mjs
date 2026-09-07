import assert from "node:assert/strict";
import {
  quoteGuidedWork,
  buildGuidedWorkPlan,
  applyGuidedWork,
  inspectGuidedWork,
  verifyGuidedWorkBefore,
  guidedWorkPreset,
  projectGuidedWork,
} from "./downtime/work.js";
import {
  learningRates,
  matchingLearnedSpell,
  normalizeSpellLearning,
} from "./downtime/spell-learning.js";
import { planWalletDeltaCp } from "./downtime/items.js";

const clone = structuredClone;
const spell = {
  name: "Web",
  type: "spell",
  system: {
    level: 2,
    school: "con",
    source: { rules: "2024" },
    activities: { cast: { type: "save" } },
  },
  flags: {
    ddbimporter: {
      definitionId: 200,
      id: 999,
      dndbeyond: { characterClassId: 123 },
    },
  },
  effects: [],
};
globalThis.fromUuid = async () => clone(spell);
globalThis.CONFIG = {
  DND5E: { spellPreparationStates: { unprepared: { value: 0 } } },
};
function actor() {
  const a = {
    id: "wizard1",
    name: "Test Wizard",
    flags: { ddbimporter: { dndbeyond: { characterId: "123" } } },
    system: { currency: { gp: 500, sp: 0, cp: 0, ep: 0, pp: 0 } },
    items: new Map(),
    writes: 0,
    async update(changes) {
      this.writes++;
      for (const [key, value] of Object.entries(changes))
        this.system.currency[key.split(".").at(-1)] = value;
      return this;
    },
    async createEmbeddedDocuments(_type, sources) {
      this.writes++;
      return sources.map((s) => this.add(s));
    },
    async deleteEmbeddedDocuments(_type, ids) {
      this.writes++;
      return ids.map((id) => {
        const old = this.items.get(id);
        this.items.delete(id);
        return old;
      });
    },
    add(s) {
      const item = {
        ...clone(s),
        id: s._id,
        toObject() {
          const { id, toObject, update, ...raw } = this;
          return clone(raw);
        },
        async update(changes) {
          a.writes++;
          if (Object.hasOwn(changes, "system.quantity"))
            this.system.quantity = changes["system.quantity"];
          return this;
        },
      };
      this.items.set(item.id, item);
      return item;
    },
  };
  a.add({
    _id: "class",
    name: "Wizard",
    type: "class",
    system: { identifier: "wizard", levels: 3 },
  });
  a.add({
    _id: "book",
    name: "Spellbook",
    type: "loot",
    system: { quantity: 1 },
  });
  return a;
}
const learning = normalizeSpellLearning({
  uuid: "Item.SourceSpell",
  name: "Web",
  level: 2,
  school: "con",
  edition: "2024",
  sourceType: "notes",
  sourceName: "Recovered notes",
  bookName: "Spellbook",
});
const activity = {
  ...guidedWorkPreset("learn-spell"),
  work: { ...guidedWorkPreset("learn-spell").work, learning },
};
const options = (a, extra = {}) => ({
  actor: a,
  activity,
  hours: 4,
  operationId: "learn-operation",
  dateLabel: "Shadowfall 24",
  ...extra,
});
async function plan(a, extra = {}) {
  const opts = options(a, extra);
  const work = await buildGuidedWorkPlan(opts);
  return {
    actorId: a.id,
    operationId: opts.operationId,
    work,
    walletBefore: clone(a.system.currency),
    walletAfter: planWalletDeltaCp(a.system.currency, -work.costCp),
  };
}
const authorized = { authorizeWrite: () => true };
let a = actor();
assert.equal(quoteGuidedWork(options(a)).costCp, 10000);
assert.match(
  projectGuidedWork(a, activity, 1).costLabel,
  /25 gp per study hour; 0\/4h already studied/,
);
assert.doesNotMatch(projectGuidedWork(a, activity, 1).costLabel, /this block/);
assert.equal(quoteGuidedWork(options(a, { hours: 5 })).ok, false);
assert.equal(
  quoteGuidedWork(options(a, { activity: guidedWorkPreset("learn-spell") })).ok,
  false,
);
a.items.delete("book");
assert.match(quoteGuidedWork(options(a)).problems.join(" "), /Carry Spellbook/);
a = actor();
a.items.get("class").system.levels = 2;
assert.match(
  quoteGuidedWork(options(a)).problems.join(" "),
  /Wizard class level/,
);
a = actor();
a.system.currency.gp = 1;
assert.equal(quoteGuidedWork(options(a)).ok, false);
a = actor();
a.add({ _id: "savant", type: "feat", name: "Conjuration Savant", system: {} });
assert.deepEqual(learningRates(a, { ...learning, edition: "2014" }), {
  hours: 2,
  gp: 50,
});
assert.deepEqual(learningRates(a, learning), { hours: 4, gp: 100 });
assert.throws(() => normalizeSpellLearning({ ...learning, level: 0 }), /level/);
assert.throws(
  () =>
    normalizeSpellLearning({ ...learning, uuid: "Actor.private.Item.secret" }),
  /Choose/,
);

a = actor();
const first = await plan(a, { hours: 1 });
assert.equal(first.work.delivery, undefined);
assert.equal((await applyGuidedWork(a, first, authorized)).ok, true);
const last = await plan(a, {
  hours: 3,
  progress: { [first.work.key]: 1 },
  operationId: "last-part",
});
assert.equal(last.work.costCp, 7500);
assert.equal((await applyGuidedWork(a, last, authorized)).ok, true);
assert.equal(a.system.currency.gp, 400);
const learned = a.items.get(last.work.delivery.itemId);
assert.equal(learned.system.prepared, 0);
assert.equal(learned.flags.ddbimporter.ignoreItemImport, true);
assert.equal(learned.flags.ddbimporter.ignoreItemUpdate, true);
assert.equal(learned.flags.ddbimporter.id, undefined);
assert.equal(learned.flags.ddbimporter.dndbeyond, undefined);
assert.equal(
  learned.flags["infinity-dnd5e"].learnedSpell.dateLabel,
  "Shadowfall 24",
);
assert.equal(learned.system.activities.cast.type, "save");
assert.equal(inspectGuidedWork(a, last), "applied");
assert.equal(quoteGuidedWork(options(a)).ok, false);
const writes = a.writes;
await applyGuidedWork(a, last, authorized);
assert.equal(a.writes, writes, "replay never charges or creates twice");
assert.equal(
  matchingLearnedSpell(a, {
    ...spell,
    system: { ...spell.system, source: { rules: "2014" } },
  }).length,
  0,
);

const scrollActivity = {
  ...activity,
  skills: ["arc"],
  work: {
    ...activity.work,
    learning: {
      ...learning,
      sourceType: "scroll",
      sourceName: "Scroll of Web",
    },
  },
};
for (const total of [11, 12]) {
  a = actor();
  a.add({
    _id: "scroll",
    name: "Scroll of Web",
    type: "consumable",
    system: { quantity: 1, type: { value: "scroll" } },
    flags: { dnd5e: { spellLevel: { value: 2 } } },
  });
  const partial = await plan(a, {
    activity: scrollActivity,
    targetId: "scroll",
    hours: 1,
  });
  a.items.get("scroll").system.quantity = 0;
  assert.equal(
    quoteGuidedWork(
      options(a, { activity: scrollActivity, targetId: "scroll", hours: 1 }),
    ).ok,
    false,
  );
  assert.equal(
    verifyGuidedWorkBefore(a, partial),
    false,
    "a spent scroll cannot fund partial study",
  );
  a.items.get("scroll").system.quantity = 1;
  const op = await plan(a, {
    activity: scrollActivity,
    targetId: "scroll",
    checkTotal: total,
  });
  assert.equal(op.work.copyCheck.success, total >= 12);
  assert.equal((await applyGuidedWork(a, op, authorized)).ok, true);
  assert.equal(a.items.get("scroll").system.quantity, 0);
  assert.equal(matchingLearnedSpell(a, spell).length, total >= 12 ? 1 : 0);
  assert.equal(a.system.currency.gp, 400);
  assert.equal(inspectGuidedWork(a, op), "applied");
}
a = actor();
const drift = await plan(a);
a.items.delete("book");
assert.equal(verifyGuidedWorkBefore(a, drift), false);
assert.equal((await applyGuidedWork(a, drift, authorized)).ok, false);
assert.equal(a.system.currency.gp, 500);
a = actor();
const lost = await plan(a);
const create = a.createEmbeddedDocuments;
a.createEmbeddedDocuments = async function (...args) {
  await create.apply(this, args);
  throw new Error("lost reply");
};
assert.equal((await applyGuidedWork(a, lost, authorized)).ok, true);
a = actor();
const rollback = await plan(a);
a.createEmbeddedDocuments = async () => [];
assert.equal(
  (await applyGuidedWork(a, rollback, authorized)).provenUnapplied,
  true,
);
assert.equal(a.system.currency.gp, 500);
console.log(
  "Wizard copying: eligibility, costs, partial work, scroll success/failure, protections, duplicates, drift, rollback and lost replies passed",
);
