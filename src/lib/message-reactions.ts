import { HttpError } from "./errors.js";

export type MessageReactionValue = { userId: string; emoji: string };
type AccessibleMessage = { conversationId: string; deletedAt: Date | null };

export type MessageReactionStore = {
  findAccessibleMessage(
    messageId: string,
    userId: string,
  ): Promise<AccessibleMessage | null>;
  set(messageId: string, userId: string, emoji: string): Promise<void>;
  remove(messageId: string, userId: string): Promise<void>;
  list(messageId: string): Promise<MessageReactionValue[]>;
};

async function requireAccessibleMessage(
  store: MessageReactionStore,
  messageId: string,
  userId: string,
) {
  const message = await store.findAccessibleMessage(messageId, userId);
  if (!message) {
    throw new HttpError(404, "NOT_FOUND", "Message not found.");
  }
  return message;
}

export async function setMessageReaction(
  store: MessageReactionStore,
  messageId: string,
  userId: string,
  emoji: string,
) {
  const message = await requireAccessibleMessage(store, messageId, userId);
  if (message.deletedAt) {
    throw new HttpError(409, "MESSAGE_DELETED", "Deleted messages cannot be reacted to.");
  }
  await store.set(messageId, userId, emoji);
  return { conversationId: message.conversationId, reactions: await store.list(messageId) };
}

export async function removeMessageReaction(
  store: MessageReactionStore,
  messageId: string,
  userId: string,
) {
  const message = await requireAccessibleMessage(store, messageId, userId);
  await store.remove(messageId, userId);
  return { conversationId: message.conversationId, reactions: await store.list(messageId) };
}
