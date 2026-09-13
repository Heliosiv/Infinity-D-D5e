/** Encrypted, authority-fenced hunting/research records and additive legacy import. */
import { getPrivateState, setPrivateState } from "../private-state.js";
import { isFullGM } from "../permissions.js";
import { isAuthoritativeGM } from "../socket-authority.js";
import { persistedValuesEqual } from "../utils/persisted-data.js";

const KEY = "downtimeSecrets";
let writes = Promise.resolve();
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const empty = () => ({
  version: 1,
  hunting: { version: 1, regions: {}, blocks: {} },
  research: { version: 1, seeds: [], blocks: {} },
  imports: {},
});

function requireGM() {
  if (!isFullGM())
    throw Error("Only a full GM can access private downtime records.");
}
function validateFamily(family, data) {
  if (
    !object(data) ||
    data.version !== 1 ||
    !object(data.blocks) ||
    (family === "hunting" ? !object(data.regions) : !Array.isArray(data.seeds))
  )
    throw Error(`The saved ${family} records need GM recovery.`);
  const invalidId = (id) =>
    !id || ["__proto__", "prototype", "constructor"].includes(id);
  if (Object.keys(data.blocks).some(invalidId))
    throw Error(`Invalid ${family} record identity.`);
  for (const block of Object.values(data.blocks)) {
    const valid =
      family === "hunting"
        ? object(block) &&
          object(block.region) &&
          typeof block.seed === "string" &&
          block.seed.length > 0
        : object(block) &&
          typeof block.secret === "string" &&
          block.secret.length > 0 &&
          object(block.cases);
    if (!valid) throw Error(`The saved ${family} block needs GM recovery.`);
  }
  if (
    family === "research" &&
    data.seeds.some(
      (seed) =>
        !object(seed) || typeof seed.id !== "string" || invalidId(seed.id),
    )
  )
    throw Error("Invalid Research Seed identity.");
  return data;
}
function read() {
  requireGM();
  let raw = getPrivateState(KEY);
  if (raw === undefined) {
    if (globalThis.JournalEntry?.create)
      throw Error("Unlock the private vault before using hunting or research.");
    // Matches the repository's isolated Node-test transport. Never used in Foundry.
    raw = globalThis.game?.settings?.get?.("infinity-dnd5e", KEY) ?? {};
  }
  if (object(raw) && Object.keys(raw).length === 0) return empty();
  if (!object(raw) || raw.version !== 1 || !object(raw.imports))
    throw Error("Private downtime records need GM recovery.");
  validateFamily("hunting", raw.hunting);
  validateFamily("research", raw.research);
  return structuredClone(raw);
}
export function readPrivateDowntimeFamily(family) {
  if (!["hunting", "research"].includes(family))
    throw Error("Unknown private downtime family.");
  return structuredClone(read()[family]);
}
function update(mutator, guard = () => true) {
  const operation = writes.then(async () => {
    requireGM();
    if (!isAuthoritativeGM())
      throw Error(
        "Only the active full GM can change private downtime records.",
      );
    const before = read();
    const after = structuredClone(before);
    const result = await mutator(after);
    if (!persistedValuesEqual(before, after)) {
      await setPrivateState(KEY, after, {
        beforeWrite: () =>
          guard() &&
          isFullGM() &&
          isAuthoritativeGM() &&
          persistedValuesEqual(read(), before),
      });
      if (!persistedValuesEqual(read(), after))
        throw Error(
          "Private downtime write needs recovery; refresh before retrying.",
        );
    }
    return structuredClone(result);
  });
  writes = operation.catch(() => {});
  return operation;
}
export function updatePrivateDowntimeFamily(family, mutator) {
  if (!["hunting", "research"].includes(family))
    throw Error("Unknown private downtime family.");
  return update((data) => mutator(data[family]));
}

