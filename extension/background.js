async function updateBadge() {
  const { enabled = false } = await chrome.storage.local.get("enabled");
  await chrome.action.setBadgeBackgroundColor({ color: "#426954" });
  await chrome.action.setBadgeText({ text: enabled ? "ON" : "" });
}

chrome.runtime.onInstalled.addListener(updateBadge);
chrome.runtime.onStartup.addListener(updateBadge);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.enabled) updateBadge();
});
