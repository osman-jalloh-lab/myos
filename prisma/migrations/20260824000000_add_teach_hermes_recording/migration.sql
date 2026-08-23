ALTER TABLE "SkillTeachingSession" ADD COLUMN "recordingActive" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SkillTeachingSession" ADD COLUMN "recordingNonce" TEXT;
ALTER TABLE "SkillTeachingSession" ADD COLUMN "recordingOrigin" TEXT;
ALTER TABLE "SkillTeachingSession" ADD COLUMN "recordingLastSequence" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SkillTeachingSession" ADD COLUMN "recordingStartedAt" DATETIME;
ALTER TABLE "SkillTeachingSession" ADD COLUMN "recordingStoppedAt" DATETIME;
CREATE UNIQUE INDEX "SkillTeachingSession_recordingNonce_key" ON "SkillTeachingSession"("recordingNonce");
