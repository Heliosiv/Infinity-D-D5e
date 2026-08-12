import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Handlebars from "handlebars";

const read = (path) => readFileSync(path, "utf8");

const templates = [
  "templates/shop-picker.hbs",
  "templates/merchant-session.hbs",
  "templates/resource-overview.hbs",
  "templates/reputation-view.hbs",
  "templates/forage-prompt.hbs",
  "templates/downtime-activities.hbs",
  "templates/critical-injury.hbs",
  "templates/critical-injury-hud.hbs",
];

for (const path of templates) {
  assert.doesNotThrow(
    () => Handlebars.compile(read(path), { strict: false })({}),
    `${path} must remain valid Handlebars`,
  );
}

const shopScript = read("scripts/shop-picker.js");
const shopTemplate = read("templates/shop-picker.hbs");
assert.match(shopScript, /_wireSearch\(root\)/);
assert.match(shopScript, /resolveShopperActor/);
assert.match(shopScript, /getControlledMerchantActors/);
assert.match(shopTemplate, /data-role="shopper-actor"/);
assert.match(shopTemplate, /data-role="shop-search"/);
assert.match(
  shopTemplate,
  /<input(?=[^>]*data-role="shop-search")(?=[^>]*aria-label="Search shops by name or description")[^>]*>/,
);
assert.match(shopTemplate, /Shopping as/);
assert.match(shopTemplate, /Nothing changed/);
assert.match(shopTemplate, /Saved trade warnings/);
assert.match(shopTemplate, /Reviewed with GM…/);
assert.match(shopTemplate, /\{\{summary\}\}/);
assert.match(
  shopScript,
  /for quoted \$\{Number\(record\.context\.totalGp\)\.toFixed\(2\)\} gp/,
);
assert.match(
  shopScript,
  /clearMerchantPendingReview[\s\S]*?stillStored[\s\S]*?Campaign data was not changed/,
  "saved review clearing is confirmed by exact client readback",
);
assert.match(
  shopScript,
  /only removes this device's saved warning[\s\S]*?changes no Actor[\s\S]*?will not be retried/,
  "review confirmation explains its client-only effect",
);
assert.match(
  shopScript,
  /emitMerchantEvent\(MERCHANT_EVENTS\.SHOP_REQUEST, \{ merchantId \}\)/,
  "shop search and context must not broaden the shop request payload",
);

