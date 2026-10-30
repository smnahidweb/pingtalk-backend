import { randomUUID } from "node:crypto";
import { fromNodeHeaders } from "better-auth/node";
import type { IncomingHttpHeaders } from "node:http";
import type { Server as HttpServer } from "node:http";
import type { Transport } from "engine.io";
import { Server } from "socket.io";
import { env } from "../config/env.js";
import { auth } from "./auth.js";
import {
  CallRegistry,
  CallRegistryError,
  type CallMode,
  type CallSnapshot,
  type CallSignalType,
  type CallUser,
} from "./call-registry.js";
import { logger } from "./logger.js";
import { UserSocketRegistry } from "./presence.js";
import { prisma } from "./prisma.js";
import { z } from "zod";

type SerializedMessage = {
  id: string;
  content: string;
  createdAt: string | Date;
  editedAt: string | Date | null;
  deletedAt: string | Date | null;
  sender: { id: string; name: string; image: string | null };
  read: boolean;
  reactions: Array<{ userId: string; emoji: string }>;
  attachments: Array<{
    id: string;
    fileName: string;
    contentType: string;
    fileSize: number;
    url: string;
  }>;
};

type SerializedReaction = { userId: string; emoji: string };

type SocketAck = (result: {
  ok: boolean;
  call?: ReturnType<CallRegistry["get"]>;
  error?: { code: string; message: string };
}) => void;

const callInviteSchema = z.object({
  conversationId: z.string().min(1).max(128),
  callType: z.enum(["AUDIO", "VIDEO"]),
  participantIds: z
    .array(z.string().min(1).max(128))
    .min(1)
    .max(7)
    .refine((ids) => new Set(ids).size === ids.length)
    .optional(),
});
const callIdSchema = z.object({ callId: z.string().uuid() });
const callSignalSchema = z.object({
  callId: z.string().uuid(),
  toUserId: z.string().min(1).max(128),
  signalType: z.enum(["offer", "answer", "ice"]),
  data: z.record(z.string(), z.unknown()),
});
const CALL_SIGNAL_MAX_BYTES = 64 * 1024;
const MAX_GROUP_CALL_PARTICIPANTS = 8;

function emitToCallUsers(
  io: Server,
  userIds: string[],
  event: string,
  payload: unknown,
) {
  for (const userId of new Set(userIds)) io.to(`user:${userId}`).emit(event, payload);
}

let socketServer: Server | null = null;
let onlineUsers: UserSocketRegistry | null = null;

export function getSocketServer() {
  return socketServer;
}

export function getOnlineUserIds(userIds: Iterable<string>) {
  return onlineUsers?.onlineUserIds(userIds) ?? new Set<string>();
}

export function emitMessageCreated(conversationId: string, message: SerializedMessage) {
  socketServer?.to(`conversation:${conversationId}`).emit("message:new", {
    conversationId,
    message,
  });
}

export function emitReadReceipt(
  conversationId: string,
  messageId: string,
  userId: string,
) {
  socketServer?.to(`conversation:${conversationId}`).emit("message:read", {
    conversationId,
    messageId,
    userId,
  });
}

export function emitMessageReactionsUpdated(
  conversationId: string,
  messageId: string,
  reactions: SerializedReaction[],
) {
  socketServer?.to(`conversation:${conversationId}`).emit("message:reactions", {
    conversationId,
    messageId,
    reactions,
  });
}

export async function emitUserProfileUpdated(
  userId: string,
  profile: { id: string; name: string; image: string | null },
) {
  if (!socketServer) return;
  const memberships = await prisma.conversationMember.findMany({
    where: { userId },
    select: { conversationId: true },
  });
  const payload = { user: profile };
  socketServer
    .to([
      `user:${userId}`,
      ...memberships.map(({ conversationId }) => `conversation:${conversationId}`),
    ])
    .emit("user:profile-updated", payload);
}

