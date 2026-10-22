import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../extension/playback.js", import.meta.url), "utf8");
const course = "/learn/upgrading-apps-generative-ai/";
const origin = "https://www.coursera.org";

class Target {
  listeners = [];
  addEventListener(type, listener, options) {
    this.listeners.push({ type, listener, capture: options === true || options?.capture });
  }
  dispatchEvent(event) {
    event.target ??= this;
    event.stopImmediatePropagation = () => { event.stopped = true; };
    for (const capture of [true, false]) {
      for (const item of [...this.listeners]) {
        if (item.type === event.type && Boolean(item.capture) === capture && !event.stopped) {
          item.listener.call(this, event);
        }
      }
    }
  }
}

class Video extends Target {
  currentSrc = "https://media.invalid/lecture-1.mp4";
  readyState = 4;
  ended = false;
  isConnected = true;
  paused = true;
  plays = 0;
  pauses = 0;
  currentTime = 0;
  playbackRate = 1;
  blocked = false;
  play() {
    this.plays++;
    if (this.blocked) return Promise.reject(new Error("NotAllowedError"));
    this.paused = false;
    return Promise.resolve();
  }
  pause() { this.pauses++; this.paused = true; }
  finish(trusted = true) {
    this.ended = true;
    this.dispatchEvent({ type: "ended", isTrusted: trusted });
  }
}

function anchor(path, label = "Next lecture", options = {}) {
  return {
    href: new URL(path, origin).href,
    textContent: label,
    clicks: 0,
    getAttribute(name) { return options[name] ?? null; },
    getClientRects() { return options.visible === false ? [] : [{}]; },
    closest() { return options.hidden ? {} : null; },
    click() { this.clicks++; options.click?.(); },
  };
}

function page({ path = `${course}lecture/one`, storage = new Map(), video = new Video() } = {}) {
  const window = new Target();
  const timers = new Map();
  const notices = [];
  let timerId = 0;
  let observe;
  class Document extends Target {
    videos = [video];
    anchors = [];
    get hidden() { return true; }
    get visibilityState() { return "hidden"; }
    get webkitHidden() { return true; }
    hasFocus() { return false; }
    body = { append(element) { notices.push(element); } };
    querySelectorAll(selector) { return selector === "video" ? this.videos : this.anchors; }
    createElement() {
      return Object.assign(new Target(), {
        style: {}, setAttribute() {}, remove() { this.removed = true; },
      });
    }
  }
  const document = new Document();
  const location = new URL(path, origin);
  class Event { constructor(type, init) { this.type = type; this.detail = init?.detail; } }
  vm.runInNewContext(source, {
    window, document, Document, location, URL, Event, CustomEvent: Event,
    MutationObserver: class { constructor(callback) { observe = callback; } observe() {} },
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    setTimeout: (callback) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id) => timers.delete(id),
  }, { filename: "playback.js" });
  return {
    window, document, location, video, notices, storage, timers,
    mutate: () => observe(),
    settings: (value = {}) => window.dispatchEvent(new Event("windowfocus:settings", {
      detail: JSON.stringify({ enabled: true, autoNext: true, ...value }),
    })),
    flush: () => {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const callback of callbacks) callback();
    },
  };
}

test("off by default; live toggling restores native focus and visibility", () => {
  const p = page();
  let losses = 0;
  p.window.addEventListener("blur", () => losses++);
  assert.equal(p.document.hasFocus(), false);
  assert.equal(p.document.hidden, true);
  p.window.dispatchEvent({ type: "blur" });
  assert.equal(losses, 1);
  p.settings();
  assert.equal(p.document.hasFocus(), true);
  assert.equal(p.document.hidden, false);
  assert.equal(p.document.visibilityState, "visible");
  p.window.dispatchEvent({ type: "blur" });
  assert.equal(losses, 1);
  p.settings({ enabled: false });
  p.window.dispatchEvent({ type: "blur" });
  assert.equal(losses, 2);
  assert.equal(p.document.hasFocus(), false);
  assert.equal(p.document.hidden, true);
});

test("document visibility handlers are blocked; form control blur is preserved", () => {
  const p = page();
  p.settings();
  let changes = 0;
  let formBlur = 0;
  p.window.addEventListener("visibilitychange", () => changes++);
  p.window.addEventListener("blur", () => formBlur++, true);
  p.window.dispatchEvent({ type: "visibilitychange", target: p.document });
  p.window.dispatchEvent({ type: "blur", target: { tagName: "INPUT" } });
  assert.equal(changes, 0);
  assert.equal(formBlur, 1);
});

test("switching from a lecture to a quiz restores native behavior", () => {
  const p = page();
  p.settings();
  p.location.pathname = `${course}quiz/test`;
  assert.equal(p.document.hasFocus(), false);
  assert.equal(p.document.hidden, true);
  let loss = false;
  p.window.addEventListener("blur", () => { loss = true; });
  p.window.dispatchEvent({ type: "blur" });
  assert.equal(loss, true);
  p.video.finish();
  assert.equal(p.timers.size, 0);
});

test("manual pause, seeking and playback speed are left alone", async () => {
  const p = page();
  p.settings();
  await p.video.play();
  p.video.pause();
  p.video.currentTime = 23;
  p.video.playbackRate = 1.5;
  p.mutate();
  assert.equal(p.video.paused, true);
  assert.equal(p.video.plays, 1);
  assert.equal(p.video.currentTime, 23);
  assert.equal(p.video.playbackRate, 1.5);
  assert.equal(p.timers.size, 0);
});

