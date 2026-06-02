import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { depositToActor } from "./loot/distribute.js";
import { filterCandidates } from "./loot/roller.js";
import { fakeItem } from "./test-utils/fixtures.mjs";

const MODULE_ID = "infinity-dnd5e";
const PACK_ID = `${MODULE_ID}.infinity-dnd5e-items`;
const PACK_PATH = "packs/infinity-dnd5e-items.db";
const SPELL_SCROLL_SCHEMA = "infinity-dnd5e-spell-scroll-v1";

/* ------------------------------------------------------------------ *
 * Source spells are not rollable inventory loot; generated scrolls are.
 * ------------------------------------------------------------------ */
{
  const spell = fakeItem({
    _id: "spell-fireball",
    name: "Fireball",
    type: "spell",
    lootType: "loot.spell",
  });
  const scroll = fakeItem({
    _id: "scroll-fireball",
    name: "Spell Scroll: Fireball",
    type: "consumable",
    lootType: "loot.scroll",
  });

  const candidates = filterCandidates([spell, scroll], {});
  assert.deepEqual(
    candidates.map((item) => item._id),
    ["scroll-fireball"],
    "bare spells are skipped while generated spell scrolls remain rollable",
  );
}

/* ------------------------------------------------------------------ *
 * The shipped pack's untyped "all loot" roll path never emits spells.
 * ------------------------------------------------------------------ */
{
  const packItems = readFileSync(PACK_PATH, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  const allCandidates = filterCandidates(packItems, {});

  assert.equal(
    allCandidates.some(
      (item) =>
        item.type === "spell" ||
        item.flags?.["party-operations"]?.lootType === "loot.spell",
    ),
    false,
    "all-loot rolls must not include bare spell documents",
  );
  assert.ok(
    allCandidates.some((item) => item.name === "Spell Scroll: Fireball"),
    "generated spell scrolls stay available in all-loot rolls",
  );
}

/* ------------------------------------------------------------------ *
 * Deposit converts a raw spell UUID into the matching generated scroll.
 * ------------------------------------------------------------------ */
{
  const spell = fakeItem({
    _id: "spellA",
    name: "Fireball",
    type: "spell",
    lootType: "loot.spell",
  });
  spell.system.level = 3;

  const scroll = {
    _id: "scrollA",
    name: "Spell Scroll: Fireball",
    type: "consumable",
    img: "icons/sundries/scrolls/scroll-bound-gold-brown.webp",
    system: {
      type: { value: "scroll", subtype: "" },
      quantity: 1,
      price: { value: 200, denomination: "gp" },
      uses: { max: "1", recovery: [], spent: 0 },
    },
    flags: {
      [MODULE_ID]: {
        spellScroll: {
          schema: SPELL_SCROLL_SCHEMA,
          sourceSpellId: "spellA",
          sourceSpellName: "Fireball",
          spellLevel: 3,
        },
      },
    },
  };

  const spellUuid = `Compendium.${PACK_ID}.Item.spellA`;
  const createdPayloads = [];
  const actor = {
    name: "Mira",
    system: { currency: {} },
    createEmbeddedDocuments: async (_type, payloads) => {
      createdPayloads.push(...payloads);
      return payloads;
    },
  };

  globalThis.ui = {
    notifications: {
      error() {},
      info() {},
      warn() {},
    },
  };
  globalThis.game = {
    actors: {
      get: (id) => (id === "actor1" ? actor : null),
    },
    packs: new Map([
      [
        PACK_ID,
        {
          documentName: "Item",
          getDocuments: async () => [
            {
              id: scroll._id,
              documentName: "Item",
              uuid: `Compendium.${PACK_ID}.Item.${scroll._id}`,
              toObject: () => structuredClone(scroll),
            },
          ],
        },
      ],
    ]),
  };
  globalThis.fromUuid = async (uuid) => ({
    uuid,
    toObject: () => structuredClone(spell),
  });

  const result = await depositToActor("actor1", {
    items: [{ uuid: spellUuid, name: "Fireball", quantity: 2 }],
    notify: false,
  });

  assert.equal(result.created, 1);
  assert.deepEqual(result.failures, []);
  assert.equal(createdPayloads.length, 1);
  assert.equal(createdPayloads[0].name, "Spell Scroll: Fireball");
  assert.equal(createdPayloads[0].type, "consumable");
  assert.equal(createdPayloads[0].system.type.value, "scroll");
  assert.equal(createdPayloads[0].system.quantity, 2);
  assert.equal(createdPayloads[0]._id, undefined);
  assert.equal(createdPayloads[0].id, undefined);
  assert.equal(createdPayloads[0].uuid, undefined);
}

process.stdout.write("spell distribution validation passed\n");
