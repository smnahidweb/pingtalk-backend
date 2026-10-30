import { ConversationRole, ConversationType } from "../generated/prisma/client.js";
import express, { Router } from "express";
import { prisma } from "../lib/prisma.js";
import {
  emitMessageCreated,
  emitMessageReactionsUpdated,
  emitReadReceipt,
  emitUserProfileUpdated,
} from "../lib/socket.js";
import { HttpError, asyncRoute } from "../lib/errors.js";
import {
  removeMessageReaction,
  setMessageReaction,
  type MessageReactionStore,
} from "../lib/message-reactions.js";
import {
  deleteProfileImage,
  isProfileImageStorageConfigured,
  PROFILE_IMAGE_MAX_BYTES,
  uploadProfileImage,
  validateProfileImage,
} from "../lib/profile-image.js";
import {
  canManageConversation,
  canModifyMessage,
  canRemoveParticipant,
} from "../lib/authorization.js";
import {
  addParticipantBodySchema,
  conversationIdParamsSchema,
  groupConversationBodySchema,
  groupNameBodySchema,
  listQuerySchema,
  listMessagesQuerySchema,
  messageBodySchema,
  messageParamsSchema,
  messageReactionBodySchema,
  participantParamsSchema,
  privateConversationBodySchema,
  profileBodySchema,
  userParamsSchema,
  userSearchQuerySchema,
} from "../lib/validation.js";
import { authenticate } from "../middleware/authenticate.js";

type RouteParams = Record<string, string>;

function requireUser(request: import("express").Request): string {
  if (!request.user) {
    throw new HttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
  }
  return request.user.id;
}

async function requireMembership(conversationId: string, userId: string) {
  const membership = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
    select: { id: true, role: true },
  });
  if (!membership) {
    throw new HttpError(404, "NOT_FOUND", "Conversation not found.");
  }
  return membership;
}

async function requireMessageAccess(messageId: string, userId: string) {
  const message = await prisma.message.findFirst({
    where: {
      id: messageId,
      conversation: { memberships: { some: { userId } } },
    },
    select: { id: true, senderId: true, conversationId: true, deletedAt: true },
  });
  if (!message) {
    throw new HttpError(404, "NOT_FOUND", "Message not found.");
  }
  return message;
}

export const apiRouter = Router();
apiRouter.use(authenticate);

const messageReactionStore: MessageReactionStore = {
  findAccessibleMessage: async (messageId, userId) => {
    try {
      return await requireMessageAccess(messageId, userId);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return null;
      throw error;
    }
  },
  async set(messageId, userId, emoji) {
    await prisma.messageReaction.upsert({
      where: { messageId_userId: { messageId, userId } },
      create: { messageId, userId, emoji },
      update: { emoji },
    });
  },
  async remove(messageId, userId) {
    await prisma.messageReaction.deleteMany({
      where: { messageId, userId },
    });
  },
  list(messageId) {
    return prisma.messageReaction.findMany({
      where: { messageId },
      select: { userId: true, emoji: true },
    });
  },
};

apiRouter.get(
  "/me",
  asyncRoute(async (request, response) => {
    const userId = requireUser(request);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        createdAt: true,
        profile: { select: { statusMessage: true } },
      },
    });
    if (!user) throw new HttpError(401, "UNAUTHENTICATED", "Your session is no longer valid.");
    response.json({ user });
  }),
);

apiRouter.patch(
  "/me",
  asyncRoute(async (request, response) => {
    const userId = requireUser(request);
    const profileInput = profileBodySchema.parse(request.body);
    const user = await prisma.$transaction(async (transaction) => {
      if (profileInput.name !== undefined || profileInput.image !== undefined) {
        await transaction.user.update({
          where: { id: userId },
          data: {
            ...(profileInput.name !== undefined ? { name: profileInput.name } : {}),
            ...(profileInput.image !== undefined ? { image: profileInput.image } : {}),
          },
        });
      }

      const profile =
        profileInput.statusMessage === undefined
          ? await transaction.userProfile.findUnique({
              where: { userId },
              select: { statusMessage: true },
            })
          : await transaction.userProfile.upsert({
              where: { userId },
              create: { userId, statusMessage: profileInput.statusMessage },
              update: { statusMessage: profileInput.statusMessage },
              select: { statusMessage: true },
            });

      const updatedUser = await transaction.user.findUniqueOrThrow({
        where: { id: userId },
        select: { id: true, name: true, email: true, image: true },
      });
      return { ...updatedUser, profile };
    });
    await emitUserProfileUpdated(userId, {
      id: user.id,
      name: user.name,
      image: user.image,
    });
    response.json({ user });
  }),
);

