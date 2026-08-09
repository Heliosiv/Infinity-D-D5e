import assert from "node:assert/strict";

import {
  clearTools,
  getTool,
  getTools,
  registerTool,
  TOOL_INTENTS,
} from "./tool-registry.js";

/* clean slate between blocks */
clearTools();

/* ------------------------------------------------------------------ *
 * Basic registration + retrieval
 * ------------------------------------------------------------------ */
{
  registerTool({
    id: "alpha",
    title: "Alpha Tool",
    description: "first",
    icon: "fa-solid fa-a",
    category: "loot",
    status: "available",
    open: () => "alpha-opened",
  });
  registerTool({
    id: "beta",
    title: "Beta Tool",
    description: "second",
    icon: "fa-solid fa-b",
    category: "party",
    status: "coming-soon",
    open: () => "beta-opened",
  });

  const tools = getTools();
  assert.equal(tools.length, 2, "two tools registered");
  assert.deepEqual(
    tools.map((t) => t.id),
    ["alpha", "beta"],
    "tools surface in registration order",
  );

  const alpha = getTool("alpha");
  assert.equal(alpha.title, "Alpha Tool");
  assert.equal(alpha.status, "available");
  assert.equal(
    alpha.intent,
    TOOL_INTENTS.RUN_SESSION,
    "loot tools default into Run the Session",
  );
  assert.equal(alpha.open(), "alpha-opened", "open callback is invokable");

  assert.equal(getTool("unknown"), null, "missing id returns null");
}

/* ------------------------------------------------------------------ *
 * Re-registration replaces the prior entry
 * ------------------------------------------------------------------ */
{
  clearTools();
  registerTool({
    id: "twin",
    title: "Twin v1",
    status: "available",
    open: () => 1,
  });
  registerTool({
    id: "twin",
    title: "Twin v2",
    status: "coming-soon",
    open: () => 2,
  });
  const tools = getTools();
  assert.equal(tools.length, 1, "duplicate id collapses to a single entry");
  assert.equal(tools[0].title, "Twin v2", "later registration wins");
  assert.equal(tools[0].status, "coming-soon");
}

/* ------------------------------------------------------------------ *
 * Defaults + validation
 * ------------------------------------------------------------------ */
{
  clearTools();
  const tool = registerTool({
    id: "defaults",
    status: "available",
    open: () => {},
  });
  assert.equal(tool.title, "defaults", "title defaults to id");
  assert.equal(tool.description, "");
  assert.equal(tool.icon, "fa-solid fa-toolbox");
  assert.equal(tool.category, "misc");
  assert.equal(tool.intent, TOOL_INTENTS.PREPARE);

  // Frozen — registration must not be mutable from the outside.
  assert.throws(
    () => {
      tool.title = "mutated";
    },
    /./,
    "registered tools are frozen",
  );
}

/* ------------------------------------------------------------------ *
 * Required fields + valid status values
 * ------------------------------------------------------------------ */
{
  clearTools();
  assert.throws(
    () => registerTool({}),
    /id is required/,
    "throws when id is missing",
  );
  assert.throws(
    () => registerTool({ id: "", status: "available", open: () => {} }),
    /id is required/,
    "blank id is rejected",
  );
  assert.throws(
    () => registerTool({ id: "x", status: "wat", open: () => {} }),
    /status must be one of/,
    "invalid status rejected",
  );
  assert.throws(
    () =>
      registerTool({
        id: "x",
        status: "available",
        intent: "secret-gm-place",
      }),
    /intent must be one of/,
    "invalid Home intent rejected",
  );
  assert.throws(
    () => registerTool(null),
    /must be an object/,
    "null payload rejected",
  );
}

/* ------------------------------------------------------------------ *
 * Explicit and compatibility-inferred Home intent groups
 * ------------------------------------------------------------------ */
{
  clearTools();
  const downtime = registerTool({
    id: "downtime-workspace",
    category: "party",
    status: "available",
  });
  const resourceManager = registerTool({
    id: "resource-manager",
    category: "party",
    status: "available",
  });
  const explicit = registerTool({
    id: "session-merchant",
    category: "merchants",
    intent: TOOL_INTENTS.RUN_SESSION,
    status: "available",
  });
  assert.equal(downtime.intent, TOOL_INTENTS.RUN_SESSION);
  assert.equal(resourceManager.intent, TOOL_INTENTS.TRACK_CAMPAIGN);
  assert.equal(explicit.intent, TOOL_INTENTS.RUN_SESSION);
}

/* ------------------------------------------------------------------ *
 * Missing open callback gets a safe no-op default
 * ------------------------------------------------------------------ */
{
  clearTools();
  const tool = registerTool({ id: "no-open", status: "coming-soon" });
  assert.equal(typeof tool.open, "function", "open is always callable");
  assert.equal(
    tool.open(),
    undefined,
    "default open is a no-op that returns undefined",
  );
}

/* clean up so we don't pollute follow-on test files */
clearTools();

process.stdout.write("tool-registry validation passed\n");
