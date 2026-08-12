import assert from "node:assert/strict";

import {
  DOWNTIME_ACTIVITY_ID_LIST,
  DOWNTIME_ACTIVITY_IDS,
  getDowntimeActivity,
  isAllowedActivityDuration,
} from "./downtime/catalog.js";
import {
  FENCING_PAYOUT_RATES,
  MARKET_TRADING_RETURN_RATES,
  DOWNTIME_OUTCOME_TIERS,
  applyCrimeHeatOutcome,
  calculateAmmunitionCraftCostCp,
  calculateCrimeDc,
  calculateFencingResult,
  calculateMarketTradingResult,
  classifyDowntimeCheck,
  classifyDowntimeMargin,
  getDowntimeTimeBonus,
  getFencingValueCapCp,
  getMarketStakeCapCp,
  getPickpocketValueCapCp,
  reduceDowntimeHeat,
} from "./downtime/math.js";
import {
  buildPickpocketOpportunitySeed,
  buildPickpocketRewardSeed,
  createDowntimeOpportunitySecret,
  createDowntimeOpportunitySecretBundle,
  deterministicDowntimeRoll,
  generatePickpocketOpportunities,
  isGeneratedPickpocketOpportunityId,
} from "./downtime/opportunities.js";
import {
  DOWNTIME_CONFIG_VERSION,
  SETTLEMENT_SECURITY_DCS,
  createNonSettlementDowntimeContext,
  createSettlementIdFromName,
  getDowntimeHeat,
  getSettlementSecurityDc,
  normalizeDowntimeConfig,
  normalizeSettlementProfile,
  setDowntimeHeat,
} from "./downtime/settlements.js";
import {
  defaultGuidedDowntimeTemplates,
  normalizeGuidedDowntimeSelection,
  normalizeGuidedDowntimeTemplates,
} from "./downtime/dispatch.js";

/* Guided downtime templates remain bounded and player choices only name a
   configured template and skill. */
{
  const templates = defaultGuidedDowntimeTemplates();
  assert.equal(templates.length, 3);
  assert.equal(
    templates.every((template) => template.outcomes.length >= 3),
    true,
  );
  assert.equal(
    normalizeGuidedDowntimeSelection(
      { templateId: templates[0].id, skill: templates[0].skills[0] },
      templates,
    ).templateId,
    templates[0].id,
  );
  assert.equal(
    normalizeGuidedDowntimeSelection(
      { templateId: "unknown", skill: "per" },
      templates,
    ),
    null,
  );
  assert.equal(
    normalizeGuidedDowntimeTemplates([
      { id: "invalid", name: "Invalid", outcomes: [] },
    ]).length,
    3,
  );
}

/* Catalog contains every built-in with exact legal durations. */
{
  assert.equal(DOWNTIME_ACTIVITY_ID_LIST.length, 7);
  assert.deepEqual(
    getDowntimeActivity(DOWNTIME_ACTIVITY_IDS.MARKET_TRADING).allowedHours,
    [2, 4, 6, 8],
  );
  assert.equal(
    getDowntimeActivity(DOWNTIME_ACTIVITY_IDS.FENCE_STOLEN_GOODS).isCrime,
    true,
  );
  assert.equal(isAllowedActivityDuration("pickpocket", 2), true);
  assert.equal(isAllowedActivityDuration("pickpocket", 3), false);
  assert.equal(isAllowedActivityDuration("sharpen-weapon", 1), true);
  assert.equal(isAllowedActivityDuration("craft-ammunition", 8), false);
}

