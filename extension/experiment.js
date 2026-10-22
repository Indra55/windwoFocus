import { playbackSnapshot, validPlayback, progressTemplate, applyEndPosition } from "./progress-experiment.mjs";

const prepare = document.querySelector("#prepare");
const run = document.querySelector("#run");
const status = document.querySelector("#experiment-status");
let context = null;
let candidate = null;
let startedAt = 0;
let generation = 0;
let busy = false;

function snapshot(callback) {
  chrome.devtools.inspectedWindow.eval(`(${playbackSnapshot.toString()})()`, (value, error) => callback(error ? null : value));
}

prepare.addEventListener("click", () => {
  if (busy) return;
  const attempt = ++generation;
  context = null;
  candidate = null;
  run.disabled = true;
  snapshot(value => {
    if (attempt !== generation) return;
    if (!validPlayback(value)) {
      status.textContent = "Open a configured video at 2× or slower before preparing a test.";
      return;
    }
    context = value;
    startedAt = Date.now();
    status.textContent = "Prepared. Play until a new progress save is detected. Keep this video open.";
  });
});

chrome.devtools.network.onRequestFinished.addListener(entry => {
  if (!context || busy || candidate || entry.request?.method !== "PUT") return;
  const attempt = generation;
  snapshot(value => {
    if (attempt !== generation || !context || busy) return;
    if (!validPlayback(value) || value.path !== context.path || value.source !== context.source) {
      context = null;
      status.textContent = "Video changed. Prepare a new test for the current video.";
      return;
    }
    candidate = progressTemplate(entry, value, context, startedAt);
    if (!candidate) return;
    run.disabled = false;
    status.textContent = "Ready. Run once pauses this video and requests an end-position update. Completion still needs a green-check verification after refreshing.";
  });
});

run.addEventListener("click", () => {
  if (!candidate || busy) return;
  const plan = candidate;
  candidate = null;
  context = null;
  const attempt = ++generation;
  busy = true;
  run.disabled = true;
  prepare.disabled = true;
  status.textContent = "Running one end-position test…";
  const slot = `__windowFocusResult_${crypto.randomUUID().replaceAll("-", "")}`;
  const key = JSON.stringify(slot);
  function finish(result) {
    if (attempt !== generation) return;
    busy = false;
    prepare.disabled = false;
    chrome.devtools.inspectedWindow.eval(`delete window[${key}]`, () => {});
    if (result?.state === "accepted") {
      status.textContent = `Request accepted (HTTP ${Number(result.status)}). Refresh the video page and check for the green tick. Completion is not confirmed yet.`;
    } else if (result?.state === "rejected") {
      status.textContent = `Request rejected (HTTP ${Number(result.status)}). No completion is confirmed.`;
    } else if (result?.state === "stale") {
      status.textContent = "Video changed before the test finished. No completion is confirmed.";
    } else {
      status.textContent = "The test could not be verified. No completion is confirmed. You can prepare a new test.";
    }
  }
  function poll(count = 0) {
    if (attempt !== generation) return;
    const expression = `(() => {
      if (location.origin !== ${JSON.stringify(plan.origin)} || location.pathname !== ${JSON.stringify(plan.path)}) return {state: "stale"};
      return window[${key}] || {state: "running"};
    })()`;
    chrome.devtools.inspectedWindow.eval(expression, (result, error) => {
      if (attempt !== generation) return;
      if (error) return finish({ state: "network-error" });
      if (result?.state !== "running") return finish(result);
      if (count >= 48) return finish({ state: "timeout" });
      setTimeout(() => poll(count + 1), 250);
    });
  }
  // DevTools eval returns synchronously, so a temporary slot carries only the
  // sanitized result. Request headers and identities are never put in that slot.
  const expression = `(() => {
    window[${key}] = {state: "running"};
    (${applyEndPosition.toString()})(${JSON.stringify(plan)}).then(
      result => { window[${key}] = result; },
      () => { window[${key}] = {state: "network-error"}; }
    );
    setTimeout(() => { delete window[${key}]; }, 30000);
    return "started";
  })()`;
  chrome.devtools.inspectedWindow.eval(expression, (result, error) => {
    if (attempt !== generation) return;
    if (error || result !== "started") return finish({ state: "network-error" });
    poll();
  });
});

chrome.devtools.network.onNavigated.addListener(() => {
  generation++;
  context = null;
  candidate = null;
  busy = false;
  prepare.disabled = false;
  run.disabled = true;
  status.textContent = "Page changed. Prepare a new test for the current video.";
});
