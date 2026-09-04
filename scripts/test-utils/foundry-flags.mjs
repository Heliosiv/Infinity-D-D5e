import assert from "node:assert/strict";

// Model Foundry's recursive flag merge, including its explicit deletion keys.
// Plain assignment hides stale nested fields in real Journal updates.
export function applyFlagMerge(previous, changes) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
    return structuredClone(changes);
  }
  const result =
    previous && typeof previous === "object" && !Array.isArray(previous)
      ? structuredClone(previous)
      : {};
  for (const [key, value] of Object.entries(changes)) {
    if (key.startsWith("-=")) {
      assert.equal(value, null);
      delete result[key.slice(2)];
    } else {
      Object.defineProperty(result, key, {
        value: applyFlagMerge(result[key], value),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return result;
}
