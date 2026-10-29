import { ConversationRole } from "../generated/prisma/client.js";

export function canManageConversation(role: ConversationRole) {
  return role === ConversationRole.OWNER || role === ConversationRole.ADMIN;
}

export function canRemoveParticipant(
  actorId: string,
  actorRole: ConversationRole,
  participantId: string,
  participantRole: ConversationRole,
) {
  return (
    participantRole !== ConversationRole.OWNER &&
    (actorId === participantId || canManageConversation(actorRole))
  );
}

export function canModifyMessage(senderId: string, actorId: string) {
  return senderId === actorId;
}
