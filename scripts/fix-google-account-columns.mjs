import { createClient } from "@libsql/client";

const databaseUrl = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (!databaseUrl) {
  console.error("ERROR: TURSO_DATABASE_URL is missing.");
  process.exit(1);
}

if (!authToken) {
  console.error("ERROR: TURSO_AUTH_TOKEN is missing.");
  process.exit(1);
}

if (databaseUrl.startsWith("file:")) {
  console.error("STOPPED: This points to a local database, not production.");
  console.error(`Current URL: ${databaseUrl}`);
  process.exit(1);
}

const client = createClient({
  url: databaseUrl,
  authToken,
});

const requiredColumns = [
  {
    name: "lastSyncedAt",
    sql: `ALTER TABLE "GoogleAccount" ADD COLUMN "lastSyncedAt" DATETIME`,
  },
  {
    name: "lastSyncStatus",
    sql: `ALTER TABLE "GoogleAccount" ADD COLUMN "lastSyncStatus" TEXT`,
  },
  {
    name: "lastError",
    sql: `ALTER TABLE "GoogleAccount" ADD COLUMN "lastError" TEXT`,
  },
];

async function getColumns() {
  const result = await client.execute(
    `PRAGMA table_info("GoogleAccount")`
  );

  return result.rows.map((row) => String(row.name));
}

try {
  const existingColumns = await getColumns();

  if (existingColumns.length === 0) {
    throw new Error(
      'The GoogleAccount table was not found. This may be the wrong database.'
    );
  }

  console.log("Connected to the database.");
  console.log("Existing GoogleAccount columns:");
  console.log(existingColumns.join(", "));
  console.log("");

  for (const column of requiredColumns) {
    if (existingColumns.includes(column.name)) {
      console.log(`Already exists: ${column.name}`);
      continue;
    }

    console.log(`Adding: ${column.name}`);
    await client.execute(column.sql);
    console.log(`Added successfully: ${column.name}`);
  }

  const finalColumns = await getColumns();

  console.log("");
  console.log("Verification:");

  for (const column of requiredColumns) {
    const status = finalColumns.includes(column.name)
      ? "FOUND"
      : "MISSING";

    console.log(`${status}: ${column.name}`);
  }

  const repaired = requiredColumns.every((column) =>
    finalColumns.includes(column.name)
  );

  if (!repaired) {
    throw new Error("One or more required columns are still missing.");
  }

  console.log("");
  console.log("SUCCESS: The GoogleAccount table has been repaired.");
} catch (error) {
  console.error("");
  console.error("REPAIR FAILED:");

  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(error);
  }

  process.exitCode = 1;
} finally {
  client.close();
}
