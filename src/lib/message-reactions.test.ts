import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "./errors.js";
import {
  removeMessageReaction,
  setMessageReaction,
  type MessageReactionStore,
} from "./message-reactions.js";

function createStore(isMember = true, isDeleted = false): MessageReactionStore {
  const reactions = new Map<string, string>();
  return {
    async findAccessibleMessage() {
      return isMember
        ? {
            conversationId: "conversation-1",
            deletedAt: isDeleted ? new Date() : null,
          }
        : null;
    },
    async set(_messageId, userId, emoji) {
      reactions.set(userId, emoji);
    },
    async remove(_messageId, userId) {
      reactions.delete(userId);
    },
    async list() {
      return [...reactions].map(([userId, emoji]) => ({ userId, emoji }));
    },
  };
}

test("reaction creation and change preserve one reaction per user and message", async () => {
  const store = createStore();
  const created = await setMessageReaction(store, "message-1", "user-1", "❤️");
  assert.deepEqual(created, {
    conversationId: "conversation-1",
    reactions: [{ userId: "user-1", emoji: "❤️" }],
  });

  const changed = await setMessageReaction(store, "message-1", "user-1", "👍");
  assert.deepEqual(changed.reactions, [{ userId: "user-1", emoji: "👍" }]);
  const secondUser = await setMessageReaction(store, "message-1", "user-2", "😂");
  assert.equal(secondUser.reactions.length, 2);
});

test("reaction removal is idempotent and removes only the authenticated user's reaction", async () => {
  const store = createStore();
  await setMessageReaction(store, "message-1", "user-1", "❤️");
  await setMessageReaction(store, "message-1", "user-2", "😂");

  const removed = await removeMessageReaction(store, "message-1", "user-1");
  assert.deepEqual(removed.reactions, [{ userId: "user-2", emoji: "😂" }]);
  const repeated = await removeMessageReaction(store, "message-1", "user-1");
  assert.deepEqual(repeated.reactions, [{ userId: "user-2", emoji: "😂" }]);
});

test("reaction mutations require conversation membership", async () => {
  await assert.rejects(
    setMessageReaction(createStore(false), "message-1", "outsider", "❤️"),
    (error: unknown) =>
      error instanceof HttpError && error.status === 404,
  );
  await assert.rejects(
    removeMessageReaction(createStore(false), "message-1", "outsider"),
    (error: unknown) =>
      error instanceof HttpError && error.status === 404,
  );
});

test("deleted messages cannot receive new reactions", async () => {
  await assert.rejects(
    setMessageReaction(createStore(true, true), "message-1", "user-1", "❤️"),
    (error: unknown) =>
      error instanceof HttpError && error.code === "MESSAGE_DELETED",
  );
});
