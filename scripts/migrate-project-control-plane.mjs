#!/usr/bin/env node
import { createClient } from "@libsql/client";

const REQUIRED_ENV = ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"];

const projectColumns = [
  ["phase", "TEXT NOT NULL DEFAULT 'planning'"],
  ["latestPlanId", "TEXT"],
  ["requestFingerprint", "TEXT"],
  ["completionEvidence", "TEXT"],
  ["completedAt", "DATETIME"],
];

const projectTaskColumns = [
  ["userId", "TEXT"],
  ["parentTaskId", "TEXT"],
  ["goalId", "TEXT"],
  ["priority", "TEXT NOT NULL DEFAULT 'medium'"],
  ["responsibleAgent", "TEXT"],
  ["acceptanceCriteria", "TEXT"],
  ["requiredCapabilities", "TEXT"],
  ["outputContract", "TEXT"],
  ["claimedRunId", "TEXT"],
  ["activeRunId", "TEXT"],
  ["executionLockedAt", "DATETIME"],
  ["attemptCount", "INTEGER NOT NULL DEFAULT 0"],
  ["maxAttempts", "INTEGER NOT NULL DEFAULT 3"],
  ["blockedReason", "TEXT"],
  ["startedAt", "DATETIME"],
  ["completedAt", "DATETIME"],
  ["cancelledAt", "DATETIME"],
];

const projectPlanColumns = [
  ["capabilityResolution", "TEXT"],
];

