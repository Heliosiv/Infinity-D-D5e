# GM vault

Version 0.3.37 encrypts merchant records and transaction recovery, unrevealed
factions, party-resource configuration and automation state, injury workflows,
downtime configuration, workflows, checkpoints, and recovery fingerprints before saving them to
Foundry. Hiding a Journal was insufficient: Foundry 13.351 sends its raw flags
to player browsers. The new Journal payload is authenticated ciphertext.

## First setup

1. Back up the world before updating. Keep that backup private; it contains the
   old readable records. Stop using older GM tabs and disconnect players.
2. Open the updated world as a full GM. Press **Shift+I** if the vault dialog is
   not already open. Choose a unique passphrase of at least 16 characters;
   several randomly chosen words are preferable to a short predictable phrase.
3. Save the passphrase in a password manager and confirm it in the dialog.
   Share it securely with other trusted full GMs, never in a player-visible
   journal, world setting, chat, or macro.
4. Select **Protect and unlock**. The migration preserves canonical records,
   seals duplicate recovery copies, verifies the result, and clears legacy
   plaintext flags and migrated settings. Players must be disconnected while
   existing readable records are migrated. Resolve any reported problem before
   inviting them back.

Each GM enters the same passphrase after opening or refreshing a browser tab.
The key is kept only in that tab's memory; it is not saved in browser storage,
world settings, Journal flags, sockets, or the module package. Closing the
dialog leaves campaign services locked. **Shift+I** or the module API
`game.modules.get("infinity-dnd5e").api.openPrivateVault()` opens it again.
The passphrase is entered in the dialog, not passed to a console command.

Normal player actions, GM approval, and record recovery remain the same after
unlock. A second GM tab needs its own unlock and retains the existing single-tab
write-leadership rules. The vault does not make a second tab a writer.

## Recovery and rollback

A wrong passphrase, altered ciphertext, or an unavailable key must leave the
stored records intact and campaign services unavailable. These conditions must
never suggest or automatically create an empty replacement world store.
Verify the passphrase first. If a saved record is damaged, retain the damaged
world for investigation and restore a known-good world backup with its matching
passphrase. Keep both a tested world backup and the passphrase securely.

There is no forgotten-passphrase reset that preserves encrypted data. Module
authors and Foundry administrators cannot reconstruct it. Passphrase rotation
is not provided in this release.

The private-store schema advances to 8. Older module versions must not operate
on the migrated store. To roll back across this migration, restore the complete
pre-migration world backup together with the previous module package while the
server is stopped. Reinstalling the old module alone does not undo the migration
or any later currency, inventory, or activity changes.

## Protection and limits

The envelope uses Web Crypto AES-256-GCM with a fresh random 96-bit nonce on
every write. A non-extractable key is derived with PBKDF2-HMAC-SHA-256, 600,000
iterations, and a random 128-bit salt. Authentication binds the ciphertext to
the module, envelope version, world ID, and Journal ID. Each field is authenticated separately, including its field name. Related fields
are replaced in one atomic Journal update; unmodified encrypted fields are
preserved and are not retransmitted. Wrong keys and modified
envelopes fail authentication before any campaign write. Use HTTPS or localhost;
ordinary insecure HTTP origins may not provide Web Crypto.

Players can still observe the encrypted Journal's existence, size, and update
timing, and the safe projections intentionally sent to them. A weak passphrase
can be guessed offline from ciphertext. Previously received plaintext, old
backups, chat receipts, and separately authored public documents are not erased
by this migration. Trusted full GMs and scripts running in an unlocked GM's
browser can access its decrypted records. This does not defend against a
compromised GM device, malicious module code, or a server that alters the code
delivered to the GM. Existing cross-device write-concurrency limits also remain.

Renaming a world ID or copying an encrypted Journal to a different ID invalidates
authentication. Restore backups under their original world and document IDs.

## Verification

`node scripts/test-private-vault.mjs` exercises the real encrypted transport and
private-state lifecycle: plaintext-free writes, wrong keys, ciphertext tampering,
world/document binding, role and write fences, preservation of old settings and
duplicate recovery copies, locked recovery, and durable unlock after reload.
Existing business and lifecycle tests explicitly inject an in-memory transport;
they do not claim to verify encryption.

For an isolated localhost Foundry world named `downtime-gauntlet`, run:

```powershell
npm run ui:audit:vault:foundry -- --test-world=downtime-gauntlet
npm run ui:audit:downtime:foundry -- --test-world downtime-gauntlet
```

The synthetic passphrase in the test helper is public and is only for that
disposable world. Never use it in a real campaign. The transport audit uses
separate GM/player browser contexts, captures player WebSocket frames, and
inspects raw records, initial data, settings, and browser storage rather than
relying on the module's sanitized getters. Publication does not install or
migrate an existing Forge world.
