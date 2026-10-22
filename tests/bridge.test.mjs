import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../extension/bridge.js", import.meta.url), "utf8");
const settle = () => new Promise(setImmediate);

function bridge(initial = {}) {
  const window = new EventTarget();
  const published = [];
  const state = { ...initial };
  let storageListener;
  let unavailable = false;
  window.addEventListener("windowfocus:settings", (event) => {
    published.push(JSON.parse(event.detail));
  });
  vm.runInNewContext(source, {
    window, CustomEvent,
    chrome: { storage: {
      local: { async get(defaults) {
        if (unavailable) throw new Error("Extension context invalidated");
        return { ...defaults, ...state };
      } },
      onChanged: { addListener(callback) { storageListener = callback; } },
    } },
  });
  return {
    window, published,
    unavailable() { unavailable = true; },
    change(value, area = "local") {
      Object.assign(state, value);
      storageListener(Object.fromEntries(Object.entries(value).map(([key, newValue]) => [key, { newValue }])), area);
    },
  };
}

test("bridge defaults off and publishes saved settings on startup", async () => {
  const off = bridge();
  const on = bridge({ enabled: true, autoNext: false });
  await settle();
  assert.deepEqual(off.published, [{ enabled: false, autoNext: true }]);
  assert.deepEqual(on.published, [{ enabled: true, autoNext: false }]);
});

test("ready handshake recovers either content-script startup order", async () => {
  const b = bridge({ enabled: true });
  await settle();
  b.published.length = 0;
  b.window.dispatchEvent(new Event("windowfocus:ready"));
  await settle();
  assert.deepEqual(b.published, [{ enabled: true, autoNext: true }]);
});

test("local settings changes propagate without a page reload", async () => {
  const b = bridge();
  await settle();
  b.change({ enabled: true });
  await settle();
  b.change({ autoNext: false });
  await settle();
  assert.deepEqual(b.published.at(-1), { enabled: true, autoNext: false });
});

test("unrelated storage changes do not publish settings", async () => {
  const b = bridge();
  await settle();
  b.change({ enabled: true }, "sync");
  b.change({ unrelated: true });
  await settle();
  assert.equal(b.published.length, 1);
});

test("storage failure disables both features", async () => {
  const b = bridge({ enabled: true });
  await settle();
  b.unavailable();
  b.window.dispatchEvent(new Event("windowfocus:ready"));
  await settle();
  assert.deepEqual(b.published.at(-1), { enabled: false, autoNext: false });
});