apiRouter.post(
  "/me/image",
  express.raw({ type: () => true, limit: PROFILE_IMAGE_MAX_BYTES }),
  asyncRoute(async (request, response) => {
    const userId = requireUser(request);
    const contentType = (
      request.get("content-type")?.split(";")[0] ?? ""
    )
      .trim()
      .toLowerCase();
    if (!Buffer.isBuffer(request.body)) {
      throw new HttpError(400, "INVALID_IMAGE", "The request must contain an image file.");
    }
    validateProfileImage(request.body, contentType);
    const uploaded = await uploadProfileImage(userId, request.body, contentType);
    const user = await prisma.user.update({
      where: { id: userId },
      data: { image: uploaded.image },
      select: { id: true, name: true, email: true, image: true },
    });
    await emitUserProfileUpdated(userId, {
      id: user.id,
      name: user.name,
      image: user.image,
    });
    response.json({ user });
  }),
);

apiRouter.delete(
  "/me/image",
  asyncRoute(async (request, response) => {
    const userId = requireUser(request);
    if (isProfileImageStorageConfigured()) {
      await deleteProfileImage(userId);
    }
    const user = await prisma.user.update({
      where: { id: userId },
      data: { image: null },
      select: { id: true, name: true, email: true, image: true },
    });
    await emitUserProfileUpdated(userId, {
      id: user.id,
      name: user.name,
      image: user.image,
    });
    response.json({ user });
  }),
);

apiRouter.get(
  "/users/:userId",
  asyncRoute<RouteParams>(async (request, response) => {
    const currentUserId = requireUser(request);
    const { userId } = userParamsSchema.parse(request.params);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        image: true,
        profile: { select: { statusMessage: true } },
      },
    });
    if (!user || user.id === currentUserId) {
      throw new HttpError(404, "USER_NOT_FOUND", "That user could not be found.");
    }
    response.json({ user });
  }),
);

