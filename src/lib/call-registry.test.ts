import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CallRegistry,
  CallRegistryError,
  type CallUser,
} from "./call-registry.js";

const user = (id: string): CallUser => ({
  id,
  name: `User ${id}`,
  image: null,
});

function createGroupCall(registry: CallRegistry, count = 7) {
  return registry.create({
    id: "call-1",
    conversationId: "conversation-1",
    conversationName: "Conversation",
    callType: "VIDEO",
    mode: "GROUP",
    caller: user("caller"),
    invitees: Array.from({ length: count }, (_item, index) =>
      user(`member-${index + 1}`),
    ),
    now: 1_000,
  });
}

test("group call tracks invitees and enforces the eight-person limit", () => {
  const registry = new CallRegistry();
  const snapshot = createGroupCall(registry);

  assert.equal(snapshot.participants.length, 1);
  assert.equal(snapshot.pendingUserIds.length, 7);
  let active = snapshot;
  for (const userId of snapshot.pendingUserIds) {
    active = registry.accept(snapshot.id, userId, 2_000);
  }
  assert.equal(active.participants.length, 8);
  assert.equal(active.pendingUserIds.length, 0);

  assert.throws(
    () =>
      registry.create({
        id: "call-2",
        conversationId: "conversation-2",
        conversationName: "Conversation",
        callType: "AUDIO",
        mode: "GROUP",
        caller: user("other"),
        invitees: Array.from({ length: 8 }, (_item, index) =>
          user(`other-${index}`),
        ),
      }),
    (error: unknown) =>
      error instanceof CallRegistryError && error.code === "CALL_FULL",
  );
});

test("leaving an active call releases the departing participant", () => {
  const registry = new CallRegistry();
  createGroupCall(registry, 2);
  registry.accept("call-1", "member-1", 2_000);

  const result = registry.leave("call-1", "member-1");

  assert.equal(result.ended, false);
  assert.equal(registry.activeCallForUser("member-1"), null);
  assert.deepEqual(
    result.call.participants.map((participant) => participant.id),
    ["caller"],
  );
});

test("ending a one-to-one call releases the remaining participant", () => {
  const registry = new CallRegistry();
  registry.create({
    id: "call-1",
    conversationId: "conversation-1",
    conversationName: "Conversation",
    callType: "AUDIO",
    mode: "ONE_TO_ONE",
    caller: user("caller"),
    invitees: [user("recipient")],
  });
  registry.accept("call-1", "recipient", 2_000);

  const result = registry.leave("call-1", "recipient");

  assert.equal(result.ended, true);
  assert.equal(registry.activeCallForUser("caller"), null);
  assert.equal(registry.activeCallForUser("recipient"), null);
});

test("pending group invitees can join after another participant accepts", () => {
  const registry = new CallRegistry();
  const call = createGroupCall(registry, 2);

  registry.accept(call.id, "member-1", 2_000);
  const updated = registry.accept(call.id, "member-2", 62_000);

  assert.equal(updated.participants.length, 3);
  assert.deepEqual(
    updated.participants.map((participant) => participant.id),
    ["caller", "member-1", "member-2"],
  );
});

test("disconnect cleanup retains all recipients when the caller leaves", () => {
  const registry = new CallRegistry();
  const call = createGroupCall(registry, 2);
  registry.accept(call.id, "member-1", 2_000);

  const [disconnected] = registry.removeDisconnectedUser("caller");

  assert.equal(disconnected?.ended, false);
  assert.deepEqual(disconnected?.notifyUserIds, [
    "caller",
    "member-1",
    "member-2",
  ]);
});

test("only invited users can accept and active participants can exchange signals", () => {
  const registry = new CallRegistry();
  createGroupCall(registry);

  assert.throws(
    () => registry.accept("call-1", "intruder", 2_000),
    (error: unknown) =>
      error instanceof CallRegistryError && error.code === "NOT_INVITED",
  );

  const active = registry.accept("call-1", "member-1", 2_000);
  assert.deepEqual(active.participants.map((participant) => participant.id), [
    "caller",
    "member-1",
  ]);
  assert.equal(active.startedAt, 2_000);
  assert.equal(
    registry.validateSignal("call-1", "caller", "member-1").id,
    "call-1",
  );
  assert.throws(
    () => registry.validateSignal("call-1", "caller", "member-2"),
    (error: unknown) =>
      error instanceof CallRegistryError && error.code === "INVALID_RECIPIENT",
  );
});

test("calls prevent users from accepting duplicate simultaneous invitations", () => {
  const registry = new CallRegistry();
  registry.create({
    id: "call-1",
    conversationId: "conversation-1",
    conversationName: "Conversation",
    callType: "AUDIO",
    mode: "ONE_TO_ONE",
    caller: user("caller"),
    invitees: [user("recipient")],
  });

  assert.throws(
    () =>
      registry.create({
        id: "call-2",
        conversationId: "conversation-2",
        conversationName: "Conversation",
        callType: "VIDEO",
        mode: "ONE_TO_ONE",
        caller: user("other"),
        invitees: [user("recipient")],
      }),
    (error: unknown) =>
      error instanceof CallRegistryError && error.code === "CALL_BUSY",
  );
});

test("reject, cancel, leave, and disconnect release call membership", () => {
  const registry = new CallRegistry();
  registry.create({
    id: "call-1",
    conversationId: "conversation-1",
    conversationName: "Conversation",
    callType: "AUDIO",
    mode: "ONE_TO_ONE",
    caller: user("caller"),
    invitees: [user("recipient")],
  });

  assert.equal(registry.reject("call-1", "recipient").ended, true);
  assert.equal(registry.activeCallForUser("caller"), null);

  registry.create({
    id: "call-2",
    conversationId: "conversation-1",
    conversationName: "Conversation",
    callType: "AUDIO",
    mode: "ONE_TO_ONE",
    caller: user("caller"),
    invitees: [user("recipient")],
  });
  registry.cancel("call-2", "caller");
  assert.equal(registry.activeCallForUser("recipient"), null);

  registry.create({
    id: "call-3",
    conversationId: "conversation-1",
    conversationName: "Conversation",
    callType: "AUDIO",
    mode: "ONE_TO_ONE",
    caller: user("caller"),
    invitees: [user("recipient")],
  });
  registry.accept("call-3", "recipient");
  assert.equal(registry.removeDisconnectedUser("recipient")[0]?.ended, true);
  assert.equal(registry.activeCallForUser("caller"), null);
  assert.equal(registry.activeCallForUser("recipient"), null);
  assert.deepEqual(registry.removeDisconnectedUser("caller"), []);
});

test("unanswered calls expire and release caller and invitees", () => {
  const registry = new CallRegistry();
  registry.create({
    id: "call-1",
    conversationId: "conversation-1",
    conversationName: "Conversation",
    callType: "VIDEO",
    mode: "ONE_TO_ONE",
    caller: user("caller"),
    invitees: [user("recipient")],
    now: 1_000,
  });

  assert.equal(registry.expire(60_999).length, 0);
  assert.equal(registry.expire(61_000).length, 1);
  assert.equal(registry.activeCallForUser("caller"), null);
  assert.equal(registry.activeCallForUser("recipient"), null);
});
