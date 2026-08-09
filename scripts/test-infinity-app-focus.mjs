import assert from "node:assert/strict";

const previousDocument = globalThis.document;
const previousGame = globalThis.game;
const previousRequestAnimationFrame = globalThis.requestAnimationFrame;

let originFocusCount = 0;
const origin = {
  disabled: false,
  isConnected: true,
  focus() {
    originFocusCount += 1;
  },
};
globalThis.document = { activeElement: origin, body: {} };
globalThis.game = null;
globalThis.requestAnimationFrame = (callback) => callback();

const { applyUiFoundation, bindFocusRestoration, openSingleton } =
  await import("./infinity-app.js");

{
  class ExampleApp {
    static _instance = null;

    constructor() {
      this.rendered = false;
      this.renderCalls = 0;
      this.frontCalls = 0;
    }

    render() {
      this.renderCalls += 1;
      this.rendered = true;
    }

    bringToFront() {
      this.frontCalls += 1;
    }

    async close() {
      this.rendered = false;
    }
  }

  const first = openSingleton(ExampleApp, () => new ExampleApp());
  assert.equal(first.renderCalls, 1);
  assert.equal(
    openSingleton(ExampleApp, () => new ExampleApp()),
    first,
  );
  assert.equal(first.frontCalls, 1);
  await first.close();
  assert.equal(originFocusCount, 1, "closing restores the invoking control");
}

{
  let closed = 0;
  const app = {
    async close() {
      closed += 1;
      return "closed";
    },
  };
  assert.equal(bindFocusRestoration(app), app);
  assert.equal(await app.close(), "closed");
  assert.equal(closed, 1);
  assert.equal(originFocusCount, 2);
  bindFocusRestoration(app);
  await app.close();
  assert.equal(closed, 2, "focus wrapping is idempotent");
  assert.equal(originFocusCount, 3);
}

{
  const classes = new Set();
  const properties = new Map();
  const root = {
    dataset: {},
    classList: {
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
    },
    style: {
      setProperty(name, value) {
        properties.set(name, value);
      },
    },
  };
  applyUiFoundation(root);
  assert.equal(properties.get("container-type"), "inline-size");
  assert.equal(root.dataset.infinityDensity, "comfortable");
  assert.equal(classes.has("infinity-density--comfortable"), true);
}

globalThis.document = previousDocument;
globalThis.game = previousGame;
globalThis.requestAnimationFrame = previousRequestAnimationFrame;

process.stdout.write(
  "application focus and root foundation validation passed\n",
);
