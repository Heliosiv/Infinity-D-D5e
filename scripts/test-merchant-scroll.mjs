import assert from "node:assert/strict";
import {
  bindScrollTracking,
  captureScroll,
  restoreScroll,
} from "./merchant/scroll.js";

const previousFrame = globalThis.requestAnimationFrame;
const previousTimeout = globalThis.setTimeout;
const frames = [];
const delays = [];
globalThis.requestAnimationFrame = (callback) => frames.push(callback);
globalThis.setTimeout = (callback) => delays.push(callback);

const targets = [{ key: "shell", selector: ".shell" }];
function pane(height = 500) {
  const listeners = [];
  let top = 0;
  return {
    dataset: {},
    scrollHeight: height,
    clientHeight: 100,
    scrollWidth: 100,
    clientWidth: 100,
    scrollLeft: 0,
    get scrollTop() {
      return top;
    },
    set scrollTop(value) {
      top = Math.min(value, Math.max(0, this.scrollHeight - this.clientHeight));
    },
    addEventListener(type, listener) {
      if (type === "scroll") listeners.push(listener);
    },
    scrollTo(value) {
      this.scrollTop = value;
      for (const listener of listeners) listener();
    },
  };
}
function root(element) {
  return {
    querySelector: (selector) => (selector === ".shell" ? element : null),
  };
}
function flush() {
  while (frames.length) frames.shift()();
  while (delays.length) delays.shift()();
}

try {
  const oldPane = pane();
  const oldRoot = root(oldPane);
  let saved = null;
  bindScrollTracking(oldRoot, targets, () => {
    saved = captureScroll(oldRoot, targets);
  });
  oldPane.scrollTo(260);
  assert.equal(saved.entries[0].top, 260);

  const newPane = pane(100); // layout has not expanded yet
  const newRoot = root(newPane);
  restoreScroll(newRoot, targets, saved, { settleMs: 50 });
  assert.equal(newPane.scrollTop, 0);
  newPane.scrollHeight = 500;
  flush();
  assert.equal(newPane.scrollTop, 260, "late layout restores the saved view");

  newPane.scrollTo(80);
  const later = captureScroll(newRoot, targets);
  restoreScroll(newRoot, targets, later, { settleMs: 50 });
  newPane.scrollTo(120);
  flush();
  assert.equal(newPane.scrollTop, 120, "a new user scroll wins over retries");

  const replaced = pane();
  let current = newPane;
  const changingRoot = { querySelector: () => current };
  restoreScroll(changingRoot, targets, saved, { settleMs: 50 });
  current = replaced;
  flush();
  assert.equal(replaced.scrollTop, 0, "old retries do not move a later render");
  assert.equal(captureScroll(root(null), targets), null);
} finally {
  globalThis.requestAnimationFrame = previousFrame;
  globalThis.setTimeout = previousTimeout;
}

console.log("Merchant scroll tracking and restoration passed.");
