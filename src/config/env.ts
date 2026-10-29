import "dotenv/config";
import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  PORT: z.coerce.number().int().min(1).max(65535),
  FRONTEND_URL: z.string().url(),
  CORS_ORIGIN: z.string().url(),
  DATABASE_URL: z
    .string()
    .url()
    .refine((value) => value.startsWith("postgresql://") || value.startsWith("postgres://")),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
});

const parsedEnvironment = environmentSchema.safeParse(process.env);

if (!parsedEnvironment.success) {
  const invalidVariables = [
    ...new Set(parsedEnvironment.error.issues.map((issue) => String(issue.path[0]))),
  ];
  throw new Error(
    `Invalid backend environment configuration. Check these variables: ${invalidVariables.join(", ")}`,
  );
}

const frontendOrigin = new URL(parsedEnvironment.data.FRONTEND_URL).origin;
const corsOrigin = new URL(parsedEnvironment.data.CORS_ORIGIN).origin;

if (
  frontendOrigin !== corsOrigin ||
  parsedEnvironment.data.CORS_ORIGIN !== corsOrigin
) {
  throw new Error(
    "Invalid backend environment configuration. CORS_ORIGIN must match FRONTEND_URL.",
  );
}

export const env = {
  ...parsedEnvironment.data,
  FRONTEND_ORIGIN: frontendOrigin,
};

export type Environment = typeof env;
