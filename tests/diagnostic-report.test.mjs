import assert from "node:assert/strict";
import test from "node:test";
import { formatReport, isTargetPage, sanitizeRequest, isProgressRead, sanitizeProgressResponse } from "../extension/diagnostic-report.mjs";

const har = (url, body, status = 200) => ({
  request: { url, method: "POST", postData: { text: JSON.stringify(body), mimeType: "application/json" } },
  response: { status },
});

test("diagnostics are restricted to the configured video routes", () => {
  assert.equal(isTargetPage("https://www.coursera.org/learn/upgrading-apps-generative-ai/lecture/test"), true);
  for (const url of ["https://www.coursera.org/learn/upgrading-apps-generative-ai/quiz/test", "https://example.com/learn/upgrading-apps-generative-ai/lecture/test", "javascript:alert(1)", "bad-url"]) {
    assert.equal(isTargetPage(url), false);
  }
});

test("report keeps progress values but removes identifiers, tokens and URL details", () => {
  const entry = har("https://www.coursera.org/api/opencourse.v1/user/123/course/private/item/secret/videoEvents?token=secret", {
    type: "ViewedUpto", videoPosition: 27, playbackRate: 2, userId: 123, itemId: "secret",
    authorization: "Bearer SECRET", csrfToken: "SECRET", nested: { percentWatched: 0.25, email: "private@example.com" },
  });
  const safe = sanitizeRequest(entry);
  assert.equal(safe.endpoint, "/api/opencourse.v1/…/videoEvents");
  assert.equal(safe.status, 200);
  assert.deepEqual(safe.types, ["ViewedUpto"]);
  assert.deepEqual(safe.progress, [{ field: "videoPosition", value: 27 }, { field: "playbackRate", value: 2 }, { field: "percentWatched", value: 0.25 }]);
  const report = JSON.stringify(safe);
  for (const privateValue of ["123", "private", "secret", "SECRET", "email", "authorization", "token"]) assert.equal(report.includes(privateValue), false);
});

test("sanitizer never accesses request headers, cookies or response content", () => {
  const entry = har("https://www.coursera.org/api/onDemandLectureViews.v1", { isCompleted: true });
  for (const key of ["headers", "cookies"]) {
    Object.defineProperty(entry.request, key, { get() { throw new Error("Sensitive access"); } });
  }
  Object.defineProperty(entry, "getContent", { get() { throw new Error("Sensitive access"); } });
  assert.deepEqual(sanitizeRequest(entry).progress, [{ field: "isCompleted", value: true }]);
});

test("batch reports include only recognized video events", () => {
  const safe = sanitizeRequest(har("https://www.coursera.org/api/rest.v1", { events: [
    { key: "open_course.video.heartbeat", userId: 123, value: { video_position: 50, watched_seconds: 25 } },
    { key: "open_course.quiz.submit", value: { currentTime: 999, answer: "private" } },
    { key: "user.email.private@example.com", value: { duration: 1234 } },
  ] }));
  assert.deepEqual(safe.events, ["open_course.video.heartbeat"]);
  assert.deepEqual(safe.progress, [{ field: "video_position", value: 50 }, { field: "watched_seconds", value: 25 }]);
});

test("ignores unrelated endpoints and external origins", () => {
  for (const url of ["https://example.com/api/videoEvents", "https://coursera.org.attacker.example/api/videoEvents", "http://www.coursera.org/api/videoEvents", "https://www.coursera.org/api/users.v1", "https://www.coursera.org/account"]) {
    assert.equal(sanitizeRequest(har(url, { userId: 123 })), null);
  }
});

test("retains failed statuses without labeling them successful", () => {
  for (const status of [0, 400, 401, 403, 429, 500]) {
    assert.equal(sanitizeRequest(har("https://www.coursera.org/api/onDemandLectureViews.v1", {}, status)).status, status);
  }
});

test("malformed bodies and unsafe progress values are omitted", () => {
  const entry = har("https://www.coursera.org/api/onDemandLectureViews.v1", {
    playbackRate: "secret-token", currentTime: Number.POSITIVE_INFINITY, percentWatched: "0.75", isCompleted: "true", duration: { token: "private" },
  });
  assert.deepEqual(sanitizeRequest(entry).progress, [{ field: "percentWatched", value: 0.75 }, { field: "isCompleted", value: true }]);
  entry.request.postData.text = "not json";
  assert.deepEqual(sanitizeRequest(entry).progress, []);
});

test("report preserves the observed checkmark result and request failure", () => {
  const safe = sanitizeRequest(har("https://www.coursera.org/api/onDemandLectureViews.v1", {}, 403));
  const report = JSON.parse(formatReport([safe], "check-missing", 2));
  assert.equal(report.outcome, "check-missing");
  assert.equal(report.requests[0].status, 403);
  assert.equal(report.dropped, 2);
  assert.equal(JSON.parse(formatReport([], "untrusted-result")).outcome, "not-checked");
});

