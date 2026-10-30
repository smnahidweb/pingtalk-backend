import { app } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";
import { createSocketServer, getSocketServer } from "./lib/socket.js";

const server = app.listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, environment: env.NODE_ENV },
    "PingTalk API listening",
  );
});

createSocketServer(server);

function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down PingTalk API");
  server.close((error) => {
    if (error) {
      logger.error({ errorName: error.name }, "HTTP server shutdown failed");
      process.exitCode = 1;
    }
    getSocketServer()?.close();
    void prisma.$disconnect().finally(() => {
      process.exit(process.exitCode ?? 0);
    });
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
