-- Fix production schema drift: AgentEnvelope was added to schema.prisma
-- without a matching migration. Additive and idempotent for existing databases.
-- Never use `prisma db push` for this production repair.

CREATE TABLE IF NOT EXISTS "AgentEnvelope" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "fromAgent" TEXT NOT NULL,
    "toAgent" TEXT,
    "envelopeType" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "correlationId" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "consumedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentEnvelope_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "AgentEnvelope_userId_status_expiresAt_idx" ON "AgentEnvelope"("userId", "status", "expiresAt");
CREATE INDEX IF NOT EXISTS "AgentEnvelope_toAgent_status_createdAt_idx" ON "AgentEnvelope"("toAgent", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "AgentEnvelope_correlationId_idx" ON "AgentEnvelope"("correlationId");