export function createSocketServer(httpServer: HttpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: env.FRONTEND_ORIGIN,
      credentials: true,
    },
    transports: ["polling", "websocket"],
    addTrailingSlash: false,
    connectionStateRecovery: {
      maxDisconnectionDuration: 120_000,
      skipMiddlewares: false,
    },
  });

  socketServer = io;
  const userSockets = new UserSocketRegistry();
  onlineUsers = userSockets;
  const calls = new CallRegistry();
  const callSocketBindings = new Map<
    string,
    { callId: string; socketId: string }
  >();
  const clearCallSocketBindings = (call: CallSnapshot) => {
    for (const userId of [
      ...call.participants.map((participant) => participant.id),
      ...call.pendingUserIds,
    ]) {
      if (callSocketBindings.get(userId)?.callId === call.id) {
        callSocketBindings.delete(userId);
      }
    }
  };
  const callExpiryTimer = setInterval(() => {
    for (const call of calls.expire()) {
      clearCallSocketBindings(call);
      emitToCallUsers(
        io,
        [call.caller.id, ...call.pendingUserIds],
        "call:ended",
        { callId: call.id, reason: "no-answer" },
      );
    }
  }, 10_000);
  callExpiryTimer.unref();
  const presenceHeartbeatTimer = setInterval(() => {
    const userIds = userSockets.activeUserIds();
    if (userIds.length === 0) return;
    void prisma.user
      .updateMany({
        where: { id: { in: userIds } },
        data: { lastSeenAt: new Date() },
      })
      .catch((error: unknown) => {
        logger.error(
          {
            errorName: error instanceof Error ? error.name : "UnknownError",
            activeUserCount: userIds.length,
          },
          "Unable to refresh authenticated user presence timestamps",
        );
      });
  }, 60_000);
  presenceHeartbeatTimer.unref();

  const persistLastSeen = async (userId: string, lastSeenAt: Date) => {
    try {
      await prisma.user.updateMany({
        where: { id: userId },
        data: { lastSeenAt },
      });
    } catch (error) {
      logger.error(
        {
          errorName: error instanceof Error ? error.name : "UnknownError",
          userId,
        },
        "Unable to persist user last-seen timestamp",
      );
    }
  };

  const emitPresenceToConversationMembers = async (
    userId: string,
    isOnline: boolean,
    lastSeenAt: Date | null,
  ) => {
    try {
      const memberships = await prisma.conversationMember.findMany({
        where: { userId },
        select: { conversationId: true },
      });
      if (memberships.length === 0) return;
      io.to(
        memberships.map(({ conversationId }) => `conversation:${conversationId}`),
      ).emit("user:presence", {
        userId,
        online: isOnline,
        lastSeenAt: lastSeenAt?.toISOString() ?? null,
      });
    } catch (error) {
      logger.error(
        {
          errorName: error instanceof Error ? error.name : "UnknownError",
          userId,
        },
        "Unable to broadcast user presence",
      );
    }
  };

  io.on("close", () => {
    clearInterval(callExpiryTimer);
    clearInterval(presenceHeartbeatTimer);
    if (onlineUsers === userSockets) onlineUsers = null;
    if (socketServer === io) socketServer = null;
  });

  io.engine.on("connection_error", (error) => {
    const requestUrl = new URL(error.req.url ?? "/", "http://localhost");
    logger.warn(
      {
        code: error.code,
        message: error.message,
        origin: error.req.headers.origin,
        transport: requestUrl.searchParams.get("transport"),
      },
      "Engine.IO connection attempt failed",
    );
  });

  io.engine.on("connection", (engineSocket) => {
    logger.info(
      {
        transport: engineSocket.transport.name,
        origin: engineSocket.request.headers.origin,
      },
      "Engine.IO transport connected",
    );
    engineSocket.on("upgrade", (transport: Transport) => {
      logger.info(
        { transport: transport.name },
        "Engine.IO transport upgraded",
      );
    });
    engineSocket.on("close", (reason: string) => {
      logger.info(
        {
          reason,
          transport: engineSocket.transport.name,
        },
        "Engine.IO transport closed",
      );
    });
  });

  io.use(async (socket, next) => {
    logger.info(
      {
        origin: socket.request.headers.origin,
        transport: socket.conn.transport.name,
        hasCookie: Boolean(socket.request.headers.cookie),
      },
      "Socket.IO authentication attempt",
    );
    try {
      const headers = socket.request.headers as IncomingHttpHeaders;
      const session = await auth.api.getSession({
        headers: fromNodeHeaders(headers),
      });

      if (!session) {
        logger.warn(
          {
            origin: headers.origin,
            transport: socket.conn.transport.name,
            hasCookie: Boolean(headers.cookie),
          },
          "Socket authentication rejected: no Better Auth session",
        );
        next(new Error("UNAUTHENTICATED"));
        return;
      }

      socket.data.user = session.user;
      logger.info(
        {
          userId: session.user.id,
          transport: socket.conn.transport.name,
        },
        "Socket authentication succeeded",
      );
      next();
    } catch (error) {
      logger.error(
        {
          errorName: error instanceof Error ? error.name : "UnknownError",
          origin: socket.request.headers.origin,
          transport: socket.conn.transport.name,
          hasCookie: Boolean(socket.request.headers.cookie),
        },
        "Socket authentication lookup failed",
      );
      next(new Error("AUTH_LOOKUP_FAILED"));
    }
  });

  io.on("connection", async (socket) => {
    const user = socket.data.user as { id: string; name: string; email?: string; image?: string | null };
    const userId = user.id;

    try {
      const memberships = await prisma.conversationMember.findMany({
        where: { userId },
        select: { conversationId: true },
      });
      await Promise.all(
        memberships.map(({ conversationId }) =>
          socket.join(`conversation:${conversationId}`),
        ),
      );
      logger.info(
        { userId, socketId: socket.id, conversationRoomCount: memberships.length },
        "Authenticated socket connected and conversation rooms joined",
      );
    } catch (error) {
      logger.error(
        {
          errorName: error instanceof Error ? error.name : "UnknownError",
          userId,
          socketId: socket.id,
        },
        "Unable to join authenticated socket to conversation rooms",
      );
      socket.disconnect(true);
      return;
    }

    await socket.join(`user:${userId}`);
    if (!socket.connected) return;
    const becameOnline = userSockets.connect(userId, socket.id);

    socket.on(
      "call:invite",
      async (payload: unknown, acknowledge?: SocketAck) => {
        try {
          const { conversationId, callType, participantIds } =
            callInviteSchema.parse(payload);
          const memberships = await prisma.conversationMember.findMany({
            where: { conversationId },
            select: {
              userId: true,
              user: { select: { id: true, name: true, image: true } },
            },
            orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
          });
          const callerMembership = memberships.find(
            (membership) => membership.userId === userId,
          );
          if (!callerMembership) {
            acknowledge?.({
              ok: false,
              error: { code: "FORBIDDEN", message: "You are not in this conversation." },
            });
            return;
          }

          const conversation = await prisma.conversation.findUnique({
            where: { id: conversationId },
            select: { type: true, title: true },
          });
          if (!conversation) {
            acknowledge?.({
              ok: false,
              error: { code: "NOT_FOUND", message: "Conversation not found." },
            });
            return;
          }

          const mode: CallMode =
            conversation.type === "PRIVATE" ? "ONE_TO_ONE" : "GROUP";
          const caller: CallUser = {
            id: callerMembership.user.id,
            name: callerMembership.user.name,
            image: callerMembership.user.image,
          };
          const allInvitees: CallUser[] = memberships
            .filter((membership) => membership.userId !== userId)
            .map(({ user }) => ({
              id: user.id,
              name: user.name,
              image: user.image,
            }));

          if (mode === "ONE_TO_ONE" && participantIds) {
            acknowledge?.({
              ok: false,
              error: { code: "INVALID_PAYLOAD", message: "Private calls do not accept a participant list." },
            });
            return;
          }

          if (mode === "ONE_TO_ONE" && allInvitees.length !== 1) {
            acknowledge?.({
              ok: false,
              error: { code: "INVALID_CONVERSATION", message: "This private conversation is invalid." },
            });
            return;
          }

          const inviteeIds = new Set(participantIds);
          const invitees =
            mode === "GROUP" && inviteeIds.size > 0
              ? allInvitees.filter((invitee) => inviteeIds.has(invitee.id))
              : allInvitees.slice(0, MAX_GROUP_CALL_PARTICIPANTS - 1);
          if (
            inviteeIds.size > 0 &&
            (invitees.length !== inviteeIds.size || invitees.length > MAX_GROUP_CALL_PARTICIPANTS - 1)
          ) {
            acknowledge?.({
              ok: false,
              error: { code: "INVALID_PARTICIPANT", message: "One or more call participants are not in this conversation." },
            });
            return;
          }
          const call = calls.create({
            id: randomUUID(),
            conversationId,
            conversationName:
              conversation.title ??
              allInvitees[0]?.name ??
              caller.name,
            callType,
            mode,
            caller,
            invitees,
          });
          callSocketBindings.set(userId, { callId: call.id, socketId: socket.id });

          acknowledge?.({ ok: true, call });
          emitToCallUsers(
            io,
            call.pendingUserIds,
            "call:incoming",
            { call },
          );
          logger.info(
            {
              callId: call.id,
              conversationId,
              callType,
              mode,
              initiatorId: userId,
              inviteeCount: call.pendingUserIds.length,
            },
            "Call invitation created",
          );
        } catch (error) {
          if (error instanceof CallRegistryError || error instanceof z.ZodError) {
            acknowledge?.({
              ok: false,
              error: {
                code:
                  error instanceof CallRegistryError
                    ? error.code
                    : "INVALID_PAYLOAD",
                message:
                  error instanceof CallRegistryError
                    ? error.message
                    : "Invalid call invitation.",
              },
            });
            return;
          }
          logger.error(
            { errorName: error instanceof Error ? error.name : "UnknownError", userId },
            "Failed to create call invitation",
          );
          acknowledge?.({
            ok: false,
            error: { code: "INTERNAL_ERROR", message: "Unable to start the call." },
          });
        }
      },
    );

    socket.on(
      "call:accept",
      (payload: unknown, acknowledge?: SocketAck) => {
        try {
          const { callId } = callIdSchema.parse(payload);
          const call = calls.accept(callId, userId);
          callSocketBindings.set(userId, { callId, socketId: socket.id });
          const participant = call.participants.find((item) => item.id === userId);
          const others = call.participants.filter((item) => item.id !== userId);
          io.to(`user:${userId}`)
            .except(socket.id)
            .emit("call:accepted-elsewhere", { callId });
          emitToCallUsers(io, others.map((item) => item.id), "call:participant-joined", {
            callId,
            participant,
          });
          emitToCallUsers(io, [call.caller.id], "call:accepted", {
            callId,
            participant,
            call,
          });
          acknowledge?.({ ok: true, call });
        } catch (error) {
          acknowledgeCallError(error, acknowledge, userId, "accept call");
        }
      },
    );

    socket.on(
      "call:reject",
      (payload: unknown, acknowledge?: SocketAck) => {
        try {
          const { callId } = callIdSchema.parse(payload);
          const call = calls.get(callId);
          const { ended } = calls.reject(callId, userId);
          if (ended) clearCallSocketBindings(call);
          emitToCallUsers(io, [call.caller.id], "call:rejected", {
            callId,
            userId,
          });
          if (ended) {
            emitToCallUsers(io, [call.caller.id], "call:ended", {
              callId,
              reason: "rejected",
            });
          }
          acknowledge?.({ ok: true, call });
        } catch (error) {
          acknowledgeCallError(error, acknowledge, userId, "reject call");
        }
      },
    );

    socket.on(
      "call:cancel",
      (payload: unknown, acknowledge?: SocketAck) => {
        try {
          const { callId } = callIdSchema.parse(payload);
          const recipients = calls.get(callId);
          const call = calls.cancel(callId, userId);
          clearCallSocketBindings(recipients);
          emitToCallUsers(
            io,
            [recipients.caller.id, ...recipients.pendingUserIds],
            "call:cancelled",
            { callId },
          );
          acknowledge?.({ ok: true, call });
        } catch (error) {
          acknowledgeCallError(error, acknowledge, userId, "cancel call");
        }
      },
    );

    socket.on(
      "call:leave",
      (payload: unknown, acknowledge?: SocketAck) => {
        try {
          const { callId } = callIdSchema.parse(payload);
          const call = calls.get(callId);
          const { ended } = calls.leave(callId, userId);
          if (callSocketBindings.get(userId)?.callId === callId) {
            callSocketBindings.delete(userId);
          }
          if (ended) clearCallSocketBindings(call);
          emitToCallUsers(
            io,
            call.participants.map((participant) => participant.id),
            "call:participant-left",
            { callId, userId },
          );
          if (ended) {
            emitToCallUsers(
              io,
              [
                ...call.participants.map((participant) => participant.id),
                ...call.pendingUserIds,
              ],
              "call:ended",
              {
                callId,
                reason: "empty",
              },
            );
          }
          acknowledge?.({ ok: true, call });
        } catch (error) {
          acknowledgeCallError(error, acknowledge, userId, "leave call");
        }
      },
    );

    socket.on(
      "call:signal",
      (payload: unknown, acknowledge?: SocketAck) => {
        try {
          const signal = callSignalSchema.parse(payload);
          if (Buffer.byteLength(JSON.stringify(signal.data), "utf8") > CALL_SIGNAL_MAX_BYTES) {
            acknowledge?.({
              ok: false,
              error: { code: "PAYLOAD_TOO_LARGE", message: "Call signal is too large." },
            });
            return;
          }
          const call = calls.validateSignal(
            signal.callId,
            userId,
            signal.toUserId,
          );
          const data = {
            callId: signal.callId,
            fromUserId: userId,
            signalType: signal.signalType as CallSignalType,
            data: signal.data,
          };
          io.to(`user:${signal.toUserId}`).emit("call:signal", data);
          acknowledge?.({ ok: true, call });
        } catch (error) {
          acknowledgeCallError(error, acknowledge, userId, "relay call signal");
        }
      },
    );

    socket.on("conversation:join", async (conversationId: string, callback?: (response: { ok: boolean }) => void) => {
      if (typeof conversationId !== "string") {
        callback?.({ ok: false });
        return;
      }

      const membership = await prisma.conversationMember.findUnique({
        where: { conversationId_userId: { conversationId, userId } },
        select: { conversationId: true },
      });

      if (!membership) {
        callback?.({ ok: false });
        return;
      }

      await socket.join(`conversation:${conversationId}`);
      callback?.({ ok: true });
    });

    socket.on("typing:start", async (payload: { conversationId?: string }) => {
      const conversationId = payload?.conversationId;
      if (!conversationId || typeof conversationId !== "string") return;

      const membership = await prisma.conversationMember.findUnique({
        where: { conversationId_userId: { conversationId, userId } },
        select: { conversationId: true },
      });
      if (!membership) return;

      socket.to(`conversation:${conversationId}`).emit("typing:start", {
        conversationId,
        userId,
        name: user.name,
      });
    });

    socket.on("typing:stop", async (payload: { conversationId?: string }) => {
      const conversationId = payload?.conversationId;
      if (!conversationId || typeof conversationId !== "string") return;

      const membership = await prisma.conversationMember.findUnique({
        where: { conversationId_userId: { conversationId, userId } },
        select: { conversationId: true },
      });
      if (!membership) return;

      socket.to(`conversation:${conversationId}`).emit("typing:stop", {
        conversationId,
        userId,
      });
    });

    socket.on("message:read", async (payload: { conversationId?: string; messageId?: string }, callback?: (response: { ok: boolean }) => void) => {
      const conversationId = payload?.conversationId;
      const messageId = payload?.messageId;
      if (!conversationId || !messageId) {
        callback?.({ ok: false });
        return;
      }

      const membership = await prisma.conversationMember.findUnique({
        where: { conversationId_userId: { conversationId, userId } },
        select: { conversationId: true },
      });
      if (!membership) {
        callback?.({ ok: false });
        return;
      }

      await prisma.messageReadReceipt.upsert({
        where: { messageId_userId: { messageId, userId } },
        create: { messageId, userId },
        update: { readAt: new Date() },
      });

      io.to(`conversation:${conversationId}`).emit("message:read", {
        conversationId,
        messageId,
        userId,
      });
      callback?.({ ok: true });
    });

    socket.conn.on("close", (reason) => {
      logger.info(
        {
          userId,
          socketId: socket.id,
          reason,
          transport: socket.conn.transport.name,
        },
        "Authenticated socket transport closed",
      );
    });

    socket.on("disconnect", (reason, description) => {
      logger.info(
        {
          userId,
          socketId: socket.id,
          reason,
          description:
            description instanceof Error
              ? description.message
              : description?.description,
          transport: socket.conn.transport.name,
        },
        "Authenticated socket disconnected",
      );
      const disconnectState = userSockets.disconnect(userId, socket.id);
      const lastSocketDisconnected = disconnectState.lastSocket;
      const callBinding = callSocketBindings.get(userId);
      const callSocketDisconnected = callBinding?.socketId === socket.id;
      if (lastSocketDisconnected || callSocketDisconnected) {
        const callId = calls.activeCallForUser(userId);
        const callBeforeDisconnect = callId ? calls.get(callId) : null;
        if (callSocketDisconnected) callSocketBindings.delete(userId);
        for (const disconnectedCall of calls.removeDisconnectedUser(userId)) {
          emitToCallUsers(
            io,
            disconnectedCall.call.participants.map((participant) => participant.id),
            "call:participant-left",
            { callId: disconnectedCall.call.id, userId },
          );
          if (disconnectedCall.ended) {
            if (callBeforeDisconnect) {
              clearCallSocketBindings(callBeforeDisconnect);
            }
            emitToCallUsers(
              io,
              disconnectedCall.notifyUserIds,
              "call:ended",
              { callId: disconnectedCall.call.id, reason: "participant-disconnected" },
            );
          }
        }
      }
      if (lastSocketDisconnected) {
        const lastSeenAt = new Date();
        logger.info({ userId, lastSeenAt: lastSeenAt.toISOString() }, "Authenticated user became offline");
        void persistLastSeen(userId, lastSeenAt).then(() =>
          userSockets.isOnline(userId)
            ? Promise.resolve()
            : emitPresenceToConversationMembers(userId, false, lastSeenAt),
        );
      }
    });
    if (becameOnline) {
      const lastSeenAt = new Date();
      logger.info({ userId }, "Authenticated user became online");
      void persistLastSeen(userId, lastSeenAt);
      void emitPresenceToConversationMembers(userId, true, null);
    }
  });

  return io;
}

function acknowledgeCallError(
  error: unknown,
  acknowledge: SocketAck | undefined,
  userId: string,
  operation: string,
) {
  if (error instanceof CallRegistryError || error instanceof z.ZodError) {
    acknowledge?.({
      ok: false,
      error: {
        code:
          error instanceof CallRegistryError
            ? error.code
            : "INVALID_PAYLOAD",
        message:
          error instanceof CallRegistryError
            ? error.message
            : "Invalid call request.",
      },
    });
    return;
  }
  logger.error(
    { errorName: error instanceof Error ? error.name : "UnknownError", userId, operation },
    "Call signaling operation failed",
  );
  acknowledge?.({
    ok: false,
    error: { code: "INTERNAL_ERROR", message: "Unable to complete call action." },
  });
}
