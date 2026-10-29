import type { RequestHandler } from "express";
import { fromNodeHeaders } from "better-auth/node";
import type { AuthenticatedUser } from "../lib/auth.js";
import { auth } from "../lib/auth.js";
import { HttpError } from "../lib/errors.js";

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthenticatedUser;
  }
}

export function createAuthenticate(
  getSession: typeof auth.api.getSession = auth.api.getSession,
): RequestHandler {
  return async (request, _response, next) => {
    try {
      const session = await getSession({
        headers: fromNodeHeaders(request.headers),
      });
      if (!session) {
        next(new HttpError(401, "UNAUTHENTICATED", "Sign in to continue."));
        return;
      }

      request.user = session.user;
      next();
    } catch (error) {
      next(error);
    }
  };
}

export const authenticate = createAuthenticate();
