import { toNodeHandler } from "better-auth/node";
import cors from "cors";
import express, {
  type ErrorRequestHandler,
  type Express,
  type RequestHandler,
} from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { env } from "./config/env.js";
import { auth } from "./lib/auth.js";
import { HttpError, errorHandler } from "./lib/errors.js";
import { logger } from "./lib/logger.js";
import { apiRouter } from "./routes/api.js";

type AppOptions = {
  mountAuth?: boolean;
  authHandler?: RequestHandler;
};

function limiter(windowMs: number, limit: number) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_request, response) => {
      response.status(429).json({
        error: {
          code: "RATE_LIMITED",
          message: "Too many requests. Please try again later.",
        },
      });
    },
  });
}

export function createApp(options: AppOptions = {}): Express {
  const app = express();
  app.disable("x-powered-by");
  if (process.env.RAILWAY_ENVIRONMENT || process.env.RENDER === "true") {
    app.set("trust proxy", 1);
  }
  app.use(
    pinoHttp({
      logger,
      serializers: {
        req(request) {
          const path = new URL(request.url ?? "/", env.BETTER_AUTH_URL).pathname;
          return {
            id: request.id,
            method: request.method,
            path,
            remoteAddress: request.remoteAddress,
          };
        },
        err(error) {
          return { type: error.name };
        },
      },
    }),
  );
  app.use(helmet());
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || origin === env.FRONTEND_ORIGIN) {
          callback(null, true);
          return;
        }
        callback(new HttpError(403, "ORIGIN_NOT_ALLOWED", "This origin is not allowed."));
      },
      credentials: true,
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      maxAge: 600,
    }),
  );

  app.get("/api/health", (_request, response) => {
    response.json({
      status: "ok",
      service: "pingtalk-api",
      timestamp: new Date().toISOString(),
    });
  });

  app.use("/api/auth", limiter(15 * 60 * 1000, 30));
  app.use("/api/users", limiter(60 * 1000, 60));
  app.use("/api/conversations", limiter(60 * 1000, 120));
  if (options.mountAuth !== false) {
    const handler = options.authHandler ?? toNodeHandler(auth);
    app.all("/api/auth", handler);
    app.all("/api/auth/*splat", handler);
  }

  app.use(express.json({ limit: "16kb" }));
  app.use("/api", apiRouter);
  app.use((_request, response) => {
    response.status(404).json({
      error: { code: "NOT_FOUND", message: "The requested endpoint was not found." },
    });
  });
  app.use(errorHandler as ErrorRequestHandler);
  return app;
}

export const app = createApp();
