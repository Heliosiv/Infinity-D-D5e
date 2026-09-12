# Infinity D&D5e v0.3.37

Hidden campaign records now use an encrypted GM vault. This closes the previous
exposure of raw downtime and other private-state flags to connected players
after the world has completed migration. Related changes remain atomic, while
unchanged encrypted fields are preserved instead of resent.

**Before updating an existing world:** back it up, close older GM tabs, and
disconnect players. As a full GM, use **Shift+I** to create and securely save a
vault passphrase, then complete **Protect and unlock**. Each full GM needs that
passphrase after opening or refreshing a tab. Forgotten passphrases cannot be
recovered. Old backups and previously received plaintext are not protected
retroactively. Use HTTPS or localhost for Web Crypto.

See [vault setup, recovery, and limitations](https://github.com/Heliosiv/Infinity-D-D5e/blob/v0.3.37/docs/PRIVATE_VAULT.md).

This release also includes:

- The Plague Scholar theme: warm manuscripts, undead anatomical marginalia,
  worn bindings, brass details, and original locally bundled interface assets.
- More stable settings and activity drafts, cursor and scroll preservation,
  searchable pickers, and clearer narrow-screen shop controls.
- Craft Field Ammunition, plus the reconciled hunting, crafting, training, and
  journal improvements from the release candidate.

The vault advances private storage to schema 8. To roll back after migration,
stop the server and restore the complete pre-migration world backup together
with the earlier module package. Reinstalling an older module alone cannot
read the new vault and does not undo subsequent campaign transactions.

Publication provides the package and update manifest. It does not install or
migrate a live Forge world.
