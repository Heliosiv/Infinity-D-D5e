/** Authenticated encryption for records which Foundry replicates to players.
 * Keys and decrypted records exist only in the full GM's JavaScript context.
 * There is deliberately no persistent browser key or plaintext fallback.
 */
import { isFullGM } from "./permissions.js";

const MODULE = "infinity-dnd5e";
export const VAULT_FLAG = "privateVault";
const ITERATIONS = 600000;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
let unlocked = null;
let generation = 0;
const decrypted = new Map();
const joinedEnvelopes = new WeakMap();
let testTransport = null;

export class PrivateVaultError extends Error {
  constructor(code) {
    super(`PrivateVault:${code}`);
    this.code = code;
  }
}

function requireGM() {
  if (!isFullGM()) throw new PrivateVaultError("gm-required");
}
function worldId() {
  const id = String(globalThis.game?.world?.id ?? "");
  if (!id) throw new PrivateVaultError("world-unavailable");
  return id;
}
function base64(bytes) {
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 16384) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 16384)));
  }
  return btoa(chunks.join(""));
}
function bytes(value, length = null) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new PrivateVaultError("invalid-envelope");
  }
  const binary = atob(value);
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++)
    result[index] = binary.charCodeAt(index);
  if (
    (length != null && result.length !== length) ||
    base64(result) !== value
  ) {
    throw new PrivateVaultError("invalid-envelope");
  }
  return result;
}
function parse(raw) {
  try {
    const envelope = JSON.parse(raw);
    if (envelope.version !== 1 || envelope.iterations !== ITERATIONS) {
      throw new Error();
    }
    bytes(envelope.salt, 16);
    bytes(envelope.iv, 12);
    if (bytes(envelope.data).length < 16) throw new Error();
    return envelope;
  } catch {
    throw new PrivateVaultError("invalid-envelope");
  }
}
function rawVault(document) {
  const wire = document?.getFlag?.(MODULE, VAULT_FLAG);
  if (
    !wire ||
    typeof wire !== "object" ||
    wire.version !== 1 ||
    !Array.isArray(wire.chunks)
  )
    return wire;
  if (
    !wire.chunks.length ||
    !wire.chunks.every(
      (chunk) =>
        typeof chunk === "string" && chunk.length > 0 && chunk.length <= 8192,
    )
  )
    return wire;
  const previous = joinedEnvelopes.get(wire);
  if (
    previous &&
    previous.chunks.length === wire.chunks.length &&
    previous.chunks.every((chunk, index) => chunk === wire.chunks[index])
  )
    return previous.raw;
  const raw = wire.chunks.join("");
  joinedEnvelopes.set(wire, { chunks: [...wire.chunks], raw });
  return raw;
}
function context(documentId, field = null) {
  return encoder.encode(
    JSON.stringify([
      MODULE,
      "private-vault",
      1,
      worldId(),
      String(documentId),
      ...(field == null ? [] : [field]),
    ]),
  );
}
function cacheKey(document) {
  return JSON.stringify([
    worldId(),
    String(document.id),
    document.field ?? null,
  ]);
}
function cached(document, raw) {
  return decrypted.get(cacheKey(document))?.get(raw);
}
function remember(document, raw, payload) {
  const id = cacheKey(document);
  const entries = decrypted.get(id) ?? new Map();
  entries.set(raw, structuredClone(payload));
  // Keep the current and prepared-next envelope per document. In particular,
  // do not concatenate multi-megabyte ciphertext into a fresh key on every read.
  const wire = rawVault(document.vaultSource ?? document);
  const active = document.field == null ? wire : wire?.fields?.[document.field];
  while (entries.size > 2) {
    const expired = [...entries.keys()].find(
      (entry) => entry !== active && entry !== raw,
    );
    entries.delete(expired);
  }
  decrypted.set(id, entries);
}
function requireUnlocked() {
  requireGM();
  if (
    !unlocked ||
    unlocked.world !== worldId() ||
    unlocked.user !== String(game.user.id)
  ) {
    throw new PrivateVaultError("locked");
  }
  return unlocked;
}
export function lockPrivateVault() {
  generation += 1;
  unlocked = null;
  decrypted.clear();
}
export function isPrivateVaultUnlocked() {
  if (testTransport) return true;
  try {
    requireUnlocked();
    return true;
  } catch {
    return false;
  }
}
export function hasEncryptedPrivateVault(document) {
  return (
    Boolean(testTransport) ||
    document?.getFlag?.(MODULE, VAULT_FLAG) !== undefined
  );
}
export function hasUnencryptedPrivateFlags(document, keys) {
  return (
    !testTransport &&
    keys.some((key) => document?.getFlag?.(MODULE, key) !== undefined)
  );
}
function fieldDocument(document, field) {
  return {
    id: document.id,
    field,
    vaultSource: document.vaultSource ?? document,
  };
}
function wireSnapshot(document) {
  return JSON.stringify(document?.getFlag?.(MODULE, VAULT_FLAG));
}
function records(document) {
  const wire = rawVault(document);
  if (wire?.version !== 2) return [{ document, raw: wire }];
  bytes(wire.salt, 16);
  if (
    !wire.fields ||
    typeof wire.fields !== "object" ||
    Array.isArray(wire.fields) ||
    typeof wire.fields.$check !== "string"
  )
    throw new PrivateVaultError("invalid-envelope");
  if (unlocked && wire.salt !== unlocked.salt)
    throw new PrivateVaultError("different-key");
  return Object.entries(wire.fields).map(([field, raw]) => {
    if (
      typeof raw !== "string" ||
      !/^([a-zA-Z][a-zA-Z0-9]{0,79}|\$check)$/.test(field)
    )
      throw new PrivateVaultError("invalid-envelope");
    return { document: fieldDocument(document, field), raw };
  });
}
export function privateVaultDocumentReady(document) {
  if (testTransport) return true;
  if (!isPrivateVaultUnlocked()) return false;
  if (!hasEncryptedPrivateVault(document)) return true;
  try {
    return records(document).every((record) =>
      Boolean(cached(record.document, record.raw)),
    );
  } catch {
    return false;
  }
}
export function readPrivateFlag(document, key) {
  if (testTransport) return document?.getFlag?.(MODULE, key);
  if (!isPrivateVaultUnlocked()) return undefined;
  const raw = rawVault(document);
  if (raw === undefined) return document?.getFlag?.(MODULE, key);
  if (raw?.version === 2) {
    if (raw.salt !== unlocked.salt) return undefined;
    return structuredClone(
      cached(fieldDocument(document, key), raw.fields?.[key])?.value,
    );
  }
  return structuredClone(cached(document, raw)?.[key]);
}
async function derive(passphrase, salt) {
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: bytes(salt, 16),
      iterations: ITERATIONS,
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
async function decrypt(document, raw, state) {
  const envelope = parse(raw);
  if (envelope.salt !== state.salt)
    throw new PrivateVaultError("different-key");
  try {
    const clear = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytes(envelope.iv, 12),
        additionalData: context(document.id, document.field),
        tagLength: 128,
      },
      state.key,
      bytes(envelope.data),
    );
    const payload = JSON.parse(decoder.decode(clear));
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new Error();
    return payload;
  } catch {
    throw new PrivateVaultError("authentication-failed");
  }
}