apiRouter.get(
  "/users",
  asyncRoute(async (request, response) => {
    const userId = requireUser(request);
    const { query, cursor, limit } = userSearchQuerySchema.parse(request.query);
    const where = {
      id: { not: userId },
      OR: [
        { name: { contains: query, mode: "insensitive" as const } },
        { email: { contains: query, mode: "insensitive" as const } },
      ],
    };
    if (cursor) {
      const cursorUser = await prisma.user.findFirst({
        where: { AND: [where, { id: cursor }] },
        select: { id: true },
      });
      if (!cursorUser) {
        throw new HttpError(400, "INVALID_CURSOR", "The user cursor is invalid.");
      }
    }
    const users = await prisma.user.findMany({
      where,
      select: { id: true, name: true, image: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = users.length > limit;
    const page = users.slice(0, limit);
    response.json({
      users: page,
      nextCursor: hasMore ? page.at(-1)?.id ?? null : null,
      hasMore,
    });
  }),
);

apiRouter.get(
  "/conversations",
  asyncRoute(async (request, response) => {
    const userId = requireUser(request);
    const { cursor, limit } = listQuerySchema.parse(request.query);
    if (cursor) {
      const cursorConversation = await prisma.conversation.findFirst({
        where: { id: cursor, memberships: { some: { userId } } },
        select: { id: true },
      });
      if (!cursorConversation) {
        throw new HttpError(400, "INVALID_CURSOR", "The conversation cursor is invalid.");
      }
    }
    const conversations = await prisma.conversation.findMany({
      where: { memberships: { some: { userId } } },
      include: {
        memberships: {
          orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
          take: 50,
          select: {
            userId: true,
            role: true,
            user: { select: { id: true, name: true, image: true } },
          },
        },
        messages: {
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 1,
          select: {
            id: true,
            content: true,
            createdAt: true,
            deletedAt: true,
            senderId: true,
            sender: { select: { name: true } },
          },
        },
        _count: { select: { memberships: true } },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = conversations.length > limit;
    const page = conversations.slice(0, limit);
    const unreadCounts = await prisma.message.groupBy({
      by: ["conversationId"],
      where: {
        conversationId: { in: page.map((conversation) => conversation.id) },
        senderId: { not: userId },
        readReceipts: { none: { userId } },
      },
      _count: { _all: true },
    });
    const unreadCountByConversation = new Map(
      unreadCounts.map((entry) => [entry.conversationId, entry._count._all]),
    );

    const results = page.map((conversation) => {
        const unreadCount = unreadCountByConversation.get(conversation.id) ?? 0;
        const latestMessage = conversation.messages[0];
        const otherMembers = conversation.memberships.filter(
          (membership) => membership.userId !== userId,
        );
        const title =
          conversation.type === ConversationType.PRIVATE
            ? otherMembers[0]?.user.name ?? "Unknown member"
            : conversation.title ?? "Group conversation";
        const lastMessage = latestMessage
          ? latestMessage.deletedAt
            ? "Message deleted"
            : latestMessage.content
          : "";

        return {
          id: conversation.id,
          type: conversation.type,
          title,
          updatedAt: conversation.updatedAt,
          memberCount: conversation._count.memberships,
          unreadCount,
          lastMessage: latestMessage
            ? {
                id: latestMessage.id,
                content: lastMessage,
                createdAt: latestMessage.createdAt,
                senderId: latestMessage.senderId,
                senderName: latestMessage.sender.name,
              }
            : null,
          members: conversation.memberships.map((membership) => ({
            id: membership.user.id,
            name:
              membership.userId === userId
                ? "You"
                : membership.user.name,
            image: membership.user.image,
            role: membership.role,
          })),
        };
      });
    response.json({
      conversations: results,
      nextCursor: hasMore ? page.at(-1)?.id ?? null : null,
      hasMore,
    });
  }),
);

apiRouter.get(
  "/conversations/:conversationId",
  asyncRoute<RouteParams>(async (request, response) => {
    const userId = requireUser(request);
    const { conversationId } = conversationIdParamsSchema.parse(request.params);
    await requireMembership(conversationId, userId);
    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: {
        id: true,
        type: true,
        title: true,
        createdAt: true,
        updatedAt: true,
        memberships: {
          orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
          take: 50,
          select: {
            userId: true,
            role: true,
            joinedAt: true,
            user: { select: { id: true, name: true, image: true } },
          },
        },
        _count: { select: { memberships: true } },
      },
    });
    response.json({
      conversation: {
        id: conversation.id,
        type: conversation.type,
        title: conversation.title,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        memberCount: conversation._count.memberships,
        members: conversation.memberships.map((membership) => ({
          ...membership.user,
          role: membership.role,
          joinedAt: membership.joinedAt,
        })),
      },
    });
  }),
);

apiRouter.get(
  "/conversations/:conversationId/participants",
  asyncRoute<RouteParams>(async (request, response) => {
    const userId = requireUser(request);
    const { conversationId } = conversationIdParamsSchema.parse(request.params);
    const { cursor, limit } = listQuerySchema.parse(request.query);
    await requireMembership(conversationId, userId);
    if (cursor) {
      const cursorMember = await prisma.conversationMember.findFirst({
        where: { id: cursor, conversationId },
        select: { id: true },
      });
      if (!cursorMember) {
        throw new HttpError(400, "INVALID_CURSOR", "The participant cursor is invalid.");
      }
    }
    const memberships = await prisma.conversationMember.findMany({
      where: { conversationId },
      orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        userId: true,
        role: true,
        joinedAt: true,
        user: { select: { id: true, name: true, image: true } },
      },
    });
    const hasMore = memberships.length > limit;
    const page = memberships.slice(0, limit);
    response.json({
      participants: page.map(({ user, role, joinedAt }) => ({
        ...user,
        role,
        joinedAt,
      })),
      nextCursor: hasMore ? page.at(-1)?.id ?? null : null,
      hasMore,
    });
  }),
);

apiRouter.post(
  "/conversations/private",
  asyncRoute(async (request, response) => {
    const userId = requireUser(request);
    const { participantId } = privateConversationBodySchema.parse(request.body);
    if (participantId === userId) {
      throw new HttpError(400, "INVALID_PARTICIPANT", "You can’t start a conversation with yourself.");
    }

    const participant = await prisma.user.findUnique({
      where: { id: participantId },
      select: { id: true },
    });
    if (!participant) throw new HttpError(404, "USER_NOT_FOUND", "That user could not be found.");

    const privateKey = [userId, participantId].sort().join(":");
    const conversation = await prisma.conversation.upsert({
      where: { privateKey },
      update: {},
      create: {
        type: ConversationType.PRIVATE,
        privateKey,
        memberships: {
          create: [
            { userId, role: ConversationRole.MEMBER },
            { userId: participantId, role: ConversationRole.MEMBER },
          ],
        },
      },
      select: { id: true, type: true, title: true, createdAt: true },
    });
    response.status(200).json({ conversation });
  }),
);

apiRouter.post(
  "/conversations/groups",
  asyncRoute(async (request, response) => {
    const userId = requireUser(request);
    const { name, participantIds } = groupConversationBodySchema.parse(request.body);
    const uniqueParticipantIds = [...new Set(participantIds)].filter(
      (participantId) => participantId !== userId,
    );
    const allMemberIds = [userId, ...uniqueParticipantIds];
    const conversation = await prisma.$transaction(async (transaction) => {
      const existingUsers = await transaction.user.count({
        where: { id: { in: uniqueParticipantIds } },
      });
      if (existingUsers !== uniqueParticipantIds.length) {
        throw new HttpError(400, "INVALID_PARTICIPANT", "One or more participants could not be found.");
      }
      return transaction.conversation.create({
        data: {
          type: ConversationType.GROUP,
          title: name,
          memberships: {
            create: allMemberIds.map((memberId) => ({
              userId: memberId,
              role:
                memberId === userId
                  ? ConversationRole.OWNER
                  : ConversationRole.MEMBER,
            })),
          },
        },
        select: { id: true, type: true, title: true, createdAt: true },
      });
    });
    response.status(201).json({ conversation });
  }),
);

apiRouter.patch(
  "/conversations/:conversationId",
  asyncRoute<RouteParams>(async (request, response) => {
    const userId = requireUser(request);
    const { conversationId } = conversationIdParamsSchema.parse(request.params);
    const { name } = groupNameBodySchema.parse(request.body);
    const membership = await requireMembership(conversationId, userId);
    if (!canManageConversation(membership.role)) {
      throw new HttpError(403, "FORBIDDEN", "Only group owners and admins can update group details.");
    }
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { type: true },
    });
    if (!conversation || conversation.type !== ConversationType.GROUP) {
      throw new HttpError(400, "INVALID_CONVERSATION", "Only group details can be updated.");
    }
    const updated = await prisma.conversation.update({
      where: { id: conversationId },
      data: { title: name },
      select: { id: true, title: true, updatedAt: true },
    });
    response.json({ conversation: updated });
  }),
);

apiRouter.post(
  "/conversations/:conversationId/participants",
  asyncRoute<RouteParams>(async (request, response) => {
    const userId = requireUser(request);
    const { conversationId } = conversationIdParamsSchema.parse(request.params);
    const { userId: participantId } = addParticipantBodySchema.parse(request.body);
    const membership = await requireMembership(conversationId, userId);
    if (!canManageConversation(membership.role)) {
      throw new HttpError(403, "FORBIDDEN", "Only group owners and admins can add participants.");
    }
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { type: true },
    });
    if (!conversation || conversation.type !== ConversationType.GROUP) {
      throw new HttpError(400, "INVALID_CONVERSATION", "Participants can only be added to groups.");
    }
    await prisma.$transaction(
      async (transaction) => {
        const existingMembership = await transaction.conversationMember.findUnique({
          where: {
            conversationId_userId: { conversationId, userId: participantId },
          },
          select: { id: true },
        });
        if (existingMembership) {
          throw new HttpError(409, "ALREADY_MEMBER", "That person is already in this group.");
        }
        const user = await transaction.user.findUnique({
          where: { id: participantId },
          select: { id: true },
        });
        if (!user) {
          throw new HttpError(404, "USER_NOT_FOUND", "That user could not be found.");
        }
        const memberCount = await transaction.conversationMember.count({
          where: { conversationId },
        });
        if (memberCount >= 50) {
          throw new HttpError(409, "GROUP_FULL", "Groups can have up to 50 members.");
        }
        await transaction.conversationMember.create({
          data: { conversationId, userId: participantId },
        });
      },
      { isolationLevel: "Serializable" },
    );
    response.status(201).json({ added: true });
  }),
);

