import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is not set (copy .env.example to .env)");
}

// Singleton across hot reloads / route invocations.
const globalForDb = globalThis as unknown as { __agentSocialPool?: Pool };

export const pool =
  globalForDb.__agentSocialPool ??
  new Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });

if (process.env.NODE_ENV !== "production") globalForDb.__agentSocialPool = pool;

export const db = drizzle(pool, { schema });
export { schema };
