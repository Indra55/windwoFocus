(() => {
  const defaults = { enabled: false, autoNext: true };

  async function publishSettings() {
    try {
      const settings = await chrome.storage.local.get(defaults);
      window.dispatchEvent(new CustomEvent("windowfocus:settings", {
        detail: JSON.stringify(settings),
      }));
    } catch {
      window.dispatchEvent(new CustomEvent("windowfocus:settings", {
        detail: JSON.stringify({ enabled: false, autoNext: false }),
      }));
    }
  }

  window.addEventListener("windowfocus:ready", publishSettings);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.enabled || changes.autoNext)) publishSettings();
  });
  publishSettings();
})();