/* Settlement normalization locks down tiers, defaults, links, and activities. */
{
  assert.deepEqual(SETTLEMENT_SECURITY_DCS, {
    low: 10,
    standard: 13,
    high: 16,
    extreme: 19,
  });
  assert.equal(getSettlementSecurityDc("low"), 10);
  assert.equal(getSettlementSecurityDc("HIGH"), 16);
  assert.equal(getSettlementSecurityDc(4), 19);

  const profile = normalizeSettlementProfile({
    name: "  Brass & Briar  ",
    wealth: "rich",
    security: "guarded",
    marketDc: "17",
    factionId: "Faction.guild",
    merchantIds: ["merchant-a", "merchant-a", "merchant b", ""],
    enabledActivities: ["pickpocket", "lay-low", "forged-rule"],
    hiddenDcOverride: 2,
  });
  assert.deepEqual(profile, {
    id: "settlement-brass-briar",
    name: "Brass & Briar",
    hasSettlement: true,
    wealthTier: "wealthy",
    securityTier: "high",
    marketDc: 17,
    linkedFactionId: "Faction.guild",
    linkedMerchantIds: ["merchant-a", "merchantb"],
    enabledActivityIds: ["pickpocket", "lay-low"],
  });
  assert.equal(
    createSettlementIdFromName("Île du Corbeau"),
    "settlement-ile-du-corbeau",
  );

  const defaultProfile = normalizeSettlementProfile({ name: "Crossroads" });
  assert.equal(defaultProfile.securityTier, "standard");
  assert.equal(defaultProfile.marketDc, 13);
  assert.equal(defaultProfile.wealthTier, "modest");
  assert.deepEqual(
    defaultProfile.enabledActivityIds,
    DOWNTIME_ACTIVITY_ID_LIST,
  );
  assert.deepEqual(
    normalizeSettlementProfile({
      name: "Closed",
      marketDc: null,
      enabledActivities: [],
    }).enabledActivityIds,
    [],
  );
  assert.equal(
    normalizeSettlementProfile({ name: "Null DC", marketDc: null }).marketDc,
    13,
  );
  assert.deepEqual(
    normalizeSettlementProfile({
      name: "Uppercase",
      enabledActivities: ["PICKPOCKET"],
    }).enabledActivityIds,
    ["pickpocket"],
  );

  const camp = createNonSettlementDowntimeContext("  Pinewood camp  ");
  assert.equal(camp.name, "Pinewood camp");
  assert.equal(camp.hasSettlement, false);
  assert.deepEqual(camp.enabledActivityIds, DOWNTIME_ACTIVITY_ID_LIST);
  assert.deepEqual(camp.linkedMerchantIds, []);
  assert.equal(camp.linkedFactionId, "");
  assert.equal(createNonSettlementDowntimeContext().name, "Camp or wilderness");
}

/* Private config and Heat are safe, persistent, local, and clamped 0–5. */
{
  const config = normalizeDowntimeConfig({
    version: 999,
    settlements: [{ id: "town", name: "Town" }, null, "junk", {}],
    heat: {
      town: { actorA: 9, actorB: -2, "bad actor": 3 },
      malformed: null,
    },
    stolenGoods: {
      "issued-item": {
        itemId: "issued-item",
        actorId: "actorA",
        operationId: "theft-1",
        provenance: {
          settlementId: "town",
          targetType: "generated-mark",
          sourceId: "mark-1",
          merchantId: null,
          operationId: "theft-1",
          timestamp: 100,
          appraisedValueCp: 250,
        },
        state: "issued",
        issuedAt: 100,
      },
      forged: { state: "issued", appraisedValueCp: 99_999 },
    },
    history: [{ id: "receipt-1", complete: true }, null],
  });
  assert.equal(config.version, DOWNTIME_CONFIG_VERSION);
  assert.equal(config.settlements.length, 1);
  assert.deepEqual(config.heat, {
    town: { actorA: 5, actorB: 0, badactor: 3 },
  });
  assert.equal(getDowntimeHeat(config, "town", "actorA"), 5);
  assert.equal(getDowntimeHeat(config, "elsewhere", "actorA"), 0);
  const changed = setDowntimeHeat(config.heat, "town", "actorA", 2);
  assert.equal(changed.town.actorA, 2);
  assert.equal(config.heat.town.actorA, 5, "Heat updates do not mutate input");
  assert.deepEqual(Object.keys(config.stolenGoods), ["issued-item"]);
  assert.equal(
    config.stolenGoods["issued-item"].provenance.appraisedValueCp,
    250,
  );
  assert.deepEqual(
    normalizeDowntimeConfig({ version: 1 }).stolenGoods,
    {},
    "older private configs migrate to an empty issuance ledger",
  );
  assert.deepEqual(config.history, [{ id: "receipt-1", complete: true }]);
}

