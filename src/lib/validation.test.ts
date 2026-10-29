import assert from "node:assert/strict";
import { test } from "node:test";
import {
  groupConversationBodySchema,
  listQuerySchema,
  listMessagesQuerySchema,
  messageBodySchema,
  profileBodySchema,
  userSearchQuerySchema,
} from "./validation.js";

test("message content is trimmed and capped", () => {
  assert.deepEqual(messageBodySchema.parse({ content: "  hello  " }), {
    content: "hello",
  });
  assert.equal(messageBodySchema.safeParse({ content: " " }).success, false);
  assert.equal(
    messageBodySchema.safeParse({ content: "x".repeat(8001) }).success,
    false,
  );
});

test("message history pagination enforces bounded page sizes", () => {
  assert.deepEqual(listMessagesQuerySchema.parse({}), {
    limit: 50,
  });
  assert.equal(
    listMessagesQuerySchema.safeParse({ limit: 101 }).success,
    false,
  );
  assert.deepEqual(listQuerySchema.parse({}), { limit: 20 });
  assert.equal(listQuerySchema.safeParse({ limit: 51 }).success, false);
});

test("user search requires a concise query", () => {
  assert.deepEqual(userSearchQuerySchema.parse({ query: "  maya " }), {
    query: "maya",
    limit: 20,
  });
  assert.equal(userSearchQuerySchema.safeParse({ query: "a" }).success, false);
});

test("group creation limits names and participant counts", () => {
  assert.deepEqual(groupConversationBodySchema.parse({
    name: "  Team ",
    participantIds: ["person-1"],
  }), {
    name: "Team",
    participantIds: ["person-1"],
  });
  assert.equal(
    groupConversationBodySchema.safeParse({
      name: "x".repeat(101),
      participantIds: [],
    }).success,
    false,
  );
  assert.equal(
    groupConversationBodySchema.safeParse({
      name: "Team",
      participantIds: Array.from({ length: 50 }, (_, index) => String(index)),
    }).success,
    false,
  );
  assert.equal(
    groupConversationBodySchema.safeParse({
      name: "Team",
      participantIds: [],
    }).success,
    false,
  );
});

test("profile updates allow only valid, supported fields", () => {
  assert.deepEqual(
    profileBodySchema.parse({
      name: "  Maya Lin ",
      image: "https://images.example/avatar.png",
      statusMessage: "  Available ",
    }),
    {
      name: "Maya Lin",
      image: "https://images.example/avatar.png",
      statusMessage: "Available",
    },
  );
  assert.equal(profileBodySchema.safeParse({ email: "private@example.com" }).success, false);
  assert.equal(profileBodySchema.safeParse({ name: "x" }).success, false);
});
