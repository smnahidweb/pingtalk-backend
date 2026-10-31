import type { ErrorRequestHandler } from "express";
import { Prisma } from "../generated/prisma/client.js";
import { ZodError } from "zod";
import { logger } from "./logger.js";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const safeDatabaseErrorCode = /^P\d{4}$/;
const safeExternalDatabaseErrorCodes = new Set([
  "08001",
  "08003",
  "08006",
  "08P01",
  "23502",
  "23503",
  "23505",
  "23514",
  "28P01",
  "3D000",
  "40001",
  "40P01",
  "42P01",
  "42703",
  "57P01",
  "57P03",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EHOSTUNREACH",
]);
const safeExceptionClasses = new Set([
  "AggregateError",
  "APIError",
  "BetterAuthError",
  "DatabaseError",
  "Error",
  "HttpError",
  "PrismaClientEngineVersionNotSupportedError",
  "PrismaClientInitializationError",
  "PrismaClientKnownRequestError",
  "PrismaClientRustPanicError",
  "PrismaClientUnknownRequestError",
  "PrismaClientValidationError",
  "PostgresError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "ZodError",
]);

function getSafeDatabaseErrorCode(error: unknown): string | undefined {
  const seen = new Set<object>();
  let current = error;

  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null || seen.has(current)) {
      return undefined;
    }
    seen.add(current);

    if (
      "code" in current &&
      typeof current.code === "string" &&
      (safeDatabaseErrorCode.test(current.code) ||
        safeExternalDatabaseErrorCodes.has(current.code))
    ) {
      return current.code;
    }
    current = "cause" in current ? current.cause : undefined;
  }

  return undefined;
}

function getSafeStackFrames(error: unknown): string[] | undefined {
  if (!(error instanceof Error) || typeof error.stack !== "string") return undefined;

  const frames = error.stack
    .split("\n")
    .slice(1)
    .filter((frame) => /^\s*at\s/.test(frame))
    .slice(0, 24)
    .flatMap((frame) => {
      const location = frame.trim().replace(/^at\s+/, "");
      const openParenthesis = location.lastIndexOf("(");
      const fileLocation = openParenthesis >= 0
        ? location.slice(openParenthesis + 1).replace(/\)$/, "")
        : location.replace(/^async\s+/, "");
      const match = fileLocation.match(/(?:^|[\\/])([^\\/]+):(\d+):(\d+)$/);
      return match ? [`${match[1]}:${match[2]}:${match[3]}`] : [];
    });

  return frames.length > 0 ? frames : undefined;
}

export function getSafeAuthExceptionDetails(error: unknown) {
  const exceptionClass = error instanceof Error ? error.name : "NonErrorThrown";
  return {
    exceptionClass: safeExceptionClasses.has(exceptionClass) ? exceptionClass : "Error",
    databaseCode: getSafeDatabaseErrorCode(error),
    stackFrames: getSafeStackFrames(error),
  };
}

export const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
  void _next;
  if (error instanceof HttpError) {
    response.status(error.status).json({
      error: { code: error.code, message: error.message },
    });
    return;
  }

  if (error instanceof ZodError) {
    response.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "The request contains invalid values.",
        details: error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      },
    });
    return;
  }

  if (
    error instanceof SyntaxError &&
    typeof error === "object" &&
    error !== null &&
    "body" in error
  ) {
    response.status(400).json({
      error: { code: "INVALID_JSON", message: "The request body must be valid JSON." },
    });
    return;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    error.type === "entity.too.large"
  ) {
    response.status(413).json({
      error: { code: "PAYLOAD_TOO_LARGE", message: "The request body is too large." },
    });
    return;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      response.status(409).json({
        error: { code: "CONFLICT", message: "That resource already exists." },
      });
      return;
    }

    if (error.code === "P2025") {
      response.status(404).json({
        error: { code: "NOT_FOUND", message: "The requested resource was not found." },
      });
      return;
    }

    if (error.code === "P2034") {
      response.status(409).json({
        error: {
          code: "CONCURRENT_UPDATE",
          message: "The group changed during this request. Please try again.",
        },
      });
      return;
    }
  }

  const errorName =
    error instanceof Error ? error.name : "UnknownError";
  if (request.method === "POST" && request.path === "/api/auth/sign-in/email") {
    const requestIdValue = "id" in request ? request.id : undefined;
    const requestId =
      (typeof requestIdValue === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(requestIdValue)) ||
      (typeof requestIdValue === "number" && Number.isSafeInteger(requestIdValue))
        ? String(requestIdValue)
        : "unavailable";
    logger.error(
      {
        authDiagnostic: {
          requestId,
          ...getSafeAuthExceptionDetails(error),
        },
      },
      "Unhandled authentication sign-in error",
    );
  } else {
    logger.error({ errorName }, "Unhandled request error");
  }
  response.status(500).json({
    error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." },
  });
};

export function asyncRoute<Params = Record<string, string>>(
  handler: (
    request: import("express").Request<Params>,
    response: import("express").Response,
  ) => Promise<void>,
) {
  return (
    request: import("express").Request<Params>,
    response: import("express").Response,
    next: import("express").NextFunction,
  ) => {
    void handler(request, response).catch(next);
  };
}