/* Shared margin tier boundaries are exact and stable. */
{
  const tiers = DOWNTIME_OUTCOME_TIERS;
  assert.equal(classifyDowntimeMargin(10), tiers.EXCEPTIONAL_SUCCESS);
  assert.equal(classifyDowntimeMargin(9), tiers.SUCCESS);
  assert.equal(classifyDowntimeMargin(0), tiers.SUCCESS);
  assert.equal(classifyDowntimeMargin(-1), tiers.SETBACK);
  assert.equal(classifyDowntimeMargin(-4), tiers.SETBACK);
  assert.equal(classifyDowntimeMargin(-5), tiers.FAILURE);
  assert.equal(classifyDowntimeMargin(-9), tiers.FAILURE);
  assert.equal(classifyDowntimeMargin(-10), tiers.SERIOUS_FAILURE);
  assert.deepEqual(classifyDowntimeCheck(23, 13), {
    total: 23,
    dc: 13,
    margin: 10,
    outcomeTier: tiers.EXCEPTIONAL_SUCCESS,
  });
  assert.equal(classifyDowntimeCheck("bad", 13), null);
}

/* Time scaling, Heat pressure, and local Heat outcomes. */
{
  assert.equal(getDowntimeTimeBonus("market-trading", 2), 0);
  assert.equal(getDowntimeTimeBonus("market-trading", 8), 3);
  assert.equal(getDowntimeTimeBonus("fence-stolen-goods", 6), 2);
  assert.equal(getDowntimeTimeBonus("pickpocket", 4), 2);
  assert.equal(getDowntimeTimeBonus("shoplift", 8), 2);
  assert.equal(getDowntimeTimeBonus("shoplift", 4), 0);
  assert.equal(
    calculateCrimeDc({
      baseDc: 13,
      heat: 2,
      earlierCrimeAttempts: 2,
      targetModifier: 20,
    }),
    21,
    "crime DC ignores target value and uses only security, Heat, and earlier attempts",
  );
  assert.equal(applyCrimeHeatOutcome(1, DOWNTIME_OUTCOME_TIERS.SETBACK), 2);
  assert.equal(applyCrimeHeatOutcome(1, DOWNTIME_OUTCOME_TIERS.FAILURE), 3);
  assert.equal(
    applyCrimeHeatOutcome(4, DOWNTIME_OUTCOME_TIERS.SERIOUS_FAILURE),
    5,
  );
  assert.equal(reduceDowntimeHeat(5), 4);
  assert.equal(reduceDowntimeHeat(0), 0);
}

/* Trading uses exact percentages and a duration-independent settlement cap. */
{
  assert.deepEqual(MARKET_TRADING_RETURN_RATES, {
    "exceptional-success": 0.25,
    success: 0.1,
    setback: 0,
    failure: -0.1,
    "serious-failure": -0.25,
  });
  assert.deepEqual(
    calculateMarketTradingResult({
      stakeCp: 1_000,
      outcomeTier: DOWNTIME_OUTCOME_TIERS.EXCEPTIONAL_SUCCESS,
    }),
    { stakeCp: 1_000, rate: 0.25, deltaCp: 250, finalCp: 1_250 },
  );
  assert.equal(
    calculateMarketTradingResult({
      stakeCp: 1_000,
      outcomeTier: DOWNTIME_OUTCOME_TIERS.SERIOUS_FAILURE,
    }).finalCp,
    750,
  );
  for (const hours of [2, 4, 6, 8]) {
    assert.equal(getMarketStakeCapCp("poor", hours), 1_000);
  }
  assert.equal(getMarketStakeCapCp("poor", 3), 0);
  assert.equal(getMarketStakeCapCp("wealthy", 8), 100_000);
  assert.equal(getPickpocketValueCapCp("poor"), 100);
  assert.equal(getPickpocketValueCapCp("wealthy"), 10_000);
}

