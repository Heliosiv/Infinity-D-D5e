import assert from "node:assert/strict";

import { buildMerchantWorkspaceOverview } from "./merchant/workspace-overview.js";
import { buildDowntimeWorkspaceOverview } from "./downtime/workspace-overview.js";

const shops = buildMerchantWorkspaceOverview({
  merchants: [
    {
      id: "open-stocked",
      name: "Open & Stocked",
      locationId: "city",
      status: "Open",
      itemCount: 4,
    },
    {
      id: "closed-empty",
      name: "Closed & Empty",
      locationId: "city",
      status: "Closed",
      itemCount: 0,
    },
    {
      id: "unassigned",
      name: "Road Cart",
      locationId: "",
      status: "Closed",
      itemCount: 1,
    },
  ],
  locations: [
    { id: "", name: "Unassigned shops" },
    { id: "city", name: "Drakmor" },
  ],
  sessions: [{ merchantId: "open-stocked" }],
  transactionReviewCount: 2,
  selectedLocationId: "city",
});

assert.deepEqual(shops.stats, {
  locationCount: 1,
  shopCount: 3,
  openCount: 1,
  closedCount: 2,
  emptyCount: 1,
  activeSessionCount: 1,
  reviewCount: 2,
  hasAttention: true,
});
assert.equal(shops.selectedLocation.openCount, 1);
assert.equal(shops.selectedLocation.closedCount, 1);
assert.equal(shops.selectedLocation.emptyCount, 1);
assert.equal(shops.selectedLocation.activeSessionCount, 1);
assert.match(shops.selectedLocation.searchText, /closed & empty/);

const globallyClosed = buildMerchantWorkspaceOverview({
  merchants: [{ id: "shop", locationId: "city", status: "Open", itemCount: 1 }],
  locations: [{ id: "city", name: "Drakmor" }],
  accessClosed: true,
  selectedLocationId: "city",
});
assert.equal(globallyClosed.stats.openCount, 0);
assert.equal(globallyClosed.selectedLocation.closedCount, 1);

const downtime = buildDowntimeWorkspaceOverview({
  view: "research",
  currentBlock: {
    submittedCount: 2,
    resolvedCount: 1,
    participants: [
      { submitted: true, resolved: true, canPrepare: false },
      { submitted: true, resolved: false, canPrepare: true },
      { submitted: false, resolved: false, canPrepare: false },
    ],
  },
  guidedTemplates: [{}, {}],
  guidedProjects: [{}],
  researchSeeds: [{}, {}, {}],
  researchCases: [
    { approved: true, needsWorldBuilding: false },
    { approved: true, needsWorldBuilding: true },
    { approved: false, needsWorldBuilding: false },
  ],
  settlements: [{}],
  history: [{}, {}],
});

assert.equal(downtime.guide.title, "Research & Rumors");
assert.deepEqual(downtime.block, {
  participantCount: 3,
  submittedCount: 2,
  readyCount: 1,
  resolvedCount: 1,
  waitingCount: 1,
  hasReady: true,
});
assert.equal(downtime.navigation.current.count, 1);
assert.equal(downtime.navigation.activities.count, 2);
assert.equal(downtime.navigation.research.count, 2);
assert.equal(downtime.navigation.research.tone, "warning");
assert.equal(downtime.navigation.history.count, 2);

const recovery = buildDowntimeWorkspaceOverview({ needsRecovery: true });
assert.equal(recovery.navigation.current.tone, "danger");
assert.equal(recovery.navigation.current.label, "recovery needed");

console.log("workspace overview checks passed");
