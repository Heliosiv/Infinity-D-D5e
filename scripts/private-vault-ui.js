import { isFullGM } from "./permissions.js";
import { promptInfinityDialog } from "./dialog-contract.js";
import {
  hasEncryptedPrivateVault,
  isPrivateVaultUnlocked,
  unlockPrivateVault,
} from "./private-vault.js";
import {
  getPrivateStateStatus,
  resumePrivateStateAfterVaultUnlock,
} from "./private-state.js";

let opening = null;

/** The passphrase never leaves this browser or enters a world setting. */
export function openPrivateVault() {
  if (!isFullGM()) return null;
  if (opening) return opening;
  if (isPrivateVaultUnlocked() && getPrivateStateStatus().state === "ready") {
    return Promise.resolve(true);
  }
  const documents = [...game.journal].filter(
    (entry) => entry.getFlag("infinity-dnd5e", "privateStateStore") === true,
  );
  const setup = !documents.some(hasEncryptedPrivateVault);
  opening = promptInfinityDialog({
    id: "infinity-private-vault",
    window: {
      title: setup ? "Protect campaign records" : "Unlock campaign records",
    },
    position: { width: 480 },
    content: `<p>Hidden campaign records are encrypted with your GM vault passphrase. Enter it locally whenever you open or refresh this GM tab. Share it only with trusted full GMs.</p>
      ${setup ? "<p>Choose a unique passphrase of at least 16 characters (several random words). Save it in a password manager: forgotten passphrases cannot be recovered.</p>" : ""}
      <p>For an existing world, back up the world and disconnect players before the first migration. Previous plaintext copies and old backups are not made private retroactively.</p>
      <div class="form-group"><label for="infinity-vault-passphrase">Vault passphrase</label><input id="infinity-vault-passphrase" name="vaultPassphrase" type="password" minlength="16" required autocomplete="${setup ? "new-password" : "current-password"}"></div>
      ${setup ? '<div class="form-group"><label for="infinity-vault-confirm">Confirm passphrase</label><input id="infinity-vault-confirm" name="vaultConfirm" type="password" minlength="16" required autocomplete="new-password"></div><div class="form-group"><label for="infinity-vault-saved">I saved the passphrase securely and backed up any existing world.</label><input id="infinity-vault-saved" name="vaultSaved" type="checkbox" required></div>' : ""}
      <p>Closing this window leaves campaign tools locked. Press <kbd>Shift+I</kbd> to return.</p>`,
    ok: {
      label: setup ? "Protect and unlock" : "Unlock",
      callback: async (_event, button) => {
        const form = button.form;
        const input = form.elements.vaultPassphrase;
        const confirmation = form.elements.vaultConfirm;
        if (
          setup &&
          (!form.elements.vaultSaved.checked ||
            input.value !== confirmation.value)
        ) {
          ui.notifications.error(
            "Passphrases must match and the recovery acknowledgement must be checked. Press Shift+I to try again.",
          );
          input.value = "";
          if (confirmation) confirmation.value = "";
          return false;
        }
        try {
          await unlockPrivateVault(input.value, documents);
          const ready = await resumePrivateStateAfterVaultUnlock();
          if (!ready) {
            const status = getPrivateStateStatus();
            ui.notifications.error(
              status.code === "vault-migration-players-connected"
                ? "Disconnect players before migrating existing records, then press Shift+I to unlock again."
                : "The vault key was accepted, but campaign records need review. Press Shift+I to continue. No empty replacement was created.",
            );
          } else
            ui.notifications.info(
              "Campaign records are protected and unlocked in this tab.",
            );
          return ready;
        } catch {
          ui.notifications.error(
            "The vault could not finish unlocking or migrating. Check the passphrase and saved vault, keep the world backup, and press Shift+I to retry.",
          );
          return false;
        } finally {
          input.value = "";
          if (confirmation) confirmation.value = "";
        }
      },
    },
  }).finally(() => {
    opening = null;
  });
  return opening;
}
