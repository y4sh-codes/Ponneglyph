import { Pool, type PoolClient } from "pg";
import { env } from "./env";
import type { ConnectionRequest, PostInteractionMap, TopicScoreMap } from "./types";

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
});

export type VolunteerRecord = {
  user_id: string;
  interests: string[] | null;
  connections: string[] | null;
  inbox_requests: ConnectionRequest[] | null;
  sent_requests: ConnectionRequest[] | null;
  post_engagement: PostInteractionMap | null;
  topic_engagement: TopicScoreMap | null;
};

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function asStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input.filter((item): item is string => typeof item === "string");
}

export function asObject<T extends object>(input: unknown, fallback: T): T {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return fallback;
  }

  return input as T;
}

export function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}