apiRouter.delete(
  "/conversations/:conversationId/participants/:userId",
  asyncRoute<RouteParams>(async (request, response) => {
    const actorId = requireUser(request);
    const { conversationId, userId: participantId } =
      participantParamsSchema.parse(request.params);
    const [actorMembership, targetMembership, conversation] = await Promise.all([
      requireMembership(conversationId, actorId),
      prisma.conversationMember.findUnique({
        where: { conversationId_userId: { conversationId, userId: participantId } },
        select: { id: true, role: true },
      }),
      prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { type: true },
      }),
    ]);
    if (!conversation || conversation.type !== ConversationType.GROUP) {
      throw new HttpError(400, "INVALID_CONVERSATION", "Participants can only be removed from groups.");
    }
    if (!targetMembership) throw new HttpError(404, "MEMBER_NOT_FOUND", "That participant was not found.");
    if (targetMembership.role === ConversationRole.OWNER) {
      throw new HttpError(409, "OWNER_CANNOT_BE_REMOVED", "The group owner must leave using the leave-group action.");
    }
    if (
      !canRemoveParticipant(
        actorId,
        actorMembership.role,
        participantId,
        targetMembership.role,
      )
    ) {
      throw new HttpError(403, "FORBIDDEN", "You don’t have permission to remove this participant.");
    }
    await prisma.conversationMember.delete({
      where: { conversationId_userId: { conversationId, userId: participantId } },
    });
    response.status(204).end();
  }),
);

