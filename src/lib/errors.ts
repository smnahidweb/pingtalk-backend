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

export const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
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
  logger.error({ errorName }, "Unhandled request error");
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
