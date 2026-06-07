import { defineConfig } from "prisma/config";

export default defineConfig({
  datasource: {
    url: process.env.TURSO_DATABASE_URL ?? "file:./prisma/dev.db",
  },
});
