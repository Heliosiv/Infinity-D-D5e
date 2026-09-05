import assert from "node:assert/strict";
globalThis.foundry = {
  applications: {
    api: {
      ApplicationV2: class {},
      HandlebarsApplicationMixin: (Base) => Base,
    },
  },
};
class Display {
  constructor(text = "", style = {}) {
    this.text = text;
    this.style = style;
    this.children = [];
    this.events = {};
    this.position = {
      set: (...values) => {
        this.xy = values;
      },
    };
    this.anchor = { set() {} };
  }
  addChild(child) {
    this.children.push(child);
    child.parent = this;
    return child;
  }
  removeChild(child) {
    this.children = this.children.filter((item) => item !== child);
    child.parent = null;
  }
  on(name, callback) {
    this.events[name] = callback;
  }
  destroy() {
    this.destroyed = true;
  }
  clear() {
    return this;
  }
  lineStyle() {
    return this;
  }
  beginFill() {
    return this;
  }
  drawRoundedRect() {
    return this;
  }
  endFill() {
    return this;
  }
}
globalThis.PIXI = {
  Container: Display,
  Graphics: Display,
  Text: Display,
  Rectangle: class {},
};
const gm = { id: "gm", role: 4, isGM: true };
const player = { id: "player", role: 1, character: "actor" };
const actor = {
  id: "actor",
  type: "character",
  name: "Bryn",
  ownership: { player: 3 },
  effects: {
    contents: [
      {
        flags: {
          "infinity-dnd5e": {
            criticalInjury: {
              id: "injury",
              injuryName: "Deep Scar",
              permanent: true,
            },
          },
        },
      },
    ],
  },
};
let enabled = true;
globalThis.game = {
  user: player,
  users: { contents: [gm, player] },
  actors: { get: () => actor },
  settings: { get: () => enabled },
};
const badge = await import("./injury/token-badge.js");
const { CriticalInjuryApp } = await import("./injury/injury-app.js");
let opened;
CriticalInjuryApp.open = (options) => {
  opened = options;
};
const token = Object.assign(new Display(), {
  actor,
  w: 100,
  h: 100,
  visible: true,
  document: { actorLink: true },
});
assert.equal(
  badge.tokenInjuryBadgeData(token).count,
  1,
  "permanent injuries remain visible on tokens",
);
badge.refreshTokenInjuryBadge(token);
badge.refreshTokenInjuryBadge(token);
assert.equal(token.children.length, 1, "redraw does not duplicate badges");
assert.match(token.children[0].accessibleTitle, /Deep Scar/);
token.children[0].events.pointertap({ stopPropagation() {} });
assert.equal(opened.actorId, actor.id);
const original = token.children[0];
game.user = { id: "unrelated", role: 1 };
badge.refreshTokenInjuryBadge(token);
assert.equal(token.children.length, 0, "unrelated users see no injury badge");
assert.equal(original.destroyed, true);
game.user = gm;
badge.refreshTokenInjuryBadge(token);
assert.equal(token.children.length, 1);
token.w = 200;
badge.refreshTokenInjuryBadge(token);
assert.ok(token.children[0].xy[0] > 100, "badge follows token resizing");
enabled = false;
badge.refreshTokenInjuryBadge(token);
assert.equal(token.children.length, 0);
enabled = true;
token.document.actorLink = false;
assert.equal(
  badge.tokenInjuryBadgeData(token),
  null,
  "synthetic token injuries do not open the wrong world actor",
);
token.document.actorLink = true;
actor.uuid = "Actor.aaaaaaaaaaaaaaaa";
const trackedEffect = actor.effects.contents[0];
trackedEffect.uuid = `${actor.uuid}.ActiveEffect.bbbbbbbbbbbbbbbb`;
actor.flags = {
  "infinity-dnd5e": {
    recordedInjuries: {
      scar: {
        schema: 1,
        actorUuid: actor.uuid,
        id: "scar",
        sourceUuid: "JournalEntry.cccccccccccccccc",
        label: "Old scar",
        status: "permanent",
      },
      healed: {
        schema: 1,
        actorUuid: actor.uuid,
        id: "healed",
        label: "Healed wound",
        status: "recovered",
      },
      duplicate: {
        schema: 1,
        actorUuid: actor.uuid,
        id: "duplicate",
        sourceUuid: trackedEffect.uuid,
        label: "Deep Scar",
        status: "permanent",
      },
      review: {
        schema: 1,
        actorUuid: actor.uuid,
        id: "review",
        label: "Uncertain wound",
        status: "review",
      },
    },
  },
};
assert.equal(
  badge.tokenInjuryBadgeData(token).count,
  3,
  "recorded injuries count once and recovered records do not count",
);
assert.match(
  badge.tokenInjuryBadgeData(token).label,
  /Uncertain wound \(needs review\)/,
);
actor.flags = {};
actor.effects.contents = [];
badge.refreshTokenInjuryBadge(token);
assert.equal(
  token.children.length,
  0,
  "badge disappears when the final wound is removed",
);
console.log(
  "critical injury token badge permissions, click, redraw and cleanup passed",
);