test("only a trusted end of playback schedules navigation, with a delay", () => {
  const p = page();
  p.settings();
  const next = anchor(`${course}lecture/two`);
  p.document.anchors = [next];
  p.video.dispatchEvent({ type: "ended", isTrusted: true });
  assert.equal(p.timers.size, 0);
  p.video.finish(false);
  assert.equal(p.timers.size, 0);
  p.video.finish();
  assert.equal(next.clicks, 0);
  assert.equal(p.timers.size, 1);
  p.flush();
  assert.equal(next.clicks, 1);
  assert.equal(p.video.plays, 0);
});

test("duplicate ended events navigate once", () => {
  const p = page();
  p.settings();
  const next = anchor(`${course}lecture/two`);
  p.document.anchors = [next];
  p.video.finish();
  p.video.finish();
  p.flush();
  assert.equal(next.clicks, 1);
});

const rejected = [
  ["quiz", () => anchor(`${course}quiz/test`)],
  ["reading", () => anchor(`${course}supplement/test`)],
  ["other course", () => anchor("/learn/other-course/lecture/two")],
  ["external link", () => anchor("https://example.com/learn/upgrading-apps-generative-ai/lecture/two")],
  ["current lecture", () => anchor(`${course}lecture/one`)],
  ["unrelated lecture title", () => anchor(`${course}lecture/two`, "What comes next in AI?")],
  ["hidden link", () => anchor(`${course}lecture/two`, "Next", { visible: false })],
  ["hidden container", () => anchor(`${course}lecture/two`, "Next", { hidden: true })],
  ["disabled link", () => anchor(`${course}lecture/two`, "Next", { "aria-disabled": "true" })],
];
for (const [name, make] of rejected) {
  test(`stops rather than following a ${name}`, () => {
    const p = page();
    p.settings();
    const next = make();
    p.document.anchors = [next];
    p.video.finish();
    p.flush();
    assert.equal(next.clicks, 0);
    assert.match(p.notices.at(-1).textContent, /No clear next-lecture link/);
  });
}

test("supports accessible next-item labels", () => {
  const p = page();
  p.settings();
  const next = anchor(`${course}lecture/two`, "Second lecture", { "aria-label": "Go to next item" });
  p.document.anchors = [next];
  p.video.finish();
  p.flush();
  assert.equal(next.clicks, 1);
});

test("does not navigate twice when Coursera already advances", () => {
  const p = page();
  p.settings();
  const next = anchor(`${course}lecture/three`);
  p.document.anchors = [next];
  p.video.finish();
  p.location.pathname = `${course}lecture/two`;
  p.flush();
  assert.equal(next.clicks, 0);
});

test("disabling auto-next or the extension cancels scheduled navigation", () => {
  for (const setting of [{ autoNext: false }, { enabled: false }]) {
    const p = page();
    p.settings();
    const next = anchor(`${course}lecture/two`);
    p.document.anchors = [next];
    p.video.finish();
    p.settings(setting);
    p.flush();
    assert.equal(next.clicks, 0);
    assert.equal(p.storage.size, 0);
  }
});

test("next video resumes once through SPA navigation, without replaying old video", () => {
  const p = page();
  p.settings();
  p.document.anchors = [anchor(`${course}lecture/two`, "Next", {
    click: () => { p.location.pathname = `${course}lecture/two`; },
  })];
  p.video.finish();
  p.flush();
  p.mutate();
  assert.equal(p.video.plays, 0);
  const nextVideo = new Video();
  nextVideo.currentSrc = "https://media.invalid/lecture-2.mp4";
  p.document.videos = [nextVideo];
  p.mutate();
  p.mutate();
  assert.equal(nextVideo.plays, 1);
  assert.equal(p.storage.size, 0);
});

test("full-page navigation waits for settings before consuming its play intent", () => {
  const p = page();
  p.settings();
  p.document.anchors = [anchor(`${course}lecture/two`)];
  p.video.finish();
  p.flush();
  const video = new Video();
  video.currentSrc = "https://media.invalid/lecture-2.mp4";
  video.readyState = 0;
  const next = page({ path: `${course}lecture/two`, storage: p.storage, video });
  assert.equal(p.storage.size, 1);
  next.settings();
  assert.equal(video.plays, 0);
  video.readyState = 4;
  video.dispatchEvent({ type: "loadeddata" });
  assert.equal(video.plays, 1);
  assert.equal(p.storage.size, 0);
});

test("blocked autoplay produces a visible prompt without retrying", async () => {
  const storage = new Map([["windowfocus:next-lecture", JSON.stringify({
    path: `${course}lecture/two`, source: "previous.mp4", expires: Date.now() + 20000,
  })]]);
  const video = new Video();
  video.blocked = true;
  const p = page({ path: `${course}lecture/two`, storage, video });
  p.settings();
  await Promise.resolve();
  p.mutate();
  assert.equal(video.plays, 1);
  assert.match(p.notices.at(-1).textContent, /blocked autoplay/);
});

test("expired intent does not start a video", () => {
  const storage = new Map([["windowfocus:next-lecture", JSON.stringify({
    path: `${course}lecture/two`, source: "previous.mp4", expires: Date.now() - 1,
  })]]);
  const p = page({ path: `${course}lecture/two`, storage });
  p.settings();
  assert.equal(p.video.plays, 0);
  assert.equal(storage.size, 0);
});
