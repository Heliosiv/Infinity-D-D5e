/** Resolve the single Shift+I / scene-control launcher without Foundry imports. */
export function openInfinityPrimaryLauncher(bindings = {}) {
  if (bindings.isFullGM?.() !== true) {
    return bindings.openPlayerLauncher?.() ?? null;
  }
  const status = bindings.getPrivateStateStatus?.();
  if (status?.state === "blocked") {
    return bindings.openCampaignRecovery?.() ?? null;
  }
  return bindings.openGmWorkbench?.() ?? null;
}
