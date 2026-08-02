-- Fugu/Sakana removal: rebuild Project without retired provider-review columns.
-- The initial Prisma migrations predate Project; create the legacy shape only for
-- pristine disposable databases, then copy all surviving project data.
CREATE TABLE IF NOT EXISTS "Project" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "projectName" TEXT NOT NULL,
  "description" TEXT,
  "route" TEXT,
  "status" TEXT NOT NULL DEFAULT 'planning',
  "latestInstruction" TEXT,
  "assignedAgent" TEXT,
  "localFolderPath" TEXT,
  "localBuildLog" TEXT,
  "localBuildError" TEXT,
  "localDevUrl" TEXT,
  "localDevPid" INTEGER,
  "localPreviewStatus" TEXT,
  "localPreviewCheckedAt" TEXT,
  "localResearchBrief" TEXT,
  "localDesignReview" TEXT,
  "localPolishReview" TEXT,
  "designScore" INTEGER,
  "fuguGateStatus" TEXT,
  "fuguGateScore" INTEGER,
  "fuguGateReview" TEXT,
  "fuguGateReviewedAt" TEXT,
  "fuguGateOverrideReason" TEXT,
  "fuguPolishStatus" TEXT,
  "localQaStatus" TEXT,
  "localQaChecklist" TEXT,
  "createdAt" DATETIME,
  "updatedAt" DATETIME
);

CREATE TABLE "new_Project" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "projectName" TEXT NOT NULL,
  "description" TEXT,
  "route" TEXT,
  "status" TEXT NOT NULL DEFAULT 'planning',
  "latestInstruction" TEXT,
  "assignedAgent" TEXT,
  "localFolderPath" TEXT,
  "localBuildLog" TEXT,
  "localBuildError" TEXT,
  "localDevUrl" TEXT,
  "localDevPid" INTEGER,
  "localPreviewStatus" TEXT,
  "localPreviewCheckedAt" TEXT,
  "localResearchBrief" TEXT,
  "localQaStatus" TEXT,
  "localQaChecklist" TEXT,
  "createdAt" DATETIME,
  "updatedAt" DATETIME
);

INSERT INTO "new_Project" (
  "id", "userId", "projectName", "description", "route", "status",
  "latestInstruction", "assignedAgent", "localFolderPath", "localBuildLog",
  "localBuildError", "localDevUrl", "localDevPid", "localPreviewStatus",
  "localPreviewCheckedAt", "localResearchBrief", "localQaStatus",
  "localQaChecklist", "createdAt", "updatedAt"
) SELECT
  "id", "userId", "projectName", "description", "route", "status",
  "latestInstruction", "assignedAgent", "localFolderPath", "localBuildLog",
  "localBuildError", "localDevUrl", "localDevPid", "localPreviewStatus",
  "localPreviewCheckedAt", "localResearchBrief", "localQaStatus",
  "localQaChecklist", "createdAt", "updatedAt"
FROM "Project";

DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
CREATE INDEX "Project_userId_status_idx" ON "Project"("userId", "status");
CREATE INDEX "Project_userId_updatedAt_idx" ON "Project"("userId", "updatedAt");
CREATE INDEX "Project_route_idx" ON "Project"("route");
