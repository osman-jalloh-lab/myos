import { fileURLToPath } from "url";
import { dirname } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: { root: __dirname },
  // Prisma + libSQL native bits must stay external in serverless functions
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-libsql", "@libsql/client"],
  experimental: {
    // keep server actions/body limits sane for draft payloads
    serverActions: { bodySizeLimit: "2mb" },
  },
};

export default nextConfig;
