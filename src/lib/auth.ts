import { betterAuth } from "better-auth";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import { env } from "../config/env.js";
import { prisma } from "./prisma.js";

export function getAuthCookieAttributes(isProduction: boolean) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isProduction,
  };
}

export const auth = betterAuth({
  appName: "PingTalk",
  baseURL: env.BETTER_AUTH_URL,
  basePath: "/api/auth",
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: [env.FRONTEND_ORIGIN],
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
  },
  advanced: {
    useSecureCookies: env.NODE_ENV === "production",
    defaultCookieAttributes: getAuthCookieAttributes(env.NODE_ENV === "production"),
  },
});

export type AuthSession = typeof auth.$Infer.Session;
export type AuthenticatedUser = AuthSession["user"];
