import assert from "node:assert/strict";
import { test } from "node:test";
import { ConversationRole } from "../generated/prisma/client.js";
import {
  canManageConversation,
  canModifyMessage,
  canRemoveParticipant,
} from "./authorization.js";

test("only group owners and admins can manage participants", () => {
  assert.equal(canManageConversation(ConversationRole.OWNER), true);
  assert.equal(canManageConversation(ConversationRole.ADMIN), true);
  assert.equal(canManageConversation(ConversationRole.MEMBER), false);
});

test("members can leave while only managers can remove other members", () => {
  assert.equal(
    canRemoveParticipant(
      "member-a",
      ConversationRole.MEMBER,
      "member-a",
      ConversationRole.MEMBER,
    ),
    true,
  );
  assert.equal(
    canRemoveParticipant(
      "member-a",
      ConversationRole.MEMBER,
      "member-b",
      ConversationRole.MEMBER,
    ),
    false,
  );
  assert.equal(
    canRemoveParticipant(
      "owner",
      ConversationRole.OWNER,
      "member-b",
      ConversationRole.MEMBER,
    ),
    true,
  );
  assert.equal(
    canRemoveParticipant(
      "owner",
      ConversationRole.OWNER,
      "owner",
      ConversationRole.OWNER,
    ),
    false,
  );
});

test("only message authors may edit or delete a message", () => {
  assert.equal(canModifyMessage("author", "author"), true);
  assert.equal(canModifyMessage("author", "another-member"), false);
});
