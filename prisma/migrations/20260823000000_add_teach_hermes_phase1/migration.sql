CREATE TABLE "SkillTeachingSession" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "projectId" TEXT,
  "activeScopeKey" TEXT,
  "goal" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'recording',
  "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" DATETIME NOT NULL,
  "stoppedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "SkillTeachingSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "SkillTeachingEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "sessionId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "eventKey" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "payload" TEXT NOT NULL,
  "evidenceHash" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SkillTeachingEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "SkillTeachingSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "SkillDraft" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "sessionId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "projectId" TEXT,
  "name" TEXT NOT NULL,
  "definition" TEXT NOT NULL,
  "observedCapabilities" TEXT NOT NULL,
  "effectiveCapabilities" TEXT NOT NULL,
  "confidence" REAL NOT NULL,
  "provenance" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "approvalId" TEXT,
  "promotedSkillId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "SkillDraft_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "SkillTeachingSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SkillDraft_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "SkillTeachingSession_userId_projectId_status_expiresAt_idx" ON "SkillTeachingSession"("userId", "projectId", "status", "expiresAt");
CREATE UNIQUE INDEX "SkillTeachingSession_activeScopeKey_key" ON "SkillTeachingSession"("activeScopeKey");
CREATE INDEX "SkillTeachingSession_userId_updatedAt_idx" ON "SkillTeachingSession"("userId", "updatedAt");
CREATE UNIQUE INDEX "SkillTeachingEvent_sessionId_eventKey_key" ON "SkillTeachingEvent"("sessionId", "eventKey");
CREATE UNIQUE INDEX "SkillTeachingEvent_sessionId_sequence_key" ON "SkillTeachingEvent"("sessionId", "sequence");
CREATE INDEX "SkillTeachingEvent_sessionId_createdAt_idx" ON "SkillTeachingEvent"("sessionId", "createdAt");
CREATE UNIQUE INDEX "SkillDraft_sessionId_key" ON "SkillDraft"("sessionId");
CREATE UNIQUE INDEX "SkillDraft_approvalId_key" ON "SkillDraft"("approvalId");
CREATE INDEX "SkillDraft_userId_status_updatedAt_idx" ON "SkillDraft"("userId", "status", "updatedAt");
CREATE INDEX "SkillDraft_userId_projectId_status_idx" ON "SkillDraft"("userId", "projectId", "status");
