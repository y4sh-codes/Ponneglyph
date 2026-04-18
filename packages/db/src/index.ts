import { env } from "@Poneglyph/env/server";
import { drizzle } from "drizzle-orm/node-postgres";

import * as schema from "./schema";

// Re-export sql from the same drizzle-orm copy that db uses.
// This prevents the "duplicate drizzle-orm" type conflict when server imports sql
// from here instead of directly from 'drizzle-orm' (vercel ai sdk pulls in its own copy).
export { sql } from "drizzle-orm";

export function createDb() {
  return drizzle(env.DATABASE_URL, { schema });
}

export const db = createDb();
