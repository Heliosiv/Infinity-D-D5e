/** Existing business/lifecycle suites use a synchronous in-memory transport.
 * Encryption, migration, and wire confidentiality have separate real-transport
 * and installed Foundry integration suites. Never import this in runtime code.
 */
import { configurePrivateVaultTransportForTests } from "../private-vault.js";

function replacement(prior, next) {
  if (!next || typeof next !== "object" || Array.isArray(next)) return next;
  const old =
    prior && typeof prior === "object" && !Array.isArray(prior) ? prior : {};
  return Object.fromEntries([
    ...Object.entries(next).map(([key, value]) => [
      key,
      replacement(old[key], value),
    ]),
    ...Object.keys(old)
      .filter((key) => !Object.hasOwn(next, key))
      .map((key) => [`-=${key}`, null]),
  ]);
}
configurePrivateVaultTransportForTests({
  write: (document, values, metadata) =>
    document.update({
      ...metadata,
      ...Object.fromEntries(
        Object.entries(values)
          .filter(
            ([key, value]) =>
              JSON.stringify(document.getFlag("infinity-dnd5e", key)) !==
              JSON.stringify(value),
          )
          .map(([key, value]) => [
            `flags.infinity-dnd5e.${key}`,
            replacement(document.getFlag("infinity-dnd5e", key), value),
          ]),
      ),
    }),
});
