import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  INFINITY_DIALOG_CLASSES,
  applyInfinityDialogContract,
  confirmInfinityDialog,
  isInfinityDialogAvailable,
  promptInfinityDialog,
} from "./dialog-contract.js";

const previousFoundry = globalThis.foundry;
const previousDocument = globalThis.document;
const previousAnimationFrame = globalThis.requestAnimationFrame;

try {
  delete globalThis.foundry;
  delete globalThis.document;
  delete globalThis.requestAnimationFrame;

  assert.equal(isInfinityDialogAvailable(), false);
  assert.equal(isInfinityDialogAvailable("confirm"), false);
  assert.equal(await confirmInfinityDialog({}), false);
  assert.equal(await promptInfinityDialog({}), null);

  const sourceOptions = {
    classes: ["custom-dialog", "infinity-dnd5e"],
    window: { title: "Contract test" },
    content: "<p>Unchanged</p>",
  };
  const contracted = applyInfinityDialogContract(sourceOptions);
  assert.deepEqual(contracted.classes, [
    "custom-dialog",
    ...INFINITY_DIALOG_CLASSES,
  ]);
  assert.equal(contracted.rejectClose, false);
  assert.notEqual(contracted, sourceOptions);
  assert.notEqual(contracted.window, sourceOptions.window);
  assert.equal(
    Object.prototype.hasOwnProperty.call(sourceOptions, "rejectClose"),
    false,
    "the caller's options are not mutated",
  );
  assert.equal(
    applyInfinityDialogContract({ rejectClose: true }).rejectClose,
    true,
    "an explicit close policy is preserved",
  );

  let receivedOptions = null;
  const marker = { exact: "callback-value" };
  const yes = { callback: () => marker };
  globalThis.foundry = {
    applications: {
      api: {
        DialogV2: {
          async confirm(options) {
            receivedOptions = options;
            return options.yes.callback();
          },
          async prompt(options) {
            receivedOptions = options;
            return options.ok.callback();
          },
        },
      },
    },
  };

  assert.equal(isInfinityDialogAvailable("confirm"), true);
  assert.equal(await confirmInfinityDialog({ yes }), marker);
  assert.equal(receivedOptions.yes, yes, "button definitions remain intact");
  assert.ok(receivedOptions.classes.includes("infinity-dialog"));

  for (const value of [false, 0, "", null, undefined]) {
    const callback = () => value;
    const result = await promptInfinityDialog({ ok: { callback } });
    assert.equal(result, value, `prompt preserves ${String(value)}`);
    assert.equal(receivedOptions.ok.callback, callback);
  }

  let observedError = null;
  globalThis.foundry.applications.api.DialogV2.confirm = async () => {
    throw new Error("closed");
  };
  assert.equal(
    await confirmInfinityDialog(
      {},
      {
        cancelValue: "cancelled",
        onError: (error) => {
          observedError = error;
        },
      },
    ),
    "cancelled",
  );
  assert.match(observedError.message, /closed/);

  let focusCalls = 0;
  const origin = {
    isConnected: true,
    disabled: false,
    focus(options) {
      focusCalls += 1;
      assert.deepEqual(options, { preventScroll: true });
    },
  };
  globalThis.document = { activeElement: origin, body: {} };
  globalThis.requestAnimationFrame = (callback) => callback();
  globalThis.foundry.applications.api.DialogV2.prompt = async () => "picked";
  assert.equal(await promptInfinityDialog({}), "picked");
  assert.equal(focusCalls, 1, "focus returns to the dialog opener");
} finally {
  restoreGlobal("foundry", previousFoundry);
  restoreGlobal("document", previousDocument);
  restoreGlobal("requestAnimationFrame", previousAnimationFrame);
}

for (const file of [
  "ui-util.js",
  "downtime-workspace.js",
  "merchant-session.js",
  "merchant-workspace.js",
  "resource-manager.js",
  "reputation-workspace.js",
  "loot/distribute.js",
  "merchant/socket.js",
  "resource/calendar-watcher.js",
  "injury/service.js",
]) {
  const source = await readFile(new URL(file, import.meta.url), "utf8");
  assert.doesNotMatch(
    source,
    /DialogV2\.(?:confirm|prompt|wait)\(/,
    `${file} delegates direct DialogV2 calls to the shared contract`,
  );
}

function restoreGlobal(key, value) {
  if (value === undefined) delete globalThis[key];
  else globalThis[key] = value;
}

process.stdout.write("dialog-contract validation passed\n");
