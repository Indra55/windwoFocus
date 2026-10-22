import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { playbackSnapshot, validPlayback, progressTemplate, applyEndPosition } from "../extension/progress-experiment.mjs";

const source = (await readFile(new URL("../extension/experiment.js", import.meta.url), "utf8")).replace(/^import[^\n]+\n/, "");
const id = "7~exampleCourse~exampleVideo";
const origin = "https://www.coursera.org";
const path = "/learn/upgrading-apps-generative-ai/lecture/example";
const nativeRequest = () => ({
  startedDateTime: new Date(Date.now() + 1000).toISOString(),
  request: {
    url: `${origin}/api/onDemandVideoProgresses.v1/${id}`, method: "PUT",
    postData: { text: JSON.stringify({ viewedUpTo: 110700, videoProgressId: id }) },
    headers: [{ name: "X-CSRF3-Token", value: "private-test-token" }],
  },
  response: { status: 204 },
});

function panel() {
  const elements = new Map(["prepare", "run", "experiment-status"].map(id => [id, Object.assign(new EventTarget(), { disabled: id === "run", textContent: "" })]));
  const writes = [];
  const pending = [];
  let snapshot = { origin, path, source: "https://media.invalid/example.mp4", position: 110.7, duration: 343.25, rate: 2 };
  let outcome = { state: "accepted", status: 204, requestedSeconds: 343.25 };
  let finished, navigated;
  let defer = false;
  vm.runInNewContext(source, {
    playbackSnapshot, validPlayback, progressTemplate, applyEndPosition,
    crypto: { randomUUID: () => "test-guid" },
    setTimeout: callback => pending.push(callback),
    document: { querySelector: selector => elements.get(selector.slice(1)) },
    chrome: { devtools: {
      network: {
        onRequestFinished: { addListener(callback) { finished = callback; } },
        onNavigated: { addListener(callback) { navigated = callback; } },
      },
      inspectedWindow: { eval(expression, callback) {
        if (expression.includes("function playbackSnapshot")) return callback({ ...snapshot });
        if (expression.startsWith("delete window[")) return callback(true);
        if (expression.includes('return "started"')) {
          writes.push(expression);
          if (defer) pending.push(() => callback("started"));
          else callback("started");
          return;
        }
        if (expression.includes("return window[")) return callback(outcome);
        throw new Error("Unexpected inspected-page evaluation");
      } },
    } },
  });
  return {
    elements, writes,
    click: id => elements.get(id).dispatchEvent(new Event("click")),
    request: value => finished(value), navigate: () => navigated(),
    state: value => { snapshot = { ...snapshot, ...value }; },
    outcome: value => { outcome = value; },
    defer: () => { defer = true; },
    flush: () => { for (const callback of pending.splice(0)) callback(); },
  };
}

test("native requests never trigger a write without prepare and Run once", () => {
  const p = panel();
  p.request(nativeRequest());
  p.click("run");
  assert.equal(p.writes.length, 0);
  p.click("prepare");
  p.request(nativeRequest());
  assert.equal(p.elements.get("run").disabled, false);
  assert.equal(p.writes.length, 0);
});

test("Run once consumes the prepared request and labels acceptance as unconfirmed", () => {
  const p = panel();
  p.click("prepare");
  p.request(nativeRequest());
  p.click("run");
  p.click("run");
  assert.equal(p.writes.length, 1);
  assert.equal(p.elements.get("run").disabled, true);
  assert.match(p.elements.get("experiment-status").textContent, /HTTP 204/);
  assert.match(p.elements.get("experiment-status").textContent, /not confirmed/);
  assert.equal(p.elements.get("experiment-status").textContent.includes(id), false);
  assert.equal(p.elements.get("experiment-status").textContent.includes("private-test-token"), false);
});

test("Run once remains guarded while page evaluation is pending", () => {
  const p = panel();
  p.click("prepare");
  p.request(nativeRequest());
  p.defer();
  p.click("run");
  p.click("run");
  assert.equal(p.writes.length, 1);
  p.flush();
  assert.equal(p.elements.get("prepare").disabled, false);
});

test("page navigation clears a prepared request", () => {
  const p = panel();
  p.click("prepare");
  p.request(nativeRequest());
  p.navigate();
  p.click("run");
  assert.equal(p.writes.length, 0);
  assert.equal(p.elements.get("run").disabled, true);
});

test("a video change while preparing prevents arming the action", () => {
  const p = panel();
  p.click("prepare");
  p.state({ source: "other.mp4" });
  p.request(nativeRequest());
  p.click("run");
  assert.equal(p.writes.length, 0);
});

test("unsupported playback speed cannot arm the action", () => {
  const p = panel();
  p.state({ rate: 3 });
  p.click("prepare");
  p.request(nativeRequest());
  p.click("run");
  assert.equal(p.writes.length, 0);
  assert.match(p.elements.get("experiment-status").textContent, /2× or slower/);
});

test("HTTP rejection remains a failure rather than reporting completion", () => {
  const p = panel();
  p.outcome({ state: "rejected", status: 403 });
  p.click("prepare");
  p.request(nativeRequest());
  p.click("run");
  assert.match(p.elements.get("experiment-status").textContent, /rejected \(HTTP 403\)/);
});

test("network navigation invalidates delayed evaluation results", () => {
  const p = panel();
  p.click("prepare");
  p.request(nativeRequest());
  p.defer();
  p.click("run");
  p.navigate();
  p.flush();
  assert.match(p.elements.get("experiment-status").textContent, /Page changed/);
  assert.equal(p.elements.get("run").disabled, true);
});
