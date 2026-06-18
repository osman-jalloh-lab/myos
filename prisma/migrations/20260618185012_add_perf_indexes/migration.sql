-- CreateTable
CREATE TABLE "TrackedApplication" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "jobTitle" TEXT NOT NULL,
    "applicationDate" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL DEFAULT 'Other',
    "status" TEXT NOT NULL DEFAULT 'Unknown',
    "contactName" TEXT,
    "contactEmail" TEXT,
    "emailSubject" TEXT,
    "jobUrl" TEXT,
    "location" TEXT,
    "notes" TEXT,
    "nextFollowUpDate" DATETIME,
    "gmailMessageId" TEXT,
    "lastUpdatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrackedApplication_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "TrackedApplication_userId_status_idx" ON "TrackedApplication"("userId", "status");

-- CreateIndex
CREATE INDEX "TrackedApplication_userId_lastUpdatedAt_idx" ON "TrackedApplication"("userId", "lastUpdatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TrackedApplication_userId_fingerprint_key" ON "TrackedApplication"("userId", "fingerprint");

-- CreateIndex
CREATE INDEX "AgentRun_agentName_createdAt_idx" ON "AgentRun"("agentName", "createdAt");

-- CreateIndex
CREATE INDEX "AgentRun_createdAt_idx" ON "AgentRun"("createdAt");

-- CreateIndex
CREATE INDEX "ApprovalAction_userId_status_idx" ON "ApprovalAction"("userId", "status");

-- CreateIndex
CREATE INDEX "ApprovalAction_userId_createdAt_idx" ON "ApprovalAction"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ModelUsage_userId_createdAt_idx" ON "ModelUsage"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ModelUsage_provider_createdAt_idx" ON "ModelUsage"("provider", "createdAt");
