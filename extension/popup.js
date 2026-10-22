const enabled = document.querySelector("#enabled");
const autoNext = document.querySelector("#autoNext");
const status = document.querySelector("#status");
const feedback = document.querySelector("#feedback");

function render(settings) {
  enabled.checked = settings.enabled;
  autoNext.checked = settings.autoNext;
  enabled.disabled = false;
  autoNext.disabled = !settings.enabled;
  status.textContent = settings.enabled ? "On for your course" : "Off";
  status.dataset.enabled = String(settings.enabled);
}

async function load() {
  try {
    render(await chrome.storage.local.get({ enabled: false, autoNext: true }));
  } catch {
    feedback.textContent = "Could not read settings. Close and reopen this popup.";
  }
}

document.querySelector("form").addEventListener("submit", (event) => event.preventDefault());
for (const input of [enabled, autoNext]) {
  input.addEventListener("change", async () => {
    try {
      await chrome.storage.local.set({ enabled: enabled.checked, autoNext: autoNext.checked });
      await load();
      feedback.textContent = enabled.checked ? "On. You can still pause videos yourself." : "Off. Normal page behavior restored.";
    } catch {
      await load();
      feedback.textContent = "Could not save settings. Try again.";
    }
  });
}
chrome.storage.onChanged.addListener(load);
load();
