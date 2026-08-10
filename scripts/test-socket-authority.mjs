import assert from "node:assert/strict";

import {
  authenticateSocketPayload,
  withAuthenticatedOrigin,
} from "./socket-authority.js";

assert.equal(
  authenticateSocketPayload({ originUserId: "claimed-user" }),
  null,
  "a payload claim is not transport authentication",
);
assert.equal(
  authenticateSocketPayload({ originUserId: "claimed-user" }, "other-user"),
  null,
  "transport identity defeats a forged payload origin",
);
assert.equal(
  authenticateSocketPayload({ originUserId: " sender " }, "sender"),
  "sender",
  "matching identities are normalized",
);
assert.equal(
  authenticateSocketPayload({}, " sender "),
  "sender",
  "the trusted transport may supply a missing payload origin",
);
assert.equal(authenticateSocketPayload({}, "  "), null);
assert.equal(
  authenticateSocketPayload({}, "x".repeat(161)),
  null,
  "transport identities are bounded before routing",
);
assert.deepEqual(withAuthenticatedOrigin({ type: "test" }, " sender "), {
  type: "test",
  originUserId: "sender",
});

process.stdout.write("socket transport identity contract passed\n");
