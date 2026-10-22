import { formatReport, isTargetPage, sanitizeRequest, isProgressRead, sanitizeProgressResponse } from "./diagnostic-report.mjs";

const record = document.querySelector("#record");
const stop = document.querySelector("#stop");
const outcome = document.querySelector("#outcome");
const status = document.querySelector("#status");
const report = document.querySelector("#report");
let recording = false;
let entries = [];
let dropped = 0;
let generation = 0;
let reportSource = "live";

function render() {
  record.disabled = recording;
  stop.disabled = !recording;
  report.value = formatReport(entries, outcome.value, dropped, reportSource);
}

function retain(request) {
  const safe = sanitizeRequest(request);
  if (!safe) return;
  if (entries.length === 120) { entries.shift(); dropped++; }
  entries.push(safe);
  return safe;
}

function readSavedProgress(request, safe, attempt) {
  if (!safe || !isProgressRead(request)) return;
  safe.response = { body: { format: "unavailable", fields: [] }, progress: [] };
  if (typeof request.getContent !== "function") return;
  try {
    request.getContent((content, encoding) => {
      if (attempt !== generation || !entries.includes(safe)) return;
      safe.response = sanitizeProgressResponse(request, content, encoding);
      render();
    });
  } catch { /* DevTools may discard response content after navigation. */ }
}

record.addEventListener("click", () => {
  const attempt = ++generation;
  chrome.devtools.inspectedWindow.eval("location.origin + location.pathname", (url, error) => {
    if (attempt !== generation) return;
    if (error || !isTargetPage(url)) {
      status.textContent = "Open a configured video page before recording.";
      return;
    }
    entries = [];
    dropped = 0;
    reportSource = "live";
    outcome.value = "not-checked";
    recording = true;
    status.textContent = "Recording. Let playback finish at a supported speed, then choose the observed result and click Stop.";
    render();
  });
});

document.querySelector("#existing").addEventListener("click", () => {
  const attempt = ++generation;
  recording = false;
  render();
  chrome.devtools.inspectedWindow.eval("location.origin + location.pathname", (url, error) => {
    if (attempt !== generation) return;
    if (error || !isTargetPage(url)) {
      status.textContent = "Open a configured video page before loading its Network log.";
      return;
    }
    chrome.devtools.network.getHAR((log) => {
      if (attempt !== generation) return;
      entries = [];
      dropped = 0;
      reportSource = "existing-log";
      outcome.value = "not-checked";
      const retained = [];
      for (const request of (log?.entries || []).slice(-1000)) {
        const safe = retain(request);
        if (safe) retained.push([request, safe]);
      }
      for (const [request, safe] of retained) {
        if (entries.includes(safe)) readSavedProgress(request, safe, attempt);
      }
      status.textContent = entries.length ? `Loaded ${entries.length} relevant requests. Choose the observed result, then select the report.` : "No relevant requests remain in the Network log. Record the next normal playback session.";
      render();
    });
  });
});

stop.addEventListener("click", () => {
  generation++;
  recording = false;
  status.textContent = `Stopped. ${entries.length} relevant requests recorded.`;
  render();
});

chrome.devtools.network.onRequestFinished.addListener((request) => {
  if (!recording) return;
  const attempt = generation;
  chrome.devtools.inspectedWindow.eval("location.origin + location.pathname", (url, error) => {
    if (attempt !== generation || !recording) return;
    if (error || !isTargetPage(url)) {
      generation++;
      recording = false;
      status.textContent = "Recording stopped after leaving the configured video pages.";
      render();
      return;
    }
    const safe = retain(request);
    readSavedProgress(request, safe, attempt);
    status.textContent = `Recording. ${entries.length} relevant requests captured.`;
    render();
  });
});

chrome.devtools.network.onNavigated.addListener((url) => {
  generation++;
  if (!isTargetPage(url)) {
    recording = false;
    status.textContent = "Recording stopped after leaving the configured video pages.";
    render();
  }
});

outcome.addEventListener("change", render);
document.querySelector("#select").addEventListener("click", () => {
  report.focus();
  report.select();
  status.textContent = "Report selected. Press Ctrl+C to copy.";
});
render();