const merchantScript = read("scripts/merchant-session.js");
const merchantTemplate = read("templates/merchant-session.hbs");
assert.match(merchantScript, /_wireItemSearch\(root\)/);
assert.match(merchantTemplate, /data-role="item-search"/);
assert.match(
  merchantTemplate,
  /<input(?=[^>]*data-role="item-search")(?=[^>]*aria-label="Search \{\{#if buyActive\}\}goods for sale\{\{else\}\}your sellable items\{\{\/if\}\}")[^>]*>/,
);
assert.match(merchantTemplate, /\{\{actorName\}\}/);
assert.match(merchantTemplate, /ms-transaction--\{\{transactionTone\}\}/);
assert.match(merchantTemplate, /Session totals/);
assert.match(merchantTemplate, /Safe next step:/);
assert.match(merchantTemplate, /data-role="merchant-actor"/);
assert.match(merchantScript, /getControlledMerchantActors/);
assert.match(merchantScript, /setPreferredMerchantActorId/);
assert.match(
  merchantScript,
  /emitMerchantEvent\(ctx\.eventType, ctx\.payload\)/,
  "uncertain retries must resend the original confirmation payload",
);
assert.match(merchantScript, /transactionUncertain/);
assert.match(merchantTemplate, /Retry confirmation/);
assert.match(
  merchantTemplate,
  /\{\{#unless buyActive\}\}[\s\S]*id="ms-panel-buy-\{\{domId\}\}"[^>]*role="tabpanel"[^>]*hidden/,
  "the lazy inactive Buy tab retains a valid tabpanel target",
);
assert.match(
  merchantTemplate,
  /\{\{#unless sellActive\}\}[\s\S]*id="ms-panel-sell-\{\{domId\}\}"[^>]*role="tabpanel"[^>]*hidden/,
  "the lazy inactive Sell tab retains a valid tabpanel target",
);
assert.doesNotMatch(
  merchantTemplate,
  /<ul(?=[^>]*aria-live="polite")(?=[^>]*role="status")[^>]*>/,
  "transaction log announcements retain native list semantics",
);
assert.match(merchantScript, /Object\.hasOwn\(ownership, userId\)/);
assert.match(merchantScript, /controlledActors\.length === 1/);
assert.doesNotMatch(
  merchantScript,
  /testUserPermission/,
  "broad Assistant-GM document visibility must not select a shopping actor",
);

const stateTemplates = [
  "templates/resource-overview.hbs",
  "templates/reputation-view.hbs",
];
for (const path of stateTemplates) {
  const source = read(path);
  assert.match(source, /data-action="refresh"/);
  assert.match(source, /Nothing changed/i);
  assert.match(source, /Try again/);
}

const forageScript = read("scripts/forage-prompt.js");
const forageTemplate = read("templates/forage-prompt.hbs");
assert.match(forageTemplate, /class="fp-context"/);
assert.match(forageTemplate, /Foraging is offline/);
assert.match(forageTemplate, /do not roll again/i);
assert.match(forageScript, /retryConnection/);
assert.match(forageScript, /authoritativeGMId/);
assert.doesNotMatch(forageScript, /users\?\.activeGM/);

const downtimeTemplate = read("templates/downtime-activities.hbs");
const downtimeCss = read("styles/downtime.css");
assert.match(downtimeTemplate, /Active character/);
assert.match(downtimeTemplate, /Safe next step:/);
assert.match(downtimeTemplate, /class="dt-queue__drawer" open/);
assert.match(downtimeTemplate, /data-action="moveActivityUp"/);
assert.match(downtimeTemplate, /data-action="moveActivityDown"/);
assert.match(
  downtimeTemplate,
  /<div(?=[^>]*class="dt-heat__pips")(?=[^>]*role="img")(?=[^>]*aria-label="Heat \{\{heat\}\} out of 5")[^>]*>/,
);
assert.match(downtimeCss, /@container downtime-player \(max-width: 820px\)/);
assert.match(downtimeCss, /\.dt-queue__footer[\s\S]*position: sticky/);

const injuryScript = read("scripts/injury/injury-app.js");
const injuryTemplate = read("templates/critical-injury.hbs");
const injuryHudTemplate = read("templates/critical-injury-hud.hbs");
assert.match(injuryScript, /treatmentMessage:/);
assert.match(injuryTemplate, /ci-treatment-message/);
assert.match(injuryTemplate, /Injury actions are offline/);
assert.match(injuryHudTemplate, /class="ci-hud-actor"/);
assert.match(injuryHudTemplate, /data-action="pinRegion"/);
assert.match(injuryHudTemplate, /data-action="closeRegion"/);

const containerStyles = [
  ["styles/shop-picker.css", "shop-picker"],
  ["styles/merchant-session.css", "merchant-session"],
  ["styles/resource-overview.css", "resource-overview"],
  ["styles/reputation-view.css", "reputation-view"],
  ["styles/forage-prompt.css", "forage-prompt"],
  ["styles/critical-injury.css", "critical-injury"],
];
for (const [path, name] of containerStyles) {
  assert.match(
    read(path),
    new RegExp(`container(?:-name)?:?[^;]*${name}`),
    `${path} must establish a named application container`,
  );
}

assert.match(
  read("styles/merchant-session.css"),
  /\.ms-head__purse-label\s*\{[\s\S]*?var\(--ms-parchment-ink\) 76%/,
  "the wallet label keeps sufficient contrast against parchment",
);

globalThis.foundry = {
  applications: {
    api: {
      ApplicationV2: class {},
      HandlebarsApplicationMixin: (Base) => class extends Base {},
    },
  },
  utils: { deepClone: structuredClone, duplicate: structuredClone },
};
globalThis.Hooks = { on: () => 1, off: () => {} };
globalThis.CONST = {
  DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 3 },
  USER_ROLES: { GAMEMASTER: 4 },
};
const ownedA = {
  id: "owned-a",
  name: "Aster",
  type: "character",
  ownership: { assistant: 3 },
};
const ownedB = {
  id: "owned-b",
  name: "Bram",
  type: "character",
  ownership: { assistant: 3 },
};
const merelyVisible = {
  id: "visible-only",
  name: "Campaign NPC",
  type: "character",
  ownership: { assistant: 2 },
};
const defaultOwner = {
  id: "default-owner",
  name: "Default Owner",
  type: "character",
  ownership: { default: 3 },
};
globalThis.game = {
  user: { id: "assistant", isGM: true, role: 3, character: null },
  actors: { contents: [ownedA, ownedB, merelyVisible, defaultOwner] },
  users: {},
  modules: new Map(),
  settings: { get: () => undefined },
};
const actorModule = await import(`./merchant-session.js?ux=${Date.now()}`);
const forageModule = await import(`./forage-prompt.js?ux=${Date.now()}`);
const shopModule = await import(`./shop-picker.js?ux=${Date.now()}`);
assert.deepEqual(
  actorModule.getControlledMerchantActors().map((actor) => actor.id),
  ["owned-a", "owned-b"],
  "Assistant role visibility and default ownership must not enter the controlled-Actor allowlist",
);
assert.equal(
  actorModule.resolvePlayerActor(),
  null,
  "multiple controlled Actors require an explicit selection",
);
assert.equal(actorModule.resolvePlayerActor("owned-b"), ownedB);
assert.equal(
  actorModule.resolvePlayerActor("visible-only"),
  null,
  "submission-time resolution rejects an Actor outside the allowlist",
);
globalThis.game.user.character = ownedA;
assert.equal(
  actorModule.resolvePlayerActor(),
  ownedA,
  "Foundry's assigned character remains the safe default",
);
globalThis.game.user.character = merelyVisible;
assert.equal(
  actorModule.resolvePlayerActor(),
  null,
  "an assigned but non-owned character is not a transaction authority",
);
globalThis.game.user.character = ownedA;
assert.equal(actorModule.setPreferredMerchantActorId("owned-b"), ownedB);
ownedB.ownership.assistant = 2;
assert.equal(
  actorModule.resolvePlayerActor("owned-b"),
  null,
  "a later ownership change fails closed before a transaction",
);

const assistantUser = globalThis.game.user;
assistantUser.active = true;
const assistantOnlyUsers = new Map([[assistantUser.id, assistantUser]]);
assistantOnlyUsers.activeGM = assistantUser;
globalThis.game.users = assistantOnlyUsers;

const authoritySurfaces = [
  [
    Object.create(forageModule.ForagePromptApp.prototype),
    "forage prompt",
    "_hasAuthoritativeGM",
  ],
  [
    Object.create(actorModule.MerchantSessionApp.prototype),
    "merchant session",
    "_hasAuthoritativeGM",
  ],
  [
    Object.create(shopModule.ShopPickerApp.prototype),
    "shop picker",
    "_hasActiveGM",
  ],
];

for (const [surface, label, property] of authoritySurfaces) {
  assert.equal(
    surface[property],
    false,
    `${label} stays offline when only an Assistant GM is connected`,
  );
}

const fullGm = {
  id: "full-gm",
  isGM: true,
  role: 4,
  active: true,
};
const fullAuthorityUsers = new Map([
  [assistantUser.id, assistantUser],
  [fullGm.id, fullGm],
]);
fullAuthorityUsers.activeGM = fullGm;
globalThis.game.users = fullAuthorityUsers;

for (const [surface, label, property] of authoritySurfaces) {
  assert.equal(
    surface[property],
    true,
    `${label} comes online when a full authoritative GM is connected`,
  );
}

process.stdout.write("player surface UX contract validation passed\n");
