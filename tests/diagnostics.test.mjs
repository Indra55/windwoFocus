import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { formatReport, isTargetPage, sanitizeRequest, isProgressRead, sanitizeProgressResponse } from "../extension/diagnostic-report.mjs";

const source = (await readFile(new URL("../extension/diagnostics.js", import.meta.url), "utf8"))
  .replace(/^import[^\n]+\n/, "");
const target = "https://www.coursera.org/learn/upgrading-apps-generative-ai/lecture/test";
const request = {
  request: { url: "https://www.coursera.org/api/onDemandLectureViews.v1", method: "POST", postData: { text: '{"isCompleted":true}' } },
  response: { status: 200 },
};

function panel() {
  const elements = new Map();
  for (const id of ["record", "stop", "existing", "outcome", "status", "report", "select"]) {
    elements.set(id, Object.assign(new EventTarget(), {
      value: id === "outcome" ? "not-checked" : "", disabled: false, textContent: "",
      focus() { this.focused = true; }, select() { this.selected = true; },
    }));
  }
  const pending = [];
  let defer = false;
  let url = target;
  let finished;
  let navigated;
  let log = [];
  vm.runInNewContext(source, {
    formatReport, isTargetPage, sanitizeRequest, isProgressRead, sanitizeProgressResponse,
    document: { querySelector: selector => elements.get(selector.slice(1)) },
    chrome: { devtools: {
      inspectedWindow: { eval(expression, callback) {
        assert.equal(expression, "location.origin + location.pathname");
        if (defer) pending.push(() => callback(url));
        else callback(url);
      } },
      network: {
        getHAR(callback) { callback({ entries: log }); },
        onRequestFinished: { addListener(callback) { finished = callback; } },
        onNavigated: { addListener(callback) { navigated = callback; } },
      },
    } },
  });
  return {
    elements,
    click: id => elements.get(id).dispatchEvent(new Event("click")),
    report: () => JSON.parse(elements.get("report").value),
    request: entry => finished(entry),
    navigate: next => { url = next; navigated(next); },
    spaNavigate: next => { url = next; },
    defer: () => { defer = true; },
    flush: () => { for (const callback of pending.splice(0)) callback(); },
    log: entries => { log = entries; },
  };
}

test("panel records nothing until explicitly started", () => {
  const p = panel();
  p.request(request);
  assert.equal(p.report().requests.length, 0);
  assert.equal(p.elements.get("stop").disabled, true);
});

test("record and stop control collection without making network calls", () => {
  const p = panel();
  p.click("record");
  p.request(request);
  p.click("stop");
  p.request(request);
  assert.equal(p.report().requests.length, 1);
  assert.equal(p.elements.get("record").disabled, false);
});

test("a delayed request cannot enter the report after stopping", () => {
  const p = panel();
  p.click("record");
  p.defer();
  p.request(request);
  p.click("stop");
  p.flush();
  assert.equal(p.report().requests.length, 0);
});

test("recording stops on both full and SPA navigation outside configured pages", () => {
  for (const navigation of ["navigate", "spaNavigate"]) {
    const p = panel();
    p.click("record");
    p[navigation]("https://www.coursera.org/learn/upgrading-apps-generative-ai/quiz/test");
    p.request(request);
    assert.equal(p.report().requests.length, 0);
    assert.equal(p.elements.get("stop").disabled, true);
  }
});

test("recording cannot start on an unsupported page", () => {
  const p = panel();
  p.navigate("https://example.com");
  p.click("record");
  p.request(request);
  assert.equal(p.report().requests.length, 0);
  assert.match(p.elements.get("status").textContent, /Open a configured video page/);
});

test("recording keeps a bounded report and counts dropped entries", () => {
  const p = panel();
  p.click("record");
  for (let i = 0; i < 125; i++) p.request(request);
  assert.equal(p.report().requests.length, 120);
  assert.equal(p.report().dropped, 5);
  p.click("stop");
  p.click("record");
  assert.equal(p.report().requests.length, 0);
  assert.equal(p.report().dropped, 0);
});

test("only recognized requests are retained", () => {
  const p = panel();
  p.click("record");
  p.request({ request: { url: "https://example.com/private", method: "POST" } });
  p.request(request);
  assert.equal(p.report().requests.length, 1);
});

test("the observed outcome is explicit and reports are selected locally", () => {
  const p = panel();
  p.elements.get("outcome").value = "check-missing";
  p.elements.get("outcome").dispatchEvent(new Event("change"));
  assert.equal(p.report().outcome, "check-missing");
  p.click("select");
  assert.equal(p.elements.get("report").selected, true);
});

test("loads and sanitizes existing Network records without another playback", () => {
  const p = panel();
  p.log([request, { request: { url: "https://example.com/private" } }]);
  p.click("existing");
  assert.equal(p.report().requests.length, 1);
  assert.equal(p.report().source, "existing-log");
  assert.equal(p.report().outcome, "not-checked");
  assert.equal(p.elements.get("stop").disabled, true);
});

test("an empty existing log is reported clearly", () => {
  const p = panel();
  p.click("existing");
  assert.equal(p.report().requests.length, 0);
  assert.match(p.elements.get("status").textContent, /No relevant requests remain/);
});

const progressRead = getContent => ({
  request: { url: "https://www.coursera.org/api/onDemandVideoProgresses.v1?ids=private", method: "GET" },
  response: { status: 200 }, getContent,
});

test("existing log reads saved response content locally and filters it into the report", () => {
  const p = panel();
  let reads = 0;
  p.log([progressRead(callback => {
    reads++;
    callback('{"elements":[{"id":"private","viewedUpTo":110700}]}', "");
  })]);
  p.click("existing");
  assert.equal(reads, 1);
  assert.deepEqual(p.report().requests[0].response.progress, [{ field: "viewedUpTo", value: 110700 }]);
  assert.equal(JSON.stringify(p.report()).includes("private"), false);
});

test("unavailable response content is labeled and unrelated bodies are never read", () => {
  const p = panel();
  p.log([progressRead(undefined), { ...request, getContent() { throw new Error("Must not read"); } }]);
  p.click("existing");
  assert.equal(p.report().requests[0].response.body.format, "unavailable");
  assert.equal(p.report().requests[1].response, undefined);
});

test("late saved response callbacks cannot change a replaced report or navigated page", () => {
  for (const action of [p => p.click("existing"), p => p.navigate(target + "-other")]) {
    const p = panel();
    let pending;
    p.log([progressRead(callback => { pending = callback; })]);
    p.click("existing");
    const oldCallback = pending;
    action(p);
    const before = p.elements.get("report").value;
    oldCallback('{"viewedUpTo":999999}', "");
    assert.equal(p.elements.get("report").value, before);
  }
});

test("live recorder reads response values only while explicitly recording", () => {
  const p = panel();
  let reads = 0;
  const entry = progressRead(callback => { reads++; callback('{"viewedUpTo":1000}', ""); });
  p.request(entry);
  assert.equal(reads, 0);
  p.click("record");
  p.request(entry);
  p.click("stop");
  p.request(entry);
  assert.equal(reads, 1);
  assert.equal(p.report().requests[0].response.progress[0].value, 1000);
});
