import assert from "node:assert/strict";
import { test } from "node:test";
import { UserSocketRegistry } from "./presence.js";

test("presence remains online until a user's final authenticated socket disconnects", () => {
  const registry = new UserSocketRegistry();
  assert.equal(registry.connect("user-1", "tab-1"), true);
  assert.equal(registry.connect("user-1", "tab-2"), false);
  assert.equal(registry.isOnline("user-1"), true);

  assert.deepEqual(registry.disconnect("user-1", "tab-1"), {
    found: true,
    lastSocket: false,
  });
  assert.equal(registry.isOnline("user-1"), true);
  assert.deepEqual(registry.disconnect("user-1", "tab-2"), {
    found: true,
    lastSocket: true,
  });
  assert.equal(registry.isOnline("user-1"), false);
});

test("presence ignores stale disconnects and returns only active requested users", () => {
  const registry = new UserSocketRegistry();
  registry.connect("online", "active-socket");
  assert.deepEqual(registry.disconnect("online", "old-socket"), {
    found: false,
    lastSocket: false,
  });
  assert.deepEqual(
    registry.onlineUserIds(["online", "offline"]),
    new Set(["online"]),
  );
});
