import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import path from "node:path";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

function createPrismaClient(): PrismaClient {
  const url =
    process.env.TURSO_DATABASE_URL ??
    `file:${path.join(process.cwd(), "prisma", "dev.db")}`;
  const adapter = new PrismaLibSql({
    url,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  return new PrismaClient({ adapter });
}

export const prisma: PrismaClient =
  globalForPrisma.prisma ?? createPrismaClient();

// Reuse client across hot-reloads in dev; never leak connections in prod.
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
