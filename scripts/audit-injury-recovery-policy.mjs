/** Characterization audit for the recovery-policy proposal; not a desired-behavior gate.
 * Run in its own Node process. Uses synthetic documents and no live world.
 */
import assert from "node:assert/strict";
import { getCriticalInjuryDefinition } from "./injury/table.js";
import { buildCriticalInjuryEffectData } from "./injury/effects.js";
import { planDowntimeCare } from "./injury/downtime-care.js";
import {
  buildInjuryFromResolution,
  processExpiredCriticalInjuries,
} from "./injury/service.js";

const gm = { id: "gm", isGM: true, role: 4, active: true };
const player = { id: "player", role: 1, isGM: false };
const users = [gm, player];
users.contents = users;
users.activeGM = gm;
const actors = [];
actors.contents = actors;
actors.get = (id) => actors.find((actor) => actor.id === id);
globalThis.game = {
  user: gm,
  users,
  actors,
  modules: new Map(),
  time: { worldTime: 1000 },
  settings: { get: () => true },
};
globalThis.CONST = { USER_ROLES: { GAMEMASTER: 4 } };
const rows = [];
for (const version of [2, 3]) {
  for (const key of [
    "internal-bleeding",
    "deep-cut",
    "infection",
    "nightmares",
  ]) {
    const definition = getCriticalInjuryDefinition(key, version);
    const start = 1000;
    const days = Number(definition.recoveryFormula);
    const due = start + days * 86400;
    game.time.worldTime = start;
    const actor = {
      id: "synthetic-actor",
      type: "character",
      name: "Recovery audit",
      ownership: { player: 3 },
      effects: { contents: [] },
    };
    actors.splice(0, actors.length, actor);
    const injury = buildInjuryFromResolution("audit", actor, {
      injuryId: "synthetic-injury",
      injuryKey: key,
      injuryRoll: definition.min,
      tableVersion: version,
      recoveryFormula: definition.recoveryFormula,
      recoveryDays: days,
      recoveryStartTs: start,
      recoveryDueTs: due,
      detailTotal: key === "deep-cut" ? 4 : null,
    });
    const data = buildCriticalInjuryEffectData(injury, { startTime: start });
    let deletes = 0;
    const effect = {
      id: "synthetic-effect",
      flags: data.flags,
      duration: data.duration,
      toObject: () => structuredClone(data),
      async delete() {
        deletes++;
        actor.effects.contents = [];
      },
    };
    actor.effects.contents = [effect];
    assert.equal(injury.stabilized, false);
    assert.equal(data.duration.seconds, days * 86400);
    const care = planDowntimeCare(`${actor.id}|${injury.id}`, "synthetic-care");
    assert.equal(care.after.recoveryDueTs, due - 86400);
    game.time.worldTime = due - 1;
    assert.equal(await processExpiredCriticalInjuries(), 0);
    assert.equal(deletes, 0);
    game.time.worldTime = due;
    assert.equal(await processExpiredCriticalInjuries(), 1);
    assert.equal(deletes, 1);
    assert.equal(await processExpiredCriticalInjuries(), 0);
    rows.push({
      version,
      injury: key,
      untreatedExpiryDays: days,
      effectTimerSeconds: data.duration.seconds,
      careCanComplete: care.healed,
      deletedAtDeadline: deletes === 1,
    });
  }
}
console.table(rows);
console.log(
  "Confirmed 8 historical/current expiry cases. These assertions describe the contradiction, not the proposed policy.",
);