/** No mutation until every encrypted candidate authenticates with this key. */
export async function unlockPrivateVault(passphrase, documents = []) {
  requireGM();
  if (!globalThis.crypto?.subtle)
    throw new PrivateVaultError("secure-context-required");
  if (typeof passphrase !== "string" || passphrase.length < 16)
    throw new PrivateVaultError("passphrase-too-short");
  lockPrivateVault();
  const epoch = generation;
  const encrypted = documents.filter(hasEncryptedPrivateVault);
  const first = encrypted.length ? rawVault(encrypted[0]) : null;
  const salt = first
    ? first.version === 2
      ? first.salt
      : parse(first).salt
    : base64(crypto.getRandomValues(new Uint8Array(16)));
  bytes(salt, 16);
  const state = {
    key: await derive(passphrase, salt),
    salt,
    world: worldId(),
    user: String(game.user.id),
  };
  const values = [];
  const snapshots = encrypted.map((document) => [
    document,
    wireSnapshot(document),
  ]);
  for (const document of encrypted) {
    for (const record of records(document))
      values.push([
        record.document,
        record.raw,
        await decrypt(record.document, record.raw, state),
      ]);
  }
  requireGM();
  if (
    epoch !== generation ||
    state.world !== worldId() ||
    state.user !== String(game.user.id)
  )
    throw new PrivateVaultError("session-changed");
  // A concurrent change during unlock must be authenticated on a new attempt.
  if (
    snapshots.some(
      ([document, snapshot]) => wireSnapshot(document) !== snapshot,
    )
  )
    throw new PrivateVaultError("changed-during-unlock");
  unlocked = state;
  for (const [document, raw, payload] of values)
    remember(document, raw, payload);
  return true;
}

export async function preparePrivateVaultDocument(document) {
  if (testTransport || !hasEncryptedPrivateVault(document)) return;
  const state = requireUnlocked();
  const snapshot = wireSnapshot(document);
  const epoch = generation;
  const prepared = [];
  for (const record of records(document)) {
    if (cached(record.document, record.raw)) continue;
    prepared.push([
      record.document,
      record.raw,
      await decrypt(record.document, record.raw, state),
    ]);
  }
  requireGM();
  if (epoch !== generation || state !== unlocked)
    throw new PrivateVaultError("session-changed");
  if (snapshot !== wireSnapshot(document)) return false;
  for (const [scope, raw, payload] of prepared) remember(scope, raw, payload);
  return true;
}

