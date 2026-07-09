CREATE TABLE "EmailCorrespondent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "accountEmail" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "firstSentAt" DATETIME,
    "lastSentAt" DATETIME,
    "lastScannedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EmailCorrespondent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "EmailCorrespondent_userId_accountEmail_email_key" ON "EmailCorrespondent"("userId", "accountEmail", "email");
CREATE INDEX "EmailCorrespondent_userId_email_idx" ON "EmailCorrespondent"("userId", "email");
CREATE INDEX "EmailCorrespondent_userId_lastScannedAt_idx" ON "EmailCorrespondent"("userId", "lastScannedAt");