const createTables = [
  {
    name: "Project",
    sql: `CREATE TABLE IF NOT EXISTS Project (
      id TEXT PRIMARY KEY NOT NULL,
      userId TEXT NOT NULL,
      projectName TEXT NOT NULL,
      description TEXT,
      route TEXT,
      status TEXT NOT NULL DEFAULT 'planning',
      latestInstruction TEXT,
      assignedAgent TEXT,
      localFolderPath TEXT,
      localBuildLog TEXT,
      localBuildError TEXT,
      localDevUrl TEXT,
      localDevPid INTEGER,
      localPreviewStatus TEXT,
      localPreviewCheckedAt TEXT,
      localResearchBrief TEXT,
      localDesignReview TEXT,
      localPolishReview TEXT,
      designScore INTEGER,
      fuguGateStatus TEXT,
      fuguGateScore INTEGER,
      fuguGateReview TEXT,
      fuguGateReviewedAt TEXT,
      fuguGateOverrideReason TEXT,
      fuguPolishStatus TEXT,
      localQaStatus TEXT,
      localQaChecklist TEXT,
      phase TEXT NOT NULL DEFAULT 'planning',
      latestPlanId TEXT,
      requestFingerprint TEXT,
      completionEvidence TEXT,
      completedAt DATETIME,
      createdAt DATETIME,
      updatedAt DATETIME
    )`,
  },
  {
    name: "ProjectTask",
    sql: `CREATE TABLE IF NOT EXISTS ProjectTask (
      id TEXT PRIMARY KEY NOT NULL,
      projectId TEXT NOT NULL,
      userId TEXT,
      parentTaskId TEXT,
      goalId TEXT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'backlog',
      priority TEXT NOT NULL DEFAULT 'medium',
      assignedAgent TEXT,
      responsibleAgent TEXT,
      acceptanceCriteria TEXT,
      requiredCapabilities TEXT,
      outputContract TEXT,
      claimedRunId TEXT,
      activeRunId TEXT,
      executionLockedAt DATETIME,
      attemptCount INTEGER NOT NULL DEFAULT 0,
      maxAttempts INTEGER NOT NULL DEFAULT 3,
      blockedReason TEXT,
      startedAt DATETIME,
      completedAt DATETIME,
      cancelledAt DATETIME,
      nextStep TEXT,
      createdAt DATETIME,
      updatedAt DATETIME
    )`,
  },
  {
    name: "ProjectTaskDependency",
    sql: `CREATE TABLE IF NOT EXISTS ProjectTaskDependency (
      id TEXT PRIMARY KEY NOT NULL,
      projectId TEXT NOT NULL,
      taskId TEXT NOT NULL,
      blockingTaskId TEXT NOT NULL,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  },
  {
    name: "ProjectPlan",
    sql: `CREATE TABLE IF NOT EXISTS ProjectPlan (
      id TEXT PRIMARY KEY NOT NULL,
      projectId TEXT NOT NULL,
      revision INTEGER NOT NULL,
      status TEXT NOT NULL,
      body TEXT NOT NULL,
      decisionSnapshot TEXT,
      capabilityResolution TEXT,
      requestFingerprint TEXT NOT NULL,
      createdByAgent TEXT,
      acceptedByUserId TEXT,
      acceptedAt DATETIME,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  },
  {
    name: "ProjectPlanDecomposition",
    sql: `CREATE TABLE IF NOT EXISTS ProjectPlanDecomposition (
      id TEXT PRIMARY KEY NOT NULL,
      projectId TEXT NOT NULL,
      planId TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'in_flight',
      requestedTasks TEXT NOT NULL,
      createdTaskIds TEXT NOT NULL,
      ownerAgent TEXT,
      ownerRunId TEXT,
      fingerprint TEXT NOT NULL,
      completedAt DATETIME,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  },
  {
    name: "ProjectTaskArtifact",
    sql: `CREATE TABLE IF NOT EXISTS ProjectTaskArtifact (
      id TEXT PRIMARY KEY NOT NULL,
      projectId TEXT NOT NULL,
      projectTaskId TEXT NOT NULL,
      executionRunId TEXT,
      wakeupId TEXT,
      agentKey TEXT NOT NULL,
      artifactType TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT,
      content TEXT,
      safeLocation TEXT,
      contentHash TEXT NOT NULL,
      source TEXT NOT NULL,
      metadata TEXT,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  },
  {
    name: "AgentWakeup",
    sql: `CREATE TABLE IF NOT EXISTS AgentWakeup (
      id TEXT PRIMARY KEY NOT NULL,
      userId TEXT NOT NULL,
      projectId TEXT,
      projectTaskId TEXT,
      agentKey TEXT NOT NULL,
      source TEXT NOT NULL,
      reason TEXT NOT NULL,
      payload TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      coalescedCount INTEGER NOT NULL DEFAULT 0,
      requestedByActorType TEXT,
      requestedByActorId TEXT,
      idempotencyKey TEXT,
      runId TEXT,
      requestedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      claimedAt DATETIME,
      finishedAt DATETIME,
      error TEXT,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  },
  {
    name: "CapabilityGap",
    sql: `CREATE TABLE IF NOT EXISTS CapabilityGap (
      id TEXT PRIMARY KEY NOT NULL,
      userId TEXT NOT NULL,
      projectId TEXT NOT NULL,
      projectTaskId TEXT,
      capabilityName TEXT NOT NULL,
      capabilityType TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'detected',
      assignedAgent TEXT,
      selectedCandidateId TEXT,
      resolvedSkillId TEXT,
      blockedReason TEXT,
      attemptCount INTEGER NOT NULL DEFAULT 0,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  },
  {
    name: "Skill",
    sql: `CREATE TABLE IF NOT EXISTS Skill (
      id TEXT PRIMARY KEY NOT NULL,
      skillId TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      currentVersionId TEXT,
      latestValidationStatus TEXT,
      riskClassification TEXT,
      approvalRequired INTEGER NOT NULL DEFAULT 0,
      rollbackInformation TEXT,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  },
  {
    name: "SkillVersion",
    sql: `CREATE TABLE IF NOT EXISTS SkillVersion (
      id TEXT PRIMARY KEY NOT NULL,
      skillId TEXT NOT NULL,
      version INTEGER NOT NULL,
      definition TEXT NOT NULL,
      executionTool TEXT,
      ownerAgents TEXT,
      permissionScope TEXT,
      validationStatus TEXT NOT NULL DEFAULT 'draft',
      rollbackReference TEXT,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  },
  {
    name: "SkillSource",
    sql: `CREATE TABLE IF NOT EXISTS SkillSource (
      id TEXT PRIMARY KEY NOT NULL,
      skillId TEXT NOT NULL,
      versionId TEXT,
      repository TEXT NOT NULL,
      filePath TEXT NOT NULL,
      commitSha TEXT NOT NULL,
      license TEXT,
      trustLevel TEXT NOT NULL,
      compatibility TEXT,
      fileInventory TEXT,
      contentHash TEXT NOT NULL,
      requiredDependencies TEXT,
      requiredCredentials TEXT,
      permissionScope TEXT,
      rollbackPlan TEXT,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  },
  {
    name: "SkillEvaluationCase",
    sql: `CREATE TABLE IF NOT EXISTS SkillEvaluationCase (
      id TEXT PRIMARY KEY NOT NULL,
      skillId TEXT NOT NULL,
      versionId TEXT,
      caseType TEXT NOT NULL,
      prompt TEXT NOT NULL,
      expected TEXT,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  },
  {
    name: "SkillEvaluationRun",
    sql: `CREATE TABLE IF NOT EXISTS SkillEvaluationRun (
      id TEXT PRIMARY KEY NOT NULL,
      skillId TEXT NOT NULL,
      versionId TEXT,
      status TEXT NOT NULL,
      result TEXT NOT NULL,
      passedCount INTEGER NOT NULL DEFAULT 0,
      failedCount INTEGER NOT NULL DEFAULT 0,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  },
  {
    name: "AgentSkillAssignment",
    sql: `CREATE TABLE IF NOT EXISTS AgentSkillAssignment (
      id TEXT PRIMARY KEY NOT NULL,
      agentKey TEXT NOT NULL,
      skillId TEXT NOT NULL,
      versionId TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  },
];

const indexes = [
  ["Project", "Project_userId_phase_idx", "CREATE INDEX IF NOT EXISTS Project_userId_phase_idx ON Project(userId, phase)"],
  ["ProjectTask", "ProjectTask_projectId_status_idx", "CREATE INDEX IF NOT EXISTS ProjectTask_projectId_status_idx ON ProjectTask(projectId, status)"],
  ["ProjectTask", "ProjectTask_assignedAgent_status_idx", "CREATE INDEX IF NOT EXISTS ProjectTask_assignedAgent_status_idx ON ProjectTask(assignedAgent, status)"],
  ["ProjectTask", "ProjectTask_parentTaskId_idx", "CREATE INDEX IF NOT EXISTS ProjectTask_parentTaskId_idx ON ProjectTask(parentTaskId)"],
  ["ProjectTaskDependency", "ProjectTaskDependency_taskId_blockingTaskId_key", "CREATE UNIQUE INDEX IF NOT EXISTS ProjectTaskDependency_taskId_blockingTaskId_key ON ProjectTaskDependency(taskId, blockingTaskId)"],
  ["ProjectTaskDependency", "ProjectTaskDependency_projectId_idx", "CREATE INDEX IF NOT EXISTS ProjectTaskDependency_projectId_idx ON ProjectTaskDependency(projectId)"],
  ["ProjectTaskDependency", "ProjectTaskDependency_blockingTaskId_idx", "CREATE INDEX IF NOT EXISTS ProjectTaskDependency_blockingTaskId_idx ON ProjectTaskDependency(blockingTaskId)"],
  ["ProjectPlan", "ProjectPlan_projectId_revision_key", "CREATE UNIQUE INDEX IF NOT EXISTS ProjectPlan_projectId_revision_key ON ProjectPlan(projectId, revision)"],
  ["ProjectPlan", "ProjectPlan_projectId_status_idx", "CREATE INDEX IF NOT EXISTS ProjectPlan_projectId_status_idx ON ProjectPlan(projectId, status)"],
  ["ProjectPlanDecomposition", "ProjectPlanDecomposition_projectId_planId_key", "CREATE UNIQUE INDEX IF NOT EXISTS ProjectPlanDecomposition_projectId_planId_key ON ProjectPlanDecomposition(projectId, planId)"],
  ["ProjectPlanDecomposition", "ProjectPlanDecomposition_fingerprint_idx", "CREATE INDEX IF NOT EXISTS ProjectPlanDecomposition_fingerprint_idx ON ProjectPlanDecomposition(fingerprint)"],
  ["ProjectTaskArtifact", "ProjectTaskArtifact_projectId_createdAt_idx", "CREATE INDEX IF NOT EXISTS ProjectTaskArtifact_projectId_createdAt_idx ON ProjectTaskArtifact(projectId, createdAt)"],
  ["ProjectTaskArtifact", "ProjectTaskArtifact_projectTaskId_idx", "CREATE INDEX IF NOT EXISTS ProjectTaskArtifact_projectTaskId_idx ON ProjectTaskArtifact(projectTaskId)"],
  ["ProjectTaskArtifact", "ProjectTaskArtifact_executionRunId_idx", "CREATE INDEX IF NOT EXISTS ProjectTaskArtifact_executionRunId_idx ON ProjectTaskArtifact(executionRunId)"],
  ["ProjectTaskArtifact", "ProjectTaskArtifact_wakeupId_idx", "CREATE INDEX IF NOT EXISTS ProjectTaskArtifact_wakeupId_idx ON ProjectTaskArtifact(wakeupId)"],
  ["ProjectTaskArtifact", "ProjectTaskArtifact_artifactType_idx", "CREATE INDEX IF NOT EXISTS ProjectTaskArtifact_artifactType_idx ON ProjectTaskArtifact(artifactType)"],
  ["AgentWakeup", "AgentWakeup_idempotencyKey_key", "CREATE UNIQUE INDEX IF NOT EXISTS AgentWakeup_idempotencyKey_key ON AgentWakeup(idempotencyKey)"],
  ["AgentWakeup", "AgentWakeup_agentKey_status_requestedAt_idx", "CREATE INDEX IF NOT EXISTS AgentWakeup_agentKey_status_requestedAt_idx ON AgentWakeup(agentKey, status, requestedAt)"],
  ["AgentWakeup", "AgentWakeup_projectId_requestedAt_idx", "CREATE INDEX IF NOT EXISTS AgentWakeup_projectId_requestedAt_idx ON AgentWakeup(projectId, requestedAt)"],
  ["AgentWakeup", "AgentWakeup_projectTaskId_idx", "CREATE INDEX IF NOT EXISTS AgentWakeup_projectTaskId_idx ON AgentWakeup(projectTaskId)"],
  ["CapabilityGap", "CapabilityGap_projectId_status_idx", "CREATE INDEX IF NOT EXISTS CapabilityGap_projectId_status_idx ON CapabilityGap(projectId, status)"],
  ["CapabilityGap", "CapabilityGap_userId_status_idx", "CREATE INDEX IF NOT EXISTS CapabilityGap_userId_status_idx ON CapabilityGap(userId, status)"],
  ["Skill", "Skill_skillId_key", "CREATE UNIQUE INDEX IF NOT EXISTS Skill_skillId_key ON Skill(skillId)"],
  ["Skill", "Skill_status_idx", "CREATE INDEX IF NOT EXISTS Skill_status_idx ON Skill(status)"],
  ["SkillVersion", "SkillVersion_skillId_version_key", "CREATE UNIQUE INDEX IF NOT EXISTS SkillVersion_skillId_version_key ON SkillVersion(skillId, version)"],
  ["SkillVersion", "SkillVersion_skillId_validationStatus_idx", "CREATE INDEX IF NOT EXISTS SkillVersion_skillId_validationStatus_idx ON SkillVersion(skillId, validationStatus)"],
  ["SkillSource", "SkillSource_skillId_idx", "CREATE INDEX IF NOT EXISTS SkillSource_skillId_idx ON SkillSource(skillId)"],
  ["SkillSource", "SkillSource_commitSha_idx", "CREATE INDEX IF NOT EXISTS SkillSource_commitSha_idx ON SkillSource(commitSha)"],
  ["SkillEvaluationCase", "SkillEvaluationCase_skillId_caseType_idx", "CREATE INDEX IF NOT EXISTS SkillEvaluationCase_skillId_caseType_idx ON SkillEvaluationCase(skillId, caseType)"],
  ["SkillEvaluationRun", "SkillEvaluationRun_skillId_createdAt_idx", "CREATE INDEX IF NOT EXISTS SkillEvaluationRun_skillId_createdAt ON SkillEvaluationRun(skillId, createdAt)"],
  ["AgentSkillAssignment", "AgentSkillAssignment_agentKey_skillId_key", "CREATE UNIQUE INDEX IF NOT EXISTS AgentSkillAssignment_agentKey_skillId_key ON AgentSkillAssignment(agentKey, skillId)"],
  ["AgentSkillAssignment", "AgentSkillAssignment_agentKey_status_idx", "CREATE INDEX IF NOT EXISTS AgentSkillAssignment_agentKey_status_idx ON AgentSkillAssignment(agentKey, status)"],
];

function requireEnv() {
  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
  if (missing.length) throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  const url = process.env.TURSO_DATABASE_URL;
  const local = /^file:/i.test(url) || /^sqlite:/i.test(url);
  if (local && process.env.HERMES_ALLOW_LOCAL_MIGRATION !== "1") {
    throw new Error("Refusing local project-control migration without HERMES_ALLOW_LOCAL_MIGRATION=1.");
  }
  if (!local && !["scratch", "production"].includes(process.env.HERMES_MIGRATION_TARGET ?? "")) {
    throw new Error("Refusing unclassified remote migration; set HERMES_MIGRATION_TARGET=scratch or production explicitly.");
  }
}

async function tableExists(db, tableName) {
  const result = await db.execute({
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
    args: [tableName],
  });
  return result.rows.length > 0;
}

async function columnsFor(db, tableName) {
  if (!(await tableExists(db, tableName))) return new Set();
  const result = await db.execute(`PRAGMA table_info(${tableName})`);
  return new Set(result.rows.map((row) => String(row.name)));
}

async function addMissingColumns(db, tableName, columns, report) {
  const existing = await columnsFor(db, tableName);
  if (!existing.size) {
    report.existingObjects.push(`${tableName}:missing`);
    return;
  }
  report.existingObjects.push(`${tableName}:table`);
  for (const [name, definition] of columns) {
    if (existing.has(name)) continue;
    await db.execute(`ALTER TABLE ${tableName} ADD COLUMN ${name} ${definition}`);
    report.columnsAdded.push(`${tableName}.${name}`);
  }
}

async function migrate() {
  requireEnv();
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  const report = {
    existingObjects: [],
    objectsCreated: [],
    columnsAdded: [],
    indexesCreated: [],
    verification: "not_run",
  };

  for (const table of createTables) {
    const existed = await tableExists(db, table.name);
    await db.execute(table.sql);
    if (!existed) report.objectsCreated.push(table.name);
    else report.existingObjects.push(`${table.name}:table`);
  }

  await addMissingColumns(db, "Project", projectColumns, report);
  await addMissingColumns(db, "ProjectTask", projectTaskColumns, report);
  await addMissingColumns(db, "ProjectPlan", projectPlanColumns, report);

  for (const [tableName, indexName, sql] of indexes) {
    if (!(await tableExists(db, tableName))) continue;
    await db.execute(sql);
    report.indexesCreated.push(indexName);
  }

  const requiredTables = createTables.map((table) => table.name);
  const missingTables = [];
  for (const tableName of requiredTables) {
    if (!(await tableExists(db, tableName))) missingTables.push(tableName);
  }
  const projectFinal = await columnsFor(db, "Project");
  const taskFinal = await columnsFor(db, "ProjectTask");
  const planFinal = await columnsFor(db, "ProjectPlan");
  const missingColumns = [
    ...projectColumns.filter(([name]) => !projectFinal.has(name)).map(([name]) => `Project.${name}`),
    ...projectTaskColumns.filter(([name]) => !taskFinal.has(name)).map(([name]) => `ProjectTask.${name}`),
    ...projectPlanColumns.filter(([name]) => !planFinal.has(name)).map(([name]) => `ProjectPlan.${name}`),
  ];

  if (missingTables.length || missingColumns.length) {
    report.verification = `failed: missing ${[...missingTables, ...missingColumns].join(", ")}`;
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }
  report.verification = "passed";
  console.log(JSON.stringify(report, null, 2));
}

migrate().catch((error) => {
  console.error(`[project-control-migration] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
