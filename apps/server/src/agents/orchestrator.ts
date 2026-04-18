import { ToolLoopAgent, stepCountIs } from "ai";
import { google } from "@ai-sdk/google";
import { searchDatabaseTool } from "./tools/search-db";
import { deepResearchTool } from "./sub-agents/deep-research";
import { webSearchTool } from "./tools/web-search";
import { orchestratorSystemPrompt } from "./prompts/system";

/**
 * Creates the parent orchestrator agent.
 * Called per-request so each conversation gets a fresh agent instance.
 *
 * Tools:
 *  - searchDatabase: pgvector semantic search on internal datasets
 *  - webSearch: Gemini Flash native Google Search grounding (real-time web)
 *  - deepResearch: Groq + Tavily multi-step research subagent
 *
 * Note: google.tools.googleSearch({}) (provider-defined tool) cannot be mixed
 * with custom tools in the same Gemini request. webSearch wraps it in an
 * isolated generateText call, exposing it here as a plain custom tool.
 *
 * Ref: https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent
 */
export function createOrchestratorAgent() {
  return new ToolLoopAgent({
    model: google("gemini-2.5-flash"),
    instructions: orchestratorSystemPrompt,
    tools: {
      searchDatabase: searchDatabaseTool,
      webSearch: webSearchTool,
      deepResearch: deepResearchTool,
    },
    stopWhen: stepCountIs(10),
  });
}

// FIXME: Have to handel 429. maybe we can switch to another api key
// or maybe show user logs?