function legacySources() {
  requireGM();
  const world = String(globalThis.game?.world?.id ?? "");
  const user = String(globalThis.game?.user?.id ?? "");
  if (!world || !user)
    throw Error("The current world and GM must be available.");
  return Object.fromEntries(
    ["hunting", "research"].map((family) => {
      const key = `infinity-dnd5e.${family}.v1.${world}.${user}`;
      const raw = globalThis.localStorage?.getItem(key) ?? null;
      let value = null;
      if (raw !== null) {
        try {
          value = JSON.parse(raw);
        } catch {
          throw Error(`The browser's ${family} records need GM recovery.`);
        }
        validateFamily(family, value);
      }
      return [family, { key, raw, value }];
    }),
  );
}
async function hash(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
async function planImport(before, sources) {
  const after = structuredClone(before);
  const counts = {
    huntingAreas: 0,
    hunts: 0,
    researchSeeds: 0,
    researchBlocks: 0,
  };
  const conflicts = [];
  const copyEntries = (target, entries, label, counter) => {
    for (const [id, value] of entries) {
      if (!id || ["__proto__", "prototype", "constructor"].includes(id))
        throw Error("Invalid legacy record identity.");
      if (Object.hasOwn(target, id)) {
        if (!persistedValuesEqual(target[id], value))
          conflicts.push(`${label}: ${id}`);
      } else {
        target[id] = structuredClone(value);
        counts[counter]++;
      }
    }
  };
  for (const [family, source] of Object.entries(sources)) {
    if (source.raw === null) continue;
    const digest = await hash(source.raw);
    // A preserved old browser copy must never resurrect deleted or edited records.
    if (after.imports[source.key] === digest) continue;
    if (Object.hasOwn(after.imports, source.key)) {
      conflicts.push(`${family}: this browser copy changed after import`);
      continue;
    }
    if (family === "hunting") {
      copyEntries(
        after.hunting.regions,
        Object.entries(source.value.regions),
        "Hunting area",
        "huntingAreas",
      );
      copyEntries(
        after.hunting.blocks,
        Object.entries(source.value.blocks),
        "Hunt",
        "hunts",
      );
    } else {
      const seeds = Object.fromEntries(
        after.research.seeds.map((seed) => [seed.id, seed]),
      );
      const ids = source.value.seeds.map((seed) => seed?.id);
      if (new Set(ids).size !== ids.length)
        throw Error(
          "Duplicate legacy Research Seed identities need GM recovery.",
        );
      copyEntries(
        seeds,
        source.value.seeds.map((seed) => [seed?.id, seed]),
        "Research Seed",
        "researchSeeds",
      );
      if (Object.keys(seeds).length > 200)
        throw Error("Import exceeds the Research Seed library limit.");
      after.research.seeds = Object.values(seeds);
      copyEntries(
        after.research.blocks,
        Object.entries(source.value.blocks),
        "Research block",
        "researchBlocks",
      );
    }
    after.imports[source.key] = digest;
  }
  return {
    after,
    counts,
    conflicts,
    fingerprint: await hash({ before, sources }),
  };
}
export async function previewPrivateDowntimeImport() {
  const { counts, conflicts, fingerprint } = await planImport(
    read(),
    legacySources(),
  );
  return { counts, conflicts, fingerprint };
}
export function applyPrivateDowntimeImport({ fingerprint } = {}) {
  let reviewedSources;
  return update(
    async (data) => {
      const sources = legacySources();
      reviewedSources = sources;
      const plan = await planImport(data, sources);
      if (!fingerprint || plan.fingerprint !== fingerprint)
        throw Error("Saved records changed. Preview the import again.");
      if (plan.conflicts.length)
        throw Error(
          "Conflicting saved records need GM recovery. Nothing was imported.",
        );
      if (!persistedValuesEqual(legacySources(), sources))
        throw Error("Browser records changed. Preview the import again.");
      Object.assign(data, plan.after);
      return { counts: plan.counts, preservedBrowserCopies: true };
    },
    () => persistedValuesEqual(legacySources(), reviewedSources),
  );
}
