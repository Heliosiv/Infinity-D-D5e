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

/**
 * Fail closed when a live persisted domain payload was written by a newer or
 * malformed schema. Callers deliberately apply this at persistence boundaries,
 * leaving pure legacy normalizers free to upgrade older fixtures.
 */
export function assertSupportedPersistedVersion(
  rawVersion,
  { domain, supportedVersion, codePrefix },
) {
  const supported = Number(supportedVersion);
  if (!Number.isSafeInteger(supported) || supported < 0) {
    throw new TypeError("supportedVersion must be a non-negative safe integer");
  }

  const parsed = parsePersistedVersion(rawVersion);
  if (!parsed.present) return;
  const observed = parsed.value;
  const invalid = !parsed.valid;
  if (!invalid && observed <= supported) return;

  const status = Object.freeze({
    state: "blocked",
    code: invalid ? "invalid-version" : "future-version",
    retryable: false,
    domain: String(domain ?? "persisted-domain"),
    supportedVersion: supported,
    observedVersion: invalid ? null : observed,
  });
  const prefix = String(codePrefix ?? "PERSISTED_DOMAIN")
    .trim()
    .toUpperCase();
  const error = new Error(
    `PersistedDomainVersionBlocked:${status.domain}:${status.code}`,
  );
  error.name = "PersistedDomainVersionError";
  error.code = `${prefix}_${invalid ? "INVALID" : "FUTURE"}_VERSION`;
  error.retryable = false;
  error.persistedVersionStatus = status;
  throw error;
}

/** Strict equality for persisted version gates without throwing. */
export function persistedVersionEquals(rawVersion, expectedVersion) {
  const expected = Number(expectedVersion);
  if (!Number.isSafeInteger(expected) || expected < 0) return false;
  const parsed = parsePersistedVersion(rawVersion);
  return parsed.present && parsed.valid && parsed.value === expected;
}

function parsePersistedVersion(rawVersion) {
  if (rawVersion === undefined) {
    return { present: false, valid: true, value: null };
  }
  const isCanonicalIntegerString =
    typeof rawVersion === "string" && /^(0|[1-9]\d*)$/.test(rawVersion);
  const observed =
    typeof rawVersion === "number"
      ? rawVersion
      : isCanonicalIntegerString
        ? Number(rawVersion)
        : Number.NaN;
  const valid = Number.isSafeInteger(observed) && observed >= 0;
  return { present: true, valid, value: valid ? observed : null };
}
