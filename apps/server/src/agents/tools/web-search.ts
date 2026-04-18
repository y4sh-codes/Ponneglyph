import { generateText, tool } from "ai";
import { google } from "@ai-sdk/google";
import { z } from "zod";
import { redis } from "../../lib/redis";
import { hashQuery } from "../../lib/hash";

const WEB_CACHE_TTL = 60 * 30; // 30 minutes
const WEB_CACHE_VERSION = "v1";

export interface CachedWebResult {
  summary: string;
  sources: any;
}

/**
 * Isolated generateText call using Gemini's native Google Search grounding.
 *
 * Must be kept in its own call — Gemini does not allow mixing provider-defined
 * tools (google.tools.googleSearch) with custom tools in the same request.
 * Wrapping it here as a plain tool() lets the orchestrator treat it like any
 * other custom tool with no restrictions.
 *
 * Ref: https://ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai#google-search-grounding
 */
async function runGoogleGroundedSearch(query: string): Promise<CachedWebResult> {
  const hash = hashQuery(query);
  const cacheKey = `tool:web:${WEB_CACHE_VERSION}:${hash}`;

  let cached: CachedWebResult | null = null;
  try {
    cached = await redis.get<CachedWebResult>(cacheKey);
  } catch {
    // Redis down — fall back to API
  }
  if (cached) return cached;

  const { text, sources } = await generateText({
    model: google("gemini-2.5-flash"),
    tools: { google_search: google.tools.googleSearch({}) },
    prompt: query,
  });

  const result: CachedWebResult = { summary: text, sources };
  redis.set(cacheKey, result, { ex: WEB_CACHE_TTL }).catch(() => {});

  return result;
}

export const webSearchTool = tool({
  description:
    "Fast real-time web search using Google Search grounding via Gemini. " +
    "Use for current events, breaking crises, recent news, live policy updates, and any query requiring up-to-date information. " +
    "Returns a grounded summary and a list of source citations.",
  inputSchema: z.object({
    query: z.string().describe("The search query"),
  }),
  execute: async ({ query }) => runGoogleGroundedSearch(query),
});