apiRouter.post(
  "/conversations/:conversationId/leave",
  asyncRoute<RouteParams>(async (request, response) => {
    const userId = requireUser(request);
    const { conversationId } = conversationIdParamsSchema.parse(request.params);
    const membership = await requireMembership(conversationId, userId);
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { type: true },
    });
    if (!conversation || conversation.type !== ConversationType.GROUP) {
      throw new HttpError(400, "INVALID_CONVERSATION", "Only group members can leave a group.");
    }

    await prisma.$transaction(async (transaction) => {
      if (membership.role === ConversationRole.OWNER) {
        const successor = await transaction.conversationMember.findFirst({
          where: { conversationId, userId: { not: userId } },
          orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
          select: { id: true },
        });
        if (successor) {
          await transaction.conversationMember.update({
            where: { id: successor.id },
            data: { role: ConversationRole.OWNER },
          });
        } else {
          await transaction.conversation.delete({ where: { id: conversationId } });
          return;
        }
      }
      await transaction.conversationMember.delete({
        where: { conversationId_userId: { conversationId, userId } },
      });
    });
    response.status(204).end();
  }),
);

apiRouter.get(
  "/conversations/:conversationId/messages",
  asyncRoute<RouteParams>(async (request, response) => {
    const userId = requireUser(request);
    const { conversationId } = conversationIdParamsSchema.parse(request.params);
    const { cursor, limit } = listMessagesQuerySchema.parse(request.query);
    await requireMembership(conversationId, userId);
    if (cursor) {
      const cursorMessage = await prisma.message.findFirst({
        where: { id: cursor, conversationId },
        select: { id: true },
      });
      if (!cursorMessage) {
        throw new HttpError(400, "INVALID_CURSOR", "The message cursor is invalid.");
      }
    }
    const messages = await prisma.message.findMany({
      where: { conversationId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: {
        sender: { select: { id: true, name: true, image: true } },
        readReceipts: {
          select: { userId: true },
        },
        reactions: {
          select: { userId: true, emoji: true },
        },
      },
    });
    const hasMore = messages.length > limit;
    const page = messages.slice(0, limit).reverse();
    response.json({
      messages: page.map((message) => ({
        id: message.id,
        content: message.deletedAt ? "Message deleted" : message.content,
        createdAt: message.createdAt,
        editedAt: message.editedAt,
        deletedAt: message.deletedAt,
        sender: message.sender,
        reactions: message.reactions,
        read:
          message.sender.id === userId
            ? message.readReceipts.some((receipt) => receipt.userId !== userId)
            : message.readReceipts.some((receipt) => receipt.userId === userId),
      })),
      nextCursor: hasMore ? messages[limit - 1]?.id ?? null : null,
      hasMore,
    });
  }),
);

apiRouter.post(
  "/conversations/:conversationId/messages",
  asyncRoute<RouteParams>(async (request, response) => {
    const userId = requireUser(request);
    const { conversationId } = conversationIdParamsSchema.parse(request.params);
    const { content } = messageBodySchema.parse(request.body);
    await requireMembership(conversationId, userId);
    const message = await prisma.$transaction(async (transaction) => {
      const created = await transaction.message.create({
        data: { conversationId, senderId: userId, content },
        include: {
          sender: { select: { id: true, name: true, image: true } },
          reactions: { select: { userId: true, emoji: true } },
        },
      });
      await transaction.conversation.update({
        where: { id: conversationId },
        data: { updatedAt: new Date() },
      });
      return created;
    });

    const serializedMessage = {
      id: message.id,
      content: message.content,
      createdAt: message.createdAt,
      editedAt: message.editedAt,
      deletedAt: message.deletedAt,
      sender: message.sender,
      reactions: message.reactions,
      read: false,
    };

    emitMessageCreated(conversationId, serializedMessage);

    response.status(201).json({ message: serializedMessage });
  }),
);

apiRouter.post(
  "/messages/:messageId/reactions",
  asyncRoute<RouteParams>(async (request, response) => {
    const userId = requireUser(request);
    const { messageId } = messageParamsSchema.parse(request.params);
    const { emoji } = messageReactionBodySchema.parse(request.body);
    const result = await setMessageReaction(
      messageReactionStore,
      messageId,
      userId,
      emoji,
    );
    emitMessageReactionsUpdated(
      result.conversationId,
      messageId,
      result.reactions,
    );
    response.json({ reactions: result.reactions });
  }),
);

apiRouter.delete(
  "/messages/:messageId/reactions",
  asyncRoute<RouteParams>(async (request, response) => {
    const userId = requireUser(request);
    const { messageId } = messageParamsSchema.parse(request.params);
    const result = await removeMessageReaction(
      messageReactionStore,
      messageId,
      userId,
    );
    emitMessageReactionsUpdated(
      result.conversationId,
      messageId,
      result.reactions,
    );
    response.json({ reactions: result.reactions });
  }),
);

apiRouter.patch(
  "/messages/:messageId",
  asyncRoute<RouteParams>(async (request, response) => {
    const userId = requireUser(request);
    const { messageId } = messageParamsSchema.parse(request.params);
    const { content } = messageBodySchema.parse(request.body);
    const existing = await requireMessageAccess(messageId, userId);
    if (!canModifyMessage(existing.senderId, userId)) {
      throw new HttpError(403, "FORBIDDEN", "You can only edit your own messages.");
    }
    if (existing.deletedAt) {
      throw new HttpError(409, "MESSAGE_DELETED", "Deleted messages can’t be edited.");
    }
    const message = await prisma.$transaction(async (transaction) => {
      const updatedMessage = await transaction.message.update({
        where: { id: messageId },
        data: { content, editedAt: new Date() },
        select: { id: true, content: true, editedAt: true, updatedAt: true },
      });
      await transaction.conversation.update({
        where: { id: existing.conversationId },
        data: { updatedAt: new Date() },
      });
      return updatedMessage;
    });
    response.json({ message });
  }),
);

apiRouter.delete(
  "/messages/:messageId",
  asyncRoute<RouteParams>(async (request, response) => {
    const userId = requireUser(request);
    const { messageId } = messageParamsSchema.parse(request.params);
    const existing = await requireMessageAccess(messageId, userId);
    if (!canModifyMessage(existing.senderId, userId)) {
      throw new HttpError(403, "FORBIDDEN", "You can only delete your own messages.");
    }
    if (!existing.deletedAt) {
      await prisma.$transaction(async (transaction) => {
        await transaction.message.update({
          where: { id: messageId },
          data: { content: "", deletedAt: new Date(), editedAt: null },
        });
        await transaction.conversation.update({
          where: { id: existing.conversationId },
          data: { updatedAt: new Date() },
        });
      });
    }
    response.status(204).end();
  }),
);

apiRouter.post(
  "/messages/:messageId/read",
  asyncRoute<RouteParams>(async (request, response) => {
    const userId = requireUser(request);
    const { messageId } = messageParamsSchema.parse(request.params);
    const message = await requireMessageAccess(messageId, userId);
    if (message.senderId !== userId) {
      await prisma.messageReadReceipt.upsert({
        where: { messageId_userId: { messageId, userId } },
        create: { messageId, userId },
        update: { readAt: new Date() },
      });
      emitReadReceipt(message.conversationId, messageId, userId);
    }
    response.status(204).end();
  }),
);

apiRouter.post(
  "/conversations/:conversationId/read",
  asyncRoute<RouteParams>(async (request, response) => {
    const userId = requireUser(request);
    const { conversationId } = conversationIdParamsSchema.parse(request.params);
    await requireMembership(conversationId, userId);
    const unreadMessages = await prisma.message.findMany({
      where: {
        conversationId,
        senderId: { not: userId },
        readReceipts: { none: { userId } },
      },
      select: { id: true },
      take: 500,
    });
    if (unreadMessages.length > 0) {
      await prisma.messageReadReceipt.createMany({
        data: unreadMessages.map((message) => ({
          messageId: message.id,
          userId,
        })),
        skipDuplicates: true,
      });
    }
    response.status(204).end();
  }),
);
