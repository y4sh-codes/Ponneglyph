import Redis from "ioredis";
import { env } from "./env";

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 2,
  enableReadyCheck: true,
  lazyConnect: true,
  enableOfflineQueue: false,
  retryStrategy: (attempt) => Math.min(attempt * 100, 2_000),
});

let lastRedisErrorLogAt = 0;

function logRedisIssue(error: unknown): void {
  const now = Date.now();
  if (now - lastRedisErrorLogAt < 10_000) {
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[redis] unavailable, continuing in degraded mode: ${message}`);
  lastRedisErrorLogAt = now;
}

redis.on("error", (error) => {
  logRedisIssue(error);
});

redis.on("ready", () => {
  console.info("[redis] connected");
});

async function safeRedis<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    logRedisIssue(error);
    return fallback;
  }
}

export function suggestionCacheKey(userId: string): string {
  return `volunteer:suggestions:${userId}`;
}

export function profileViewKey(userId: string): string {
  return `volunteer:profile-views:${userId}`;
}

export async function invalidateSuggestionCache(userIds: string[]): Promise<void> {
  if (userIds.length === 0) {
    return;
  }

  const keys = userIds.map((userId) => suggestionCacheKey(userId));
  await safeRedis(async () => {
    await redis.del(...keys);
  }, undefined);
}

export async function getCachedSuggestions(userId: string): Promise<string | null> {
  return safeRedis(async () => redis.get(suggestionCacheKey(userId)), null);
}

export async function setCachedSuggestions(
  userId: string,
  value: string,
  ttlSeconds: number,
): Promise<void> {
  await safeRedis(async () => {
    await redis.set(suggestionCacheKey(userId), value, "EX", ttlSeconds);
  }, undefined);
}

export async function trackProfileView(
  viewerUserId: string,
  targetUserId: string,
  ttlSeconds: number,
): Promise<number | null> {
  return safeRedis(async () => {
    const redisKey = profileViewKey(viewerUserId);
    const viewCountRaw = await redis.zincrby(redisKey, 1, targetUserId);
    await redis.expire(redisKey, ttlSeconds);

    const metadataKey = `volunteer:profile-view-meta:${viewerUserId}`;
    await redis.hset(
      metadataKey,
      targetUserId,
      JSON.stringify({
        userId: targetUserId,
        viewCount: Number(viewCountRaw),
        viewedAt: new Date().toISOString(),
      }),
    );
    await redis.expire(metadataKey, ttlSeconds);

    return Number(viewCountRaw);
  }, null);
}

export async function getProfileViewScores(userId: string): Promise<string[]> {
  return safeRedis(async () => redis.zrevrange(profileViewKey(userId), 0, 100, "WITHSCORES"), []);
}