test("records PUT progress ranges and unfamiliar progress field structure", () => {
  const entry = har("https://www.coursera.org/api/onDemandVideoProgresses.v1/private-id", {
    watchedIntervals: [[0, 15], [15, 30]], videoProgressPercent: 50,
    elements: [{ videoTimeRanges: [0, 30], privateField: "not-exported" }],
  }, 204);
  entry.request.method = "PUT";
  const safe = sanitizeRequest(entry);
  assert.equal(safe.method, "PUT");
  assert.equal(safe.status, 204);
  assert.equal(safe.body.format, "json");
  assert.deepEqual(safe.progress, [
    { field: "watchedIntervals", value: [[0, 15], [15, 30]] },
    { field: "videoProgressPercent", value: 50 },
    { field: "videoTimeRanges", value: [0, 30] },
  ]);
  assert.ok(safe.body.fields.some(field => field.field === "watchedIntervals" && field.type === "array"));
  assert.equal(JSON.stringify(safe).includes("not-exported"), false);
});

test("numeric tokens and identifiers remain private even when their names mention progress", () => {
  const safe = sanitizeRequest(har("https://www.coursera.org/api/onDemandVideoProgresses.v1", {
    progressToken: 883322, videoAccessTOKEN: 991144, progressUserId: 884455,
    videoSessionID: 665577, userProgress: 332244, progress: 0.5,
  }));
  assert.deepEqual(safe.progress, [{ field: "progress", value: 0.5 }]);
  const report = JSON.stringify(safe);
  for (const value of ["883322", "991144", "884455", "665577", "332244", "progressToken", "videoSessionID"]) assert.equal(report.includes(value), false);
});

test("body metadata distinguishes missing, unavailable, malformed and parsed bodies", () => {
  const entry = har("https://www.coursera.org/api/onDemandVideoProgresses.v1", {});
  assert.equal(sanitizeRequest(entry).body.format, "json");
  delete entry.request.postData;
  assert.equal(sanitizeRequest(entry).body.format, "missing");
  entry.request.postData = { mimeType: "application/octet-stream" };
  assert.equal(sanitizeRequest(entry).body.format, "unavailable");
  entry.request.postData.text = "not-json";
  assert.equal(sanitizeRequest(entry).body.format, "unparsed");
});

test("unknown body values and dynamically keyed identifiers are not exported", () => {
  const safe = sanitizeRequest(har("https://www.coursera.org/api/onDemandVideoProgresses.v1", {
    elements: { "private-id-123": { progress: 0.5, note: "private note" } },
  }));
  const report = JSON.stringify(safe);
  assert.equal(report.includes("private-id-123"), false);
  assert.equal(report.includes("private note"), false);
  assert.ok(safe.body.fields.some(field => field.field.includes("elements.other")));
});

test("saved GET responses retain numeric progress while excluding identities and secrets", () => {
  const entry = har("https://www.coursera.org/api/onDemandVideoProgresses.v1?ids=private", {});
  entry.request.method = "GET";
  Object.defineProperty(entry.request, "headers", { get() { throw new Error("Do not access headers"); } });
  const safe = sanitizeProgressResponse(entry, JSON.stringify({ elements: [
    { id: "7~exampleCourse~exampleVideo", viewedUpTo: 110700, videoProgressId: "private-id", csrfToken: "private-token" },
  ] }), "");
  assert.deepEqual(safe.progress, [{ field: "viewedUpTo", value: 110700 }]);
  assert.equal(safe.body.format, "json");
  for (const text of ["exampleCourse", "private", "csrfToken", "videoProgressId"]) {
    assert.equal(JSON.stringify(safe).includes(text), false);
  }
});

test("response reading is restricted to successful same-origin saved-progress GETs", () => {
  const base = har("https://www.coursera.org/api/onDemandVideoProgresses.v1", {});
  base.request.method = "GET";
  assert.equal(isProgressRead(base), true);
  for (const entry of [
    har(base.request.url, {}),
    { ...base, response: { status: 403 } },
    { ...base, request: { ...base.request, url: "https://example.com/api/onDemandVideoProgresses.v1" } },
    { ...base, request: { ...base.request, url: "https://www.coursera.org/api/onDemandCourseMaterials.v2" } },
  ]) {
    assert.equal(isProgressRead(entry), false);
    assert.equal(sanitizeProgressResponse(entry, "{}", ""), null);
  }
});

test("missing, encoded, oversized and malformed saved responses remain explicit", () => {
  const entry = har("https://www.coursera.org/api/onDemandVideoProgresses.v1", {});
  entry.request.method = "GET";
  for (const [content, encoding] of [[undefined, ""], ["private-base64", "base64"], ["x".repeat(200001), ""]]) {
    const safe = sanitizeProgressResponse(entry, content, encoding);
    assert.equal(safe.body.format, "unavailable");
    assert.deepEqual(safe.progress, []);
  }
  assert.equal(sanitizeProgressResponse(entry, "not-json", "").body.format, "unparsed");
});
