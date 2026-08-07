/**
 * Infinity D&D5e — Environment / region catalog (pure)
 *
 * The party's current surroundings drive whether foraging is possible and at
 * what Wisdom (Survival) DC. Defaults follow the DMG's foraging guidance
 * (abundant DC 10, limited DC 15, sparse DC 20; settlements & dungeons aren't
 * forageable). Everything is data + pure shaping so it's node-testable and the
 * GM can edit the catalog in the Resource Manager.
 */

/** Internal keys are stable; display labels are duplicated here for the UI but
 *  the canonical plain-language map lives in ui-util.js (mirrors loot types). */
const DEFAULT_ENVIRONMENTS = Object.freeze([
  Object.freeze({
    id: "abundant",
    label: "Abundant (forest, coast, grassland)",
    dc: 10,
    forageable: true,
    yieldFood: "1d6",
    yieldWater: "1d6",
  }),
  Object.freeze({
    id: "limited",
    label: "Limited (hills, farmland, woods)",
    dc: 15,
    forageable: true,
    yieldFood: "1d6",
    yieldWater: "1d6",
  }),
  Object.freeze({
    id: "sparse",
    label: "Sparse (desert, tundra, badlands)",
    dc: 20,
    forageable: true,
    yieldFood: "1d6",
    yieldWater: "1d6",
  }),
  Object.freeze({
    id: "settlement",
    label: "Settlement (buy supplies — no foraging)",
    dc: 0,
    forageable: false,
    yieldFood: "0",
    yieldWater: "0",
  }),
  Object.freeze({
    id: "underground",
    label: "Underground (dungeon — no foraging)",
    dc: 0,
    forageable: false,
    yieldFood: "0",
    yieldWater: "0",
  }),
]);

export { DEFAULT_ENVIRONMENTS };

/**
 * Bounds for formulas accepted from environment-editor drafts. Stored legacy
 * values still pass through `normalizeEnvironment` unchanged when they match
 * its historical character allow-list; these stricter limits apply to new
 * domain writes so unsafe data is reported instead of silently rewritten.
 */
export const YIELD_FORMULA_LIMITS = Object.freeze({
  maxLength: 64,
  maxTerms: 8,
  maxDicePerTerm: 20,
  maxTotalDice: 40,
  maxSides: 1000,
  maxConstant: 1000,
  maxTotalConstant: 2000,
});

export const ENVIRONMENT_ID_MAX_LENGTH = 64;
export const ENVIRONMENT_LABEL_MAX_LENGTH = 100;
export const ENVIRONMENT_DC_MAX = 100;

const EDITABLE_ENVIRONMENT_FIELDS = Object.freeze([
  "label",
  "dc",
  "forageable",
  "yieldFood",
  "yieldWater",
]);

/** Fresh, mutable copy of the defaults (mirrors getDefaultBargainTiers). */
export function getDefaultEnvironments() {
  return DEFAULT_ENVIRONMENTS.map((env) => ({ ...env }));
}

function toStr(value, fallback = "") {
  const s = String(value ?? "").trim();
  return s || fallback;
}

