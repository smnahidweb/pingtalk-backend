import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { env } from "../config/env.js";

const globalForPrisma = globalThis as typeof globalThis & {
  pingTalkPrisma?: PrismaClient;
};

function createPrismaClient() {
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
  return new PrismaClient({ adapter });
}

export const prisma =
  globalForPrisma.pingTalkPrisma ?? createPrismaClient();

if (env.NODE_ENV !== "production") {
  globalForPrisma.pingTalkPrisma = prisma;
}