async function sealFields(document, values) {
  const fields = {
    $check: await seal(fieldDocument(document, "$check"), {
      value: "Infinity private vault 2",
    }),
  };
  for (const [key, value] of Object.entries(values))
    fields[key] = await seal(fieldDocument(document, key), { value });
  return { version: 2, salt: requireUnlocked().salt, fields };
}

async function seal(document, payload) {
  const state = requireUnlocked();
  const epoch = generation;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: context(document.id, document.field),
      tagLength: 128,
    },
    state.key,
    encoder.encode(JSON.stringify(payload)),
  );
  if (epoch !== generation || state !== unlocked)
    throw new PrivateVaultError("session-changed");
  requireUnlocked();
  const raw = JSON.stringify({
    version: 1,
    iterations: ITERATIONS,
    salt: state.salt,
    iv: base64(iv),
    data: base64(new Uint8Array(data)),
  });
  // Verify the exact envelope before it can replace any legacy data.
  const verified = await decrypt(document, raw, state);
  if (JSON.stringify(verified) !== JSON.stringify(payload))
    throw new PrivateVaultError("verification-failed");
  if (epoch !== generation || state !== unlocked)
    throw new PrivateVaultError("session-changed");
  requireUnlocked();
  remember(document, raw, verified);
  return raw;
}

/** Atomic encrypted replacement plus removal of legacy flag values. */
export async function writePrivateVaultDocument(
  document,
  values,
  keys,
  { metadata = {}, isCurrent = () => true, beforeCommit = () => true } = {},
) {
  if (testTransport) return testTransport.write(document, values, metadata);
  requireUnlocked();
  const prior = wireSnapshot(document);
  const source = JSON.stringify(
    keys.map((key) => document.getFlag(MODULE, key)),
  );
  const previous = rawVault(document);
  const update = { ...metadata };
  let expected;
  if (previous?.version === 2) {
    expected = { ...previous, fields: { ...previous.fields } };
    for (const [key, value] of Object.entries(values)) {
      if (
        JSON.stringify(readPrivateFlag(document, key)) === JSON.stringify(value)
      )
        continue;
      const raw = await seal(fieldDocument(document, key), { value });
      expected.fields[key] = raw;
      update[`flags.${MODULE}.${VAULT_FLAG}.fields.${key}`] = raw;
    }
  } else {
    expected = await sealFields(document, values);
    update[`flags.${MODULE}.${VAULT_FLAG}`] = {
      ...expected,
      ...Object.fromEntries(
        Object.keys(previous && typeof previous === "object" ? previous : {})
          .filter((key) => !Object.hasOwn(expected, key))
          .map((key) => [`-=${key}`, null]),
      ),
    };
  }
  for (const key of keys)
    if (document.getFlag(MODULE, key) !== undefined)
      update[`flags.${MODULE}.-=${key}`] = null;
  if (
    !isCurrent() ||
    !beforeCommit() ||
    prior !== wireSnapshot(document) ||
    source !== JSON.stringify(keys.map((key) => document.getFlag(MODULE, key)))
  )
    throw new PrivateVaultError("write-fence-changed");
  requireUnlocked();
  if (Object.keys(update).length) await document.update(update);
  if (
    !isCurrent() ||
    wireSnapshot(document) !== JSON.stringify(expected) ||
    keys.some((key) => document.getFlag(MODULE, key) !== undefined)
  )
    throw new PrivateVaultError("readback-failed");
  await preparePrivateVaultDocument(document);
}

export async function createPrivateVaultDocument(
  data,
  values,
  keys,
  isCurrent = () => true,
) {
  if (testTransport)
    return JournalEntry.create(
      {
        ...data,
        flags: {
          ...data.flags,
          [MODULE]: { ...data.flags[MODULE], ...values },
        },
      },
      { renderSheet: false },
    );
  requireUnlocked();
  const id = globalThis.foundry.utils.randomID();
  const raw = await sealFields({ id }, values);
  requireUnlocked();
  if (!isCurrent()) throw new PrivateVaultError("write-fence-changed");
  const document = await JournalEntry.create(
    {
      ...data,
      _id: id,
      flags: {
        ...data.flags,
        [MODULE]: { ...data.flags[MODULE], [VAULT_FLAG]: raw },
      },
    },
    { renderSheet: false, keepId: true },
  );
  if (
    document?.id !== id ||
    wireSnapshot(document) !== JSON.stringify(raw) ||
    keys.some((key) => document.getFlag(MODULE, key) !== undefined)
  )
    throw new PrivateVaultError("readback-failed");
  return document;
}

/** Explicit dependency injection for pre-existing lifecycle/business unit tests.
 * Browser code cannot enable this. Crypto and native tests use the real transport.
 */
export function configurePrivateVaultTransportForTests(transport) {
  if (globalThis.process?.release?.name !== "node")
    throw new Error("TestTransportUnavailable");
  testTransport = transport;
}
