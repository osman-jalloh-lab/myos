-- Durable idempotency ledger for inbound Telegram updates.
-- NOT YET APPLIED to the remote/network-backed database — see handoff report.
CREATE TABLE "TelegramUpdate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "updateId" INTEGER NOT NULL,
    "updateType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'received',
    "resultNote" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "TelegramUpdate_updateId_key" ON "TelegramUpdate"("updateId");
CREATE INDEX "TelegramUpdate_status_createdAt_idx" ON "TelegramUpdate"("status", "createdAt");
