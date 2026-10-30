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
      skipMiddlewares: true,
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
        throw new Error("UNAUTHENTICATED");
      }

      socket.data.user = session.user;
      next();
    } catch (error) {
      logger.warn({ error }, "Rejected socket connection due to failed auth");
      next(new Error("UNAUTHENTICATED"));
    }
  });

  io.on("connection", async (socket) => {
    const user = socket.data.user as { id: string; name: string; email?: string; image?: string | null };
    const userId = user.id;
    const userSet = userSockets.get(userId) ?? new Set<string>();
    userSet.add(socket.id);
    userSockets.set(userId, userSet);

    await prisma.conversationMember
      .findMany({
        where: { userId },
        select: { conversationId: true },
      })
      .then((memberships) => {
        for (const membership of memberships) {
          void socket.join(`conversation:${membership.conversationId}`);
        }
      })
      .catch((error) => {
        logger.warn({ error, userId }, "Unable to sync conversation memberships for socket");
      });

    void socket.join(`user:${userId}`);

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