/* Fencing pays 60/40/25/0/0 and failed attempts retain goods. */
{
  assert.deepEqual(FENCING_PAYOUT_RATES, {
    "exceptional-success": 0.6,
    success: 0.4,
    setback: 0.25,
    failure: 0,
    "serious-failure": 0,
  });
  assert.equal(getFencingValueCapCp("poor", 2), 500);
  assert.equal(getFencingValueCapCp("poor", 8), 2_000);
  const success = calculateFencingResult({
    goodsValueCp: 2_000,
    valueCapacityCp: 2_000,
    outcomeTier: DOWNTIME_OUTCOME_TIERS.SUCCESS,
  });
  assert.equal(success.payoutCp, 800);
  assert.equal(success.goodsTransferred, true);
  assert.equal(success.retainsGoods, false);
  const minimumSuccess = calculateFencingResult({
    goodsValueCp: 1,
    valueCapacityCp: 1,
    outcomeTier: DOWNTIME_OUTCOME_TIERS.SETBACK,
  });
  assert.equal(
    minimumSuccess.payoutCp,
    1,
    "a positive fencing tier must transfer at least one copper with the goods",
  );
  assert.equal(minimumSuccess.goodsTransferred, true);
  assert.equal(minimumSuccess.retainsGoods, false);
  const failure = calculateFencingResult({
    goodsValueCp: 2_000,
    valueCapacityCp: 2_000,
    outcomeTier: DOWNTIME_OUTCOME_TIERS.FAILURE,
  });
  assert.equal(failure.payoutCp, 0);
  assert.equal(failure.retainsGoods, true);
  const overCapacity = calculateFencingResult({
    goodsValueCp: 2_001,
    valueCapacityCp: 2_000,
    outcomeTier: DOWNTIME_OUTCOME_TIERS.EXCEPTIONAL_SUCCESS,
  });
  assert.equal(overCapacity.overCapacity, true);
  assert.equal(
    overCapacity.payoutCp,
    0,
    "over-capacity bundles cannot mint coin",
  );
  assert.equal(overCapacity.retainsGoods, true);
  assert.equal(getFencingValueCapCp("modest", 2), 2_500);
  assert.equal(getFencingValueCapCp("modest", 8), 10_000);
}

/* Ammunition materials cost half finished value, rounded up to whole cp. */
{
  assert.equal(
    calculateAmmunitionCraftCostCp({ unitMarketValueCp: 0.2, quantity: 20 }),
    2,
  );
  assert.equal(
    calculateAmmunitionCraftCostCp({ unitMarketValueCp: 5, quantity: 20 }),
    50,
  );
  assert.equal(calculateAmmunitionCraftCostCp({ unitMarketValueCp: -1 }), null);
}

