import { defineConfig } from "drizzle-kit";
import { readFileSync } from "node:fs";

// Minimal .env loader (Next.js loads .env for the app itself; drizzle-kit does not).
const env: Record<string, string> = {};
try {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2];
  }
} catch {}

export default defineConfig({
  schema: "./src/lib/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? env.DATABASE_URL },
});
