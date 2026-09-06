/** Focused merchant tabs keep hidden controls mounted for complete form saves. */
export const MERCHANT_EDITOR_TABS = Object.freeze([
  ["basics", "Setup"],
  ["stock", "Inventory"],
  ["access", "Access"],
  ["advanced", "Advanced"],
]);

export function merchantTabContext(merchantId, active = "basics") {
  const prefix = `merchant-${encodeURIComponent(merchantId || "preview")}`;
  const merchantTabs = MERCHANT_EDITOR_TABS.map(([key, label]) => ({
    key,
    label,
    active: key === active,
    tabId: `${prefix}-tab-${key}`,
    panelId: `${prefix}-panel-${key}`,
  }));
  return {
    merchantTabs,
    merchantPanels: Object.fromEntries(
      merchantTabs.map((tab) => [tab.key, tab]),
    ),
  };
}

export function selectMerchantTab(root, key) {
  if (!MERCHANT_EDITOR_TABS.some(([id]) => id === key)) return false;
  for (const tab of root?.querySelectorAll?.("[data-merchant-tab]") ?? []) {
    const active = tab.dataset.merchantTab === key;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  for (const panel of root?.querySelectorAll?.("[data-merchant-panel]") ?? []) {
    panel.hidden = panel.dataset.merchantPanel !== key;
  }
  const content = root?.querySelector?.(".mw-tab-content");
  if (content) content.scrollTop = 0;
  return true;
}

export function bindMerchantTabKeys(root, onSelect) {
  const nav = root?.querySelector?.('[role="tablist"]');
  nav?.addEventListener("keydown", (event) => {
    const tabs = [...nav.querySelectorAll("[data-merchant-tab]")];
    const index = tabs.indexOf(event.target);
    if (index < 0) return;
    let next;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft")
      next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    onSelect(tabs[next].dataset.merchantTab);
    tabs[next].focus();
  });
}
