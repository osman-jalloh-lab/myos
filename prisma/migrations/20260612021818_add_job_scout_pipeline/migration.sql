/*
  Warnings:

  - You are about to drop the column `updatedAt` on the `DailyBrief` table. All the data in the column will be lost.

*/
-- CreateTable
CREATE TABLE "JobLead" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "location" TEXT,
    "url" TEXT,
    "rawSnippet" TEXT,
    "jdText" TEXT,
    "source" TEXT NOT NULL DEFAULT 'gmail-alert',
    "fitScore" INTEGER,
    "fitReason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'new',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "JobLead_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ApplicationKit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobLeadId" TEXT NOT NULL,
    "resumeBullets" TEXT,
    "coverLetter" TEXT,
    "recruiterEmail" TEXT,
    "gmailDraftId" TEXT,
    "atsScore" INTEGER,
    "atsFeedback" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ApplicationKit_jobLeadId_fkey" FOREIGN KEY ("jobLeadId") REFERENCES "JobLead" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MasterResume" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MasterResume_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "JobScoutRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "emailsScanned" INTEGER NOT NULL DEFAULT 0,
    "leadsFound" INTEGER NOT NULL DEFAULT 0,
    "leadsScored" INTEGER NOT NULL DEFAULT 0,
    "kitsBuilt" INTEGER NOT NULL DEFAULT 0,
    "draftsQueued" INTEGER NOT NULL DEFAULT 0,
    "digestSent" BOOLEAN NOT NULL DEFAULT false,
    "errors" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_DailyBrief" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "briefDate" DATETIME NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DailyBrief_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_DailyBrief" ("briefDate", "content", "createdAt", "id", "userId") SELECT "briefDate", "content", "createdAt", "id", "userId" FROM "DailyBrief";
DROP TABLE "DailyBrief";
ALTER TABLE "new_DailyBrief" RENAME TO "DailyBrief";
CREATE UNIQUE INDEX "DailyBrief_userId_briefDate_key" ON "DailyBrief"("userId", "briefDate");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "JobLead_userId_status_idx" ON "JobLead"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "JobLead_userId_fingerprint_key" ON "JobLead"("userId", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationKit_jobLeadId_key" ON "ApplicationKit"("jobLeadId");

-- CreateIndex
CREATE UNIQUE INDEX "MasterResume_userId_key" ON "MasterResume"("userId");
