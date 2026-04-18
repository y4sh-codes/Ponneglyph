import { ToolLoopAgent, tool, stepCountIs } from "ai";
import { groq } from "@ai-sdk/groq";
import { tavilySearch, tavilyExtract } from "@tavily/ai-sdk";
import { z } from "zod";
import { redis } from "../../lib/redis";
import { hashQuery } from "../../lib/hash";
import { deepResearchSystemPrompt } from "../prompts/deep-research";

const DEEP_CACHE_TTL = 60 * 60 * 2; // 2 hours
const DEEP_CACHE_VERSION = "v1";

// Non-streaming subagent — it's used as a tool by the parent orchestrator,
// so it just returns the final compiled result, not a stream.
// Non-streaming subagent — used as a tool by the parent orchestrator,
// so it returns the final compiled result, not a stream.
const deepResearchAgent = new ToolLoopAgent({
  model: groq("llama-3.3-70b-versatile"),
  instructions: deepResearchSystemPrompt,
  tools: {
    webSearch: tavilySearch({
      maxResults: 5,
    }),
    webExtract: tavilyExtract(),
  },
  stopWhen: stepCountIs(5),
});

/**
 * Wraps the deep research agent as a tool callable by the parent orchestrator.
 * Uses agent.generate() (not streaming) — returns the final curated result.
 */
export const deepResearchTool = tool({
  description:
    "Conduct thorough multi-step web research on a humanitarian topic. Uses multiple search queries, content extraction, and cross-referencing. Use for complex questions that need depth beyond a simple web search.",
  inputSchema: z.object({
    topic: z.string().describe("The research topic or question to investigate"),
    context: z
      .string()
      .optional()
      .describe("Additional context from previous search results to refine the research"),
  }),
  execute: async ({ topic, context }) => {
    const input = context ? JSON.stringify({ topic, context }) : topic;
    const hash = hashQuery(input);
    const cacheKey = `tool:deep:${DEEP_CACHE_VERSION}:${hash}`;

    let cached: string | null = null;
    try {
      cached = await redis.get<string>(cacheKey);
    } catch {
      // Redis down — fall back to API
    }
    if (cached) return cached;

    const prompt = context
      ? `Research topic: ${topic}\n\nAdditional context from prior searches:\n${context}\n\nConduct thorough research and provide a structured summary.`
      : `Research topic: ${topic}\n\nConduct thorough research and provide a structured summary.`;

    const result = await deepResearchAgent.generate({
      prompt,
    });

    redis.set(cacheKey, result.text, { ex: DEEP_CACHE_TTL }).catch(() => {});

    return result.text;
  },
});
