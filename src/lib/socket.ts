import { fromNodeHeaders } from "better-auth/node";
import type { IncomingHttpHeaders } from "node:http";
import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { env } from "../config/env.js";
import { auth } from "./auth.js";
import { logger } from "./logger.js";
import { prisma } from "./prisma.js";

type SerializedMessage = {
  id: string;
  content: string;
  createdAt: string | Date;
  editedAt: string | Date | null;
  deletedAt: string | Date | null;
  sender: { id: string; name: string; image: string | null };
  read: boolean;
};

let socketServer: Server | null = null;

export function getSocketServer() {
  return socketServer;
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

export function createSocketServer(httpServer: HttpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: env.FRONTEND_ORIGIN,
      credentials: true,
    },
    transports: ["websocket", "polling"],
    connectionStateRecovery: {
      maxDisconnectionDuration: 120_000,
      skipMiddlewares: false,
    },
  });

  socketServer = io;
  const userSockets = new Map<string, Set<string>>();

  io.use(async (socket, next) => {
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
    const userSet = userSockets.get(userId) ?? new Set<string>();
    userSet.add(socket.id);
    userSockets.set(userId, userSet);

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

    if (userSet.size === 1) {
      io.emit("user:online", { userId });
    }

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

    socket.on("disconnect", () => {
      logger.info({ userId, socketId: socket.id }, "Authenticated socket disconnected");
      const activeSockets = userSockets.get(userId);
      activeSockets?.delete(socket.id);
      if (!activeSockets || activeSockets.size === 0) {
        userSockets.delete(userId);
        io.emit("user:offline", { userId });
      }
    });
  });

  return io;
}
