# Campaign record storage

Infinity D&D5e stores merchant records and transaction recovery, unrevealed
factions, party-resource configuration, injury workflows, downtime rules,
checkpoints, Research Seeds, and hunting state in a restricted JournalEntry.
GM-only controls and permission-scoped player projections remain unchanged.

## Trusted-table access

Campaign records now open automatically for every full GM. There is no first-run
passphrase, password-manager step, refresh unlock, or requirement to disconnect
players before migrating older readable records. A second GM tab still follows
the existing single-tab write-leadership rules.

The store retains authenticated AES-GCM envelopes and verified writes so the
existing durable storage and tamper checks do not need to be replaced. Its key is
derived automatically from public module code and the world ID. This is a
trusted-table convenience layer, not protection from an authenticated player who
deliberately inspects Foundry data or module code. Foundry 13.351 replicates raw
restricted-Journal flags to player browsers even when ownership is set to NONE.

Players continue to receive only the module's intended safe projections through
normal UI and socket APIs. The relaxed boundary matters only to someone using
browser developer tools or another script to inspect or decode replicated data.

## Existing custom-passphrase worlds

The v0.3.37 and v0.3.38 releases used a custom GM passphrase. A world that already
completed that setup cannot be opened with the new automatic key. The module
therefore shows **Unlock legacy campaign records** for that world and accepts its
existing passphrase without replacing data. Keep the matching world backup and
passphrase until those legacy records have been migrated by a future explicit
conversion tool.

A wrong legacy passphrase, altered ciphertext, or unavailable key leaves stored
records intact and campaign services unavailable. These conditions never create
an empty replacement store.

## Recovery and rollback

Back up the world before installing source changes. If a saved record is damaged,
retain the damaged world for investigation and restore a known-good complete
world backup with its matching module version. Installing an older module alone
does not undo record migrations or later currency, inventory, injury, resource,
or downtime changes.

World and Journal IDs remain part of envelope authentication. Renaming a world ID
or copying a campaign-record Journal to another document ID can invalidate an
existing envelope.

## Technical boundary

The envelope uses Web Crypto AES-256-GCM, a fresh random nonce on every write,
PBKDF2-HMAC-SHA-256, a random salt, and world/document/field binding. Related
fields are replaced in one Journal update, unchanged fields are not retransmitted,
and modified envelopes fail authentication before a campaign write.

Those properties detect accidental corruption and unsanctioned envelope changes,
but the automatic key is reproducible by any authenticated player with the module
source and world ID. Previously received plaintext, backups, chat receipts, and
separately authored public documents are also outside the store's controls.

## Verification

`node scripts/test-private-vault.mjs` exercises automatic trusted-table opening,
reload, authenticated writes, tampering, world/document binding, role and write
fences, old settings, duplicate recovery copies, and the legacy custom-passphrase
boundary. Existing business tests inject an in-memory transport and do not by
themselves establish player privacy.

For the isolated localhost world named `downtime-gauntlet`, the Foundry journey
commands remain:

```powershell
npm run ui:audit:vault:foundry -- --test-world=downtime-gauntlet
npm run ui:audit:downtime:foundry -- --test-world downtime-gauntlet
```

These commands can write synthetic records and must not be run against a campaign
world. Publication does not install or migrate an existing Forge world.

## Private downtime continuity

Schema 9 stores hunting rules/random seeds and Research libraries, cases, and
follow-ups with the world. Older browser-local records still require the reviewed
**Import saved browser records** action in Downtime; automatic record access does
not silently import them. See the [continuity and import guide](DOWNTIME_CONTINUITY.md).
