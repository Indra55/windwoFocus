import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { validPlayback, progressTemplate, applyEndPosition } from "../extension/progress-experiment.mjs";

const id = "7~exampleCourse~exampleVideo";
const path = "/learn/upgrading-apps-generative-ai/lecture/example";
const origin = "https://www.coursera.org";
const startedAt = 200000;
const state = () => ({ origin, path, source: "https://media.invalid/example.mp4", position: 110.7, duration: 343.25, rate: 2 });
const entry = () => ({
  startedDateTime: new Date(startedAt + 1000).toISOString(),
  request: {
    url: `${origin}/api/onDemandVideoProgresses.v1/${encodeURIComponent(id)}`,
    method: "PUT",
    postData: { text: JSON.stringify({ viewedUpTo: 110700, videoProgressId: id }) },
    headers: [
      { name: "Content-Type", value: "application/json" },
      { name: "X-CSRF3-Token", value: "test-csrf-only" },
      { name: "Cookie", value: "must-not-copy" },
      { name: "Authorization", value: "must-not-copy" },
    ],
  },
  response: { status: 204 },
});

test("infers milliseconds from the actual progress value and media clock", () => {
  const plan = progressTemplate(entry(), state(), state(), startedAt);
  assert.equal(plan.unit, 1000);
  assert.equal(plan.videoProgressId, id);
  assert.deepEqual(plan.headers, { "content-type": "application/json", "x-csrf3-token": "test-csrf-only" });
  assert.equal(JSON.stringify(plan).includes("must-not-copy"), false);
});

test("supports seconds only when they match the live media clock", () => {
  const request = entry();
  request.request.postData.text = JSON.stringify({ viewedUpTo: 110.7, videoProgressId: id });
  assert.equal(progressTemplate(request, state(), state(), startedAt).unit, 1);
});

test("does not infer a unit from a mismatched or very early sample", () => {
  assert.equal(progressTemplate(entry(), { ...state(), position: 1 }, state(), startedAt), null);
  assert.equal(progressTemplate(entry(), { ...state(), position: 50 }, state(), startedAt), null);
});

test("rejects unsupported pages, rates, and unbounded media", () => {
  for (const change of [{ rate: 3 }, { duration: Infinity }, { path: "/learn/upgrading-apps-generative-ai/quiz/example" }, { origin: "https://example.com" }, { source: "" }]) {
    assert.equal(validPlayback({ ...state(), ...change }), false);
  }
});

test("rejects requests from before preparation or from a different video", () => {
  assert.equal(progressTemplate(entry(), state(), state(), startedAt + 2000), null);
  assert.equal(progressTemplate(entry(), { ...state(), source: "other.mp4" }, state(), startedAt), null);
  assert.equal(progressTemplate(entry(), { ...state(), path: path + "-other" }, state(), startedAt), null);
});

test("requires a successful native PUT for the exact progress endpoint", () => {
  for (const change of [
    request => { request.request.method = "POST"; },
    request => { request.response.status = 403; },
    request => { request.request.url = "https://example.com/api/onDemandVideoProgresses.v1"; },
    request => { request.request.url = `${origin}/api/otherEndpoint.v1`; },
    request => { request.request.url = `${origin}/api/onDemandVideoProgresses.v1/other-id`; },
    request => { request.request.url = `${origin}/api/onDemandVideoProgresses.v1/%ZZ`; },
    request => { delete request.startedDateTime; },
  ]) {
    const request = entry();
    change(request);
    assert.equal(progressTemplate(request, state(), state(), startedAt), null);
  }
});

test("rejects malformed, additional, or unexpected payload fields", () => {
  for (const body of [
    { viewedUpTo: "110700", videoProgressId: id },
    { viewedUpTo: 110700, videoProgressId: id, extra: true },
    { viewedUpTo: 110700, videoProgressId: "not-a-progress-id" },
    { viewedUpTo: 9999999, videoProgressId: id },
    null,
  ]) {
    const request = entry();
    request.request.postData.text = JSON.stringify(body);
    assert.equal(progressTemplate(request, state(), state(), startedAt), null);
  }
});

async function runPage({ changeVideo = {}, status = 204, reject = false, onPause } = {}) {
  const calls = [];
  const s = state();
  const video = {
    currentSrc: s.source, currentTime: s.position, duration: s.duration,
    playbackRate: s.rate, isConnected: true, pauses: 0,
    pause() { this.pauses++; onPause?.(this); },
    ...changeVideo,
  };
  const plan = progressTemplate(entry(), s, s, startedAt);
  const result = await vm.runInNewContext(`(${applyEndPosition.toString()})(plan)`, {
    plan, URL, location: { origin, pathname: path },
    document: { querySelector: () => video },
    setTimeout: callback => callback(),
    AbortSignal: { timeout: () => "timeout-signal" },
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (reject) throw new Error("private network error");
      return { status, get text() { throw new Error("Response body must not be read"); } };
    },
  });
  return { result, calls, video };
}

test("one manual test sends the observed identity and full-duration position once", async () => {
  const { result, calls, video } = await runPage();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "PUT");
  assert.equal(calls[0].options.credentials, "same-origin");
  assert.deepEqual(JSON.parse(calls[0].options.body), { viewedUpTo: 343250, videoProgressId: id });
  assert.equal(video.pauses, 1);
  assert.equal(video.currentTime, 110.7);
  assert.equal(video.playbackRate, 2);
  assert.equal(result.state, "accepted");
  assert.equal(result.status, 204);
  assert.equal(JSON.stringify(result).includes(id), false);
  assert.equal(JSON.stringify(result).includes("csrf"), false);
});

test("HTTP errors remain failures and do not trigger retries", async () => {
  for (const status of [400, 401, 403, 429, 500]) {
    const { result, calls } = await runPage({ status });
    assert.equal(result.state, "rejected");
    assert.equal(result.status, status);
    assert.equal(calls.length, 1);
  }
});

test("network errors expose no request details and do not retry", async () => {
  const { result, calls } = await runPage({ reject: true });
  assert.equal(result.state, "network-error");
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("a changed video or unsupported rate prevents the write", async () => {
  for (const changeVideo of [{ currentSrc: "other.mp4" }, { playbackRate: 3 }, { duration: Infinity }]) {
    const { calls, result } = await runPage({ changeVideo });
    assert.equal(calls.length, 0);
    assert.notEqual(result.state, "accepted");
  }
});

test("a navigation during the pause grace period prevents the write", async () => {
  const { calls, result } = await runPage({ onPause: video => { video.currentSrc = "other.mp4"; } });
  assert.equal(calls.length, 0);
  assert.equal(result.state, "stale");
});