function toInt(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

/** Coerce a die/amount string to a safe formula string ("1d6", "0", "2"). */
function toDieString(value, fallback) {
  const s = String(value ?? "").trim();
  if (!s) return fallback;
  // Permit only digits, 'd', '+', '-', and spaces — anything else → fallback.
  return /^[0-9dD+\-\s]+$/.test(s) ? s : fallback;
}

function validationFailure(error) {
  return { ok: false, value: null, error };
}

/**
 * Validate and canonicalize a bounded yield formula without invoking Foundry's
 * Roll parser. Supported terms are positive integers or NdM dice joined by +
 * or -. A missing dice count is canonicalized to one (for example, d6 -> 1d6).
 *
 * @returns {{ok:true,value:string,error:null}|{ok:false,value:null,error:string}}
 */
export function validateYieldFormula(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return validationFailure("Enter a yield formula.");

  const compact = raw.replace(/\s+/g, "").toLowerCase();
  if (compact.length > YIELD_FORMULA_LIMITS.maxLength) {
    return validationFailure(
      `Keep the formula to ${YIELD_FORMULA_LIMITS.maxLength} characters or fewer.`,
    );
  }

  let cursor = 0;
  let termCount = 0;
  let totalDice = 0;
  let totalConstant = 0;
  let normalized = "";

  while (cursor < compact.length) {
    let sign = "";
    const signChar = compact[cursor];
    if (signChar === "+" || signChar === "-") {
      if (cursor === 0 && signChar === "-") {
        return validationFailure(
          "Yield formulas cannot start with a minus sign.",
        );
      }
      sign = signChar;
      cursor += 1;
    } else if (cursor > 0) {
      return validationFailure("Separate formula terms with + or -.");
    }

    const remaining = compact.slice(cursor);
    const diceMatch = /^(\d*)d(\d+)/.exec(remaining);
    const constantMatch = /^(\d+)/.exec(remaining);
    let token = "";

    if (diceMatch) {
      const dice = diceMatch[1] ? Number(diceMatch[1]) : 1;
      const sides = Number(diceMatch[2]);
      if (
        !Number.isSafeInteger(dice) ||
        dice < 1 ||
        dice > YIELD_FORMULA_LIMITS.maxDicePerTerm
      ) {
        return validationFailure(
          `Use 1-${YIELD_FORMULA_LIMITS.maxDicePerTerm} dice per term.`,
        );
      }
      if (
        !Number.isSafeInteger(sides) ||
        sides < 1 ||
        sides > YIELD_FORMULA_LIMITS.maxSides
      ) {
        return validationFailure(
          `Use dice with 1-${YIELD_FORMULA_LIMITS.maxSides} sides.`,
        );
      }
      totalDice += dice;
      if (totalDice > YIELD_FORMULA_LIMITS.maxTotalDice) {
        return validationFailure(
          `Use no more than ${YIELD_FORMULA_LIMITS.maxTotalDice} total dice.`,
        );
      }
      token = `${dice}d${sides}`;
      cursor += diceMatch[0].length;
    } else if (constantMatch) {
      const constant = Number(constantMatch[1]);
      if (
        !Number.isSafeInteger(constant) ||
        constant > YIELD_FORMULA_LIMITS.maxConstant
      ) {
        return validationFailure(
          `Keep each fixed amount at ${YIELD_FORMULA_LIMITS.maxConstant} or less.`,
        );
      }
      totalConstant += constant;
      if (totalConstant > YIELD_FORMULA_LIMITS.maxTotalConstant) {
        return validationFailure(
          `Keep fixed amounts within ${YIELD_FORMULA_LIMITS.maxTotalConstant} in total.`,
        );
      }
      token = String(constant);
      cursor += constantMatch[0].length;
    } else {
      return validationFailure(
        "Use whole numbers or dice such as 1d6, joined only by + or -.",
      );
    }

    termCount += 1;
    if (termCount > YIELD_FORMULA_LIMITS.maxTerms) {
      return validationFailure(
        `Use no more than ${YIELD_FORMULA_LIMITS.maxTerms} formula terms.`,
      );
    }

    const operator = normalized ? sign : sign === "+" ? "" : sign;
    normalized += `${operator}${token}`;
  }

  return { ok: true, value: normalized, error: null };
}

/**
 * Normalize one environment entry. Drops malformed entries by returning null;
 * callers filter the result. Idempotent.
 */
export function normalizeEnvironment(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = toStr(raw.id);
  if (!id) return null;
  const forageable = raw.forageable !== false;
  return {
    id,
    label: toStr(raw.label, id),
    dc: Math.max(0, toInt(raw.dc, forageable ? 15 : 0)),
    forageable,
    yieldFood: toDieString(raw.yieldFood, forageable ? "1d6" : "0"),
    yieldWater: toDieString(raw.yieldWater, forageable ? "1d6" : "0"),
  };
}

/**
 * Normalize a catalog (array). Falls back to the defaults when the input is
 * empty or every entry was malformed, so the feature is never left with zero
 * environments to choose from.
 */
export function normalizeEnvironmentCatalog(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const cleaned = [];
  const seen = new Set();
  for (const entry of list) {
    const norm = normalizeEnvironment(entry);
    if (!norm || seen.has(norm.id)) continue;
    seen.add(norm.id);
    cleaned.push(norm);
  }
  return cleaned.length > 0 ? cleaned : getDefaultEnvironments();
}

/** Whether an environment id is outside the built-in preset catalog. */
export function isCustomEnvironment(environmentOrId) {
  const id = toStr(
    environmentOrId && typeof environmentOrId === "object"
      ? environmentOrId.id
      : environmentOrId,
  );
  if (!id) return false;
  return !DEFAULT_ENVIRONMENTS.some((environment) => environment.id === id);
}

function slugifyEnvironmentId(value) {
  const source = String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (source || "custom-environment").slice(0, ENVIRONMENT_ID_MAX_LENGTH);
}

/** Build a safe, case-insensitively unique id for a custom environment. */
export function createUniqueEnvironmentId(
  catalog,
  preferredId = "custom-environment",
) {
  const used = new Set(
    (Array.isArray(catalog) ? catalog : [])
      .map((environment) => toStr(environment?.id).toLowerCase())
      .filter(Boolean),
  );
  const base = slugifyEnvironmentId(preferredId);
  if (!used.has(base.toLowerCase())) return base;

  let counter = 2;
  while (true) {
    const suffix = `-${counter}`;
    const stem = base
      .slice(0, ENVIRONMENT_ID_MAX_LENGTH - suffix.length)
      .replace(/-+$/g, "");
    const candidate = `${stem || "custom"}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
    counter += 1;
  }
}

/**
 * Validate a complete editor draft. Unlike storage normalization, this never
 * repairs invalid user input: callers receive field-keyed errors and may keep
 * the draft visible for correction.
 */
export function validateEnvironmentDraft(
  raw,
  { catalog = [], originalId = null } = {},
) {
  const errors = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      value: null,
      errors: { environment: "Environment data must be an object." },
    };
  }

  const id = toStr(raw.id);
  const originalKey = toStr(originalId).toLowerCase();
  const idKey = id.toLowerCase();
  const isExistingId = Boolean(originalKey && idKey === originalKey);
  if (!id) {
    errors.id = "Enter an environment ID.";
  } else if (
    !isExistingId &&
    (id.length > ENVIRONMENT_ID_MAX_LENGTH ||
      !/^[a-z0-9][a-z0-9_-]*$/i.test(id))
  ) {
    errors.id = `Use ${ENVIRONMENT_ID_MAX_LENGTH} or fewer letters, numbers, dashes, or underscores.`;
  } else {
    const matches = (Array.isArray(catalog) ? catalog : []).filter(
      (environment) => toStr(environment?.id).toLowerCase() === idKey,
    ).length;
    const allowedMatches = isExistingId ? 1 : 0;
    if (matches > allowedMatches) {
      errors.id = "That environment ID is already in use.";
    }
  }

  const label = toStr(raw.label);
  if (!label) errors.label = "Enter an environment name.";
  else if (label.length > ENVIRONMENT_LABEL_MAX_LENGTH) {
    errors.label = `Keep the name to ${ENVIRONMENT_LABEL_MAX_LENGTH} characters or fewer.`;
  }

  const forageable = raw.forageable;
  if (typeof forageable !== "boolean") {
    errors.forageable = "Choose whether this environment allows foraging.";
  }

  const dcText = String(raw.dc ?? "").trim();
  const dc = Number(raw.dc);
  if (
    !dcText ||
    !Number.isSafeInteger(dc) ||
    dc < 0 ||
    dc > ENVIRONMENT_DC_MAX
  ) {
    errors.dc = `Use a whole-number DC from 0 to ${ENVIRONMENT_DC_MAX}.`;
  }

  const foodFormula = validateYieldFormula(raw.yieldFood);
  if (!foodFormula.ok) errors.yieldFood = foodFormula.error;
  const waterFormula = validateYieldFormula(raw.yieldWater);
  if (!waterFormula.ok) errors.yieldWater = waterFormula.error;

  if (Object.keys(errors).length > 0) {
    return { ok: false, value: null, errors };
  }
  return {
    ok: true,
    value: {
      id,
      label,
      dc,
      forageable,
      yieldFood: foodFormula.value,
      yieldWater: waterFormula.value,
    },
    errors: {},
  };
}

function catalogOperationFailure(catalog, errors) {
  return {
    ok: false,
    catalog: Array.isArray(catalog) ? [...catalog] : [],
    environment: null,
    errors,
  };
}

/** Duplicate an existing environment into one validated custom catalog entry. */
export function duplicateEnvironment(catalog, sourceId) {
  if (!Array.isArray(catalog)) {
    return catalogOperationFailure(catalog, {
      catalog: "Environment catalog must be an array.",
    });
  }
  const sourceKey = toStr(sourceId);
  const source = catalog.find(
    (environment) => toStr(environment?.id) === sourceKey,
  );
  if (!source) {
    return catalogOperationFailure(catalog, {
      sourceId: "Choose an environment to copy.",
    });
  }

  const sourceValue = normalizeEnvironment(source);
  const copySuffix = " Copy";
  const sourceLabel = toStr(sourceValue?.label, sourceKey);
  const labelStem = sourceLabel
    .slice(0, ENVIRONMENT_LABEL_MAX_LENGTH - copySuffix.length)
    .trimEnd();
  const draft = {
    ...sourceValue,
    id: createUniqueEnvironmentId(catalog, `${sourceKey}-copy`),
    label: `${labelStem}${copySuffix}`,
  };
  const validation = validateEnvironmentDraft(draft, { catalog });
  if (!validation.ok) {
    return catalogOperationFailure(catalog, validation.errors);
  }

  return {
    ok: true,
    catalog: [...catalog, validation.value],
    environment: validation.value,
    errors: {},
  };
}

/**
 * Apply editor fields immutably and return either a fully validated catalog or
 * field-keyed errors. IDs are stable; callers create them through duplication.
 */
export function updateEnvironmentFields(catalog, environmentId, patch) {
  if (!Array.isArray(catalog)) {
    return catalogOperationFailure(catalog, {
      catalog: "Environment catalog must be an array.",
    });
  }
  const environmentKey = toStr(environmentId);
  const index = catalog.findIndex(
    (environment) => toStr(environment?.id) === environmentKey,
  );
  if (index < 0) {
    return catalogOperationFailure(catalog, {
      environmentId: "Choose an environment to update.",
    });
  }
  if (!isCustomEnvironment(catalog[index])) {
    return catalogOperationFailure(catalog, {
      environmentId: "Copy a built-in environment before editing it.",
    });
  }
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return catalogOperationFailure(catalog, {
      environment: "Environment updates must be an object.",
    });
  }

  const unsupported = Object.keys(patch).filter(
    (field) => !EDITABLE_ENVIRONMENT_FIELDS.includes(field),
  );
  if (unsupported.length > 0) {
    const errors = Object.fromEntries(
      unsupported.map((field) => [
        field,
        field === "id"
          ? "Environment IDs cannot be changed after creation."
          : "That environment field cannot be edited.",
      ]),
    );
    return catalogOperationFailure(catalog, errors);
  }

  const current = catalog[index];
  const draft = { ...current, ...patch, id: environmentKey };
  const validation = validateEnvironmentDraft(draft, {
    catalog,
    originalId: environmentKey,
  });
  if (!validation.ok) {
    return catalogOperationFailure(catalog, validation.errors);
  }

  const nextCatalog = [...catalog];
  nextCatalog[index] = validation.value;
  return {
    ok: true,
    catalog: nextCatalog,
    environment: validation.value,
    errors: {},
  };
}

/** Find an environment by id within a catalog, or null. */
export function findEnvironment(catalog, id) {
  const key = toStr(id);
  if (!key) return null;
  const list = Array.isArray(catalog) ? catalog : [];
  return list.find((env) => env?.id === key) ?? null;
}

/** Whether foraging is possible in this environment. */
export function isForageable(env) {
  return Boolean(env && env.forageable !== false);
}
