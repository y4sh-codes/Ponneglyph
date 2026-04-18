import { embed } from "ai";
import { google } from "@ai-sdk/google";
import { redis } from "./redis";
import { hashQuery } from "./hash";

const EMBEDDING_MODEL = google.textEmbeddingModel("gemini-embedding-2-preview");
const CACHE_TTL = 60 * 60 * 24; // 24 hours

/**
 * Embeds a query using Google's model. Results are cached in Redis for 24h
 * since the same user queries (or repeated ones) are common in chat UX.
 * Cache miss → call API → cache result. Simple and effective.
 */
export async function embedQuery(query: string): Promise<number[]> {
  const normalized = query.trim().toLowerCase();
  const cacheKey = `emb:${hashQuery(normalized)}`;

  // Check Redis cache first
  let cached: number[] | null = null;
  try {
    cached = await redis.get<number[]>(cacheKey);
  } catch {
    // Redis down — fall back to API
  }
  if (cached) return cached;

  const { embedding } = await embed({
    model: EMBEDDING_MODEL,
    value: normalized,
    providerOptions: {
      google: {
        outputDimensionality: 768,
      },
    },
  });

  // Cache for 24h (fire-and-forget)
  redis.set(cacheKey, embedding, { ex: CACHE_TTL }).catch(() => {});

  return embedding;
}