/* Pickpocket choices are deterministic, unique, and player-safe. */
{
  const generatedSecret = createDowntimeOpportunitySecret({
    getRandomValues(bytes) {
      bytes.forEach((_, index) => {
        bytes[index] = index;
      });
      return bytes;
    },
  });
  assert.equal(
    generatedSecret,
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  );
  assert.throws(
    () => createDowntimeOpportunitySecret({}),
    /DowntimeSecureRandomUnavailable/,
  );
  let uuidCall = 0;
  const uuidSecret = createDowntimeOpportunitySecret({
    randomUUID() {
      uuidCall += 1;
      return uuidCall === 1
        ? "00112233-4455-4677-8899-aabbccddeeff"
        : "ffeeddcc-bbaa-4988-8766-554433221100";
    },
  });
  assert.equal(
    uuidSecret,
    "00112233445546778899aabbccddeeffffeeddccbbaa49888766554433221100",
    "the UUID-only secure fallback still produces one 256-bit hex key",
  );
  let secretCall = 0;
  const secretBundle = createDowntimeOpportunitySecretBundle({
    getRandomValues(bytes) {
      const offset = secretCall++ * bytes.length;
      bytes.forEach((_, index) => {
        bytes[index] = offset + index;
      });
      return bytes;
    },
  });
  assert.equal(
    secretBundle,
    `${generatedSecret}.202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f`,
  );
  const seed = buildPickpocketOpportunitySeed({
    blockId: "block-7",
    settlementId: "brass-briar",
    actorId: "hero-a",
    secret: "gm-secret-a",
  });
  const first = generatePickpocketOpportunities({
    seed,
    settlementId: "brass-briar",
  });
  const replay = generatePickpocketOpportunities({
    seed,
    settlementId: "brass-briar",
  });
  const other = generatePickpocketOpportunities({
    seed: buildPickpocketOpportunitySeed({
      blockId: "block-7",
      settlementId: "brass-briar",
      actorId: "hero-a",
      secret: "gm-secret-b",
    }),
    settlementId: "brass-briar",
  });
  assert.equal(first.length, 3);
  assert.deepEqual(first, replay);
  assert.notDeepEqual(
    first,
    other,
    "a different private salt changes the marks",
  );
  assert.equal(new Set(first.map((mark) => mark.id)).size, 3);
  for (const mark of first) {
    assert.equal(isGeneratedPickpocketOpportunityId(mark.id), true);
    assert.deepEqual(Object.keys(mark).sort(), [
      "description",
      "id",
      "label",
      "targetType",
    ]);
    assert.equal("dc" in mark, false);
    assert.equal("valueCp" in mark, false);
  }

  const sharedMarkSecret = "11".repeat(32);
  const firstSecret = `${sharedMarkSecret}.${"22".repeat(32)}`;
  const secondSecret = `${sharedMarkSecret}.${"33".repeat(32)}`;
  const firstSafeSeed = buildPickpocketOpportunitySeed({
    blockId: "block-private-reward",
    settlementId: "brass-briar",
    actorId: "hero-a",
    secret: firstSecret,
  });
  const secondSafeSeed = buildPickpocketOpportunitySeed({
    blockId: "block-private-reward",
    settlementId: "brass-briar",
    actorId: "hero-a",
    secret: secondSecret,
  });
  assert.equal(firstSafeSeed, secondSafeSeed);
  const safeMarks = generatePickpocketOpportunities({
    seed: firstSafeSeed,
    settlementId: "brass-briar",
  });
  assert.deepEqual(
    safeMarks,
    generatePickpocketOpportunities({
      seed: secondSafeSeed,
      settlementId: "brass-briar",
    }),
    "the complete player-safe mark projection can stay identical",
  );
  const rewardInput = {
    blockId: "block-private-reward",
    settlementId: "brass-briar",
    actorId: "hero-a",
    markId: safeMarks[0].id,
  };
  const firstRewardSeed = buildPickpocketRewardSeed({
    ...rewardInput,
    secret: firstSecret,
  });
  const secondRewardSeed = buildPickpocketRewardSeed({
    ...rewardInput,
    secret: secondSecret,
  });
  assert.notEqual(firstRewardSeed, secondRewardSeed);
  assert.notEqual(
    deterministicDowntimeRoll(firstRewardSeed, "value"),
    deterministicDowntimeRoll(secondRewardSeed, "value"),
    "safe mark ids do not determine the independent GM-only reward stream",
  );
  assert.throws(
    () =>
      buildPickpocketRewardSeed({ ...rewardInput, secret: generatedSecret }),
    /DowntimeRewardSecretUnavailable/,
    "legacy single-key blocks fail closed instead of exposing predictable rewards",
  );
}

process.stdout.write("downtime-domain validation passed\n");
