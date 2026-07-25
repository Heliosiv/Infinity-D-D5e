/**
 * Compare JSON-compatible persisted values without depending on object-key
 * insertion order. Foundry may deep-merge a flag update into its existing
 * object, preserving the old key order even when the stored value is otherwise
 * identical to the requested payload.
 */
export function persistedValuesEqual(left, right) {
  if (Object.is(left, right)) return true;

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((value, index) =>
      persistedValuesEqual(value, right[index]),
    );
  }

  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }

  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;

  return leftKeys.every(
    (key) =>
      Object.hasOwn(right, key) && persistedValuesEqual(left[key], right[key]),
  );
}
