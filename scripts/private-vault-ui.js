import { isFullGM } from "./permissions.js";
import { promptInfinityDialog } from "./dialog-contract.js";
import {
  hasEncryptedPrivateVault,
  isPrivateVaultUnlocked,
  unlockTrustedTableRecords,
  unlockPrivateVault,
} from "./private-vault.js";
import {
  getPrivateStateStatus,
  resumePrivateStateAfterVaultUnlock,
} from "./private-state.js";

let opening = null;

/** Automatically opens trusted-table records; prompts only for a legacy key. */
export function openPrivateVault() {
  if (!isFullGM()) return null;
  if (opening) return opening;
  opening = openCampaignRecords().finally(() => {
    opening = null;
  });
  return opening;
}

async function openCampaignRecords() {
  if (isPrivateVaultUnlocked() && getPrivateStateStatus().state === "ready") {
    return true;
  }
  const documents = [...game.journal].filter(
    (entry) => entry.getFlag("infinity-dnd5e", "privateStateStore") === true,
  );
  try {
    await unlockTrustedTableRecords(documents);
    return await resumePrivateStateAfterVaultUnlock();
  } catch {
    // A pre-existing custom-passphrase vault cannot be opened with the new
    // trusted-table key. Keep a focused legacy path so those records are never
    // replaced or stranded.
  }
  const legacy = documents.some(hasEncryptedPrivateVault);
  if (!legacy) return false;
  return promptInfinityDialog({
    id: "infinity-private-vault",
    window: {
      title: "Unlock legacy campaign records",
    },
    position: { width: 480 },
    content: `<p>This world already contains campaign records protected by the older custom-passphrase system. Enter that existing passphrase to open them without replacing any data.</p>
      <div class="form-group"><label for="infinity-vault-passphrase">Previous vault passphrase</label><input id="infinity-vault-passphrase" name="vaultPassphrase" type="password" minlength="16" required autocomplete="current-password"></div>
      <p>New trusted-table worlds do not ask for a passphrase. Closing this window leaves these legacy records locked. Press <kbd>Shift+I</kbd> to return.</p>`,
    ok: {
      label: "Unlock legacy records",
      callback: async (_event, button) => {
        const form = button.form;
        const input = form.elements.vaultPassphrase;
        try {
          await unlockPrivateVault(input.value, documents);
          const ready = await resumePrivateStateAfterVaultUnlock();
          if (!ready) {
            ui.notifications.error(
              "The legacy key was accepted, but campaign records need review. Press Shift+I to continue. No empty replacement was created.",
            );
          } else
            ui.notifications.info(
              "Legacy campaign records are unlocked in this tab.",
            );
          return ready;
        } catch {
          ui.notifications.error(
            "The legacy records could not be unlocked. Check the previous passphrase, keep the world backup, and press Shift+I to retry.",
          );
          return false;
        } finally {
          input.value = "";
        }
      },
    },
  });
}
