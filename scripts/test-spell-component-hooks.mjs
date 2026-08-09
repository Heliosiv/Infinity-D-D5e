import assert from "node:assert/strict";
import {
  registerSpellComponentHooks,
  resetSpellComponentHooksForTests,
} from "./spell-components/hooks.js";

function createHooks() {
  const events = new Map();
  return {
    on(name, callback) {
      const callbacks = events.get(name) ?? [];
      callbacks.push(callback);
      events.set(name, callbacks);
      return callbacks.length;
    },
    call(name, ...args) {
      let allowed = true;
      for (const callback of events.get(name) ?? []) {
        if (callback(...args) === false) allowed = false;
      }
      return allowed;
    },
    count(name) {
      return events.get(name)?.length ?? 0;
    },
  };
}

function spellActivity(componentQuantity) {
  const component = {
    id: "components-a",
    name: "Spell Components",
    type: "loot",
    system: {
      identifier: "spell-components",
      quantity: componentQuantity,
    },
  };
  const actor = {
    id: "actor-a",
    name: "Aria",
    items: [component],
  };
  const item = {
    id: "spell-a",
    name: "Fireball",
    type: "spell",
    actor,
    system: { level: 3 },
  };
  return { item, actor };
}

function blankUpdates() {
  return { activity: {}, actor: {}, delete: [], item: [], rolls: [] };
}

let enabled = true;
globalThis.game = {
  settings: {
    get: (_moduleId, key) =>
      key === "spellComponentsEnabled" ? enabled : undefined,
  },
};

const hooks = createHooks();
const messages = { info: [], warn: [] };
const notifications = {
  info: (message) => messages.info.push(message),
  warn: (message) => messages.warn.push(message),
};

assert.equal(registerSpellComponentHooks({ hooks, notifications }), true);
assert.equal(registerSpellComponentHooks({ hooks, notifications }), false);
assert.equal(hooks.count("dnd5e.activityConsumption"), 1);
assert.equal(hooks.count("dnd5e.postActivityConsumption"), 1);

{
  const activity = spellActivity(5);
  const updates = blankUpdates();
  assert.equal(
    hooks.call("dnd5e.activityConsumption", activity, {}, {}, updates),
    true,
  );
  assert.deepEqual(updates.item, [
    { _id: "components-a", "system.quantity": 2 },
  ]);
  assert.equal(messages.info.length, 0, "success waits for canonical apply");
  hooks.call("dnd5e.postActivityConsumption", activity, {}, {}, updates);
  assert.equal(messages.info.length, 1);
  assert.match(messages.info[0], /spending 3 spell components \(2 remaining\)/);
}

{
  const activity = spellActivity(2);
  const updates = blankUpdates();
  assert.equal(
    hooks.call("dnd5e.activityConsumption", activity, {}, {}, updates),
    false,
  );
  assert.deepEqual(updates.item, []);
  assert.equal(messages.warn.length, 1);
  assert.match(messages.warn[0], /needs 3 spell components, but only 2 remain/);
}

{
  enabled = false;
  const updates = blankUpdates();
  assert.equal(
    hooks.call("dnd5e.activityConsumption", spellActivity(5), {}, {}, updates),
    true,
  );
  assert.deepEqual(updates.item, []);
}

resetSpellComponentHooksForTests(hooks);
delete globalThis.game;

process.stdout.write("spell component hook validation passed\n");
