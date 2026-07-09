CREATE TABLE "ExecutionRun" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "projectId" TEXT,
  "taskId" TEXT,
  "parentRunId" TEXT,
  "executor" TEXT NOT NULL,
  "currentPhase" TEXT NOT NULL DEFAULT 'queued',
  "currentActivity" TEXT,
  "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastHeartbeatAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastMeaningfulEventAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" DATETIME,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "lastSafeError" TEXT,
  "workerId" TEXT,
  "localFolderPath" TEXT,
  "fallbackReason" TEXT,
  "cancellationRequestedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExecutionRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ExecutionTraceEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "runId" TEXT NOT NULL,
  "phase" TEXT NOT NULL,
  "severity" TEXT NOT NULL DEFAULT 'info',
  "message" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "safeDetails" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExecutionTraceEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ExecutionRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ExecutionRun_userId_status_idx" ON "ExecutionRun"("userId", "status");
CREATE INDEX "ExecutionRun_userId_startedAt_idx" ON "ExecutionRun"("userId", "startedAt");
CREATE INDEX "ExecutionRun_taskId_idx" ON "ExecutionRun"("taskId");
CREATE INDEX "ExecutionRun_projectId_idx" ON "ExecutionRun"("projectId");
CREATE INDEX "ExecutionTraceEvent_runId_createdAt_idx" ON "ExecutionTraceEvent"("runId", "createdAt");
CREATE INDEX "ExecutionTraceEvent_phase_createdAt_idx" ON "ExecutionTraceEvent"("phase", "createdAt");
