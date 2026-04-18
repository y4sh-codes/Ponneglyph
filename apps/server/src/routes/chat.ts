import { Hono } from "hono";
import { createAgentUIStreamResponse } from "ai";
// import { auth } from "@Poneglyph/auth"; // TODO: re-enable auth
import { createOrchestratorAgent } from "../agents/orchestrator";

const chat = new Hono();

/**
 * POST /api/chat
 * Multi-agent research endpoint.
 * Requires a valid better-auth session (cookie-based).
 * Accepts { messages: UIMessage[] } and streams the agent response.
 *
 *
 * curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {
        "id": "msg-1",
        "role": "user",
        "parts": [
          {
            "type": "text",
            "text": "Tell me about....."
          }
        ]
      }
    ]
  }' \
  --no-buffer
 */

// TODO: will add zod validation on next pr
chat.post("/", async (c) => {
  // Auth disabled for now — will add in next PR
  // const session = await auth.api.getSession({ headers: c.req.raw.headers });
  // if (!session?.user) return c.json({ error: "Authentication required" }, 401);

  const body = await c.req.json();
  const messages = body.messages;

  if (!Array.isArray(messages) || messages.length === 0) {
    return c.json({ error: "messages array is required" }, 400);
  }

  const agent = createOrchestratorAgent();

  // Two things to note here:
  // 1. It's "uiMessages", not "messages" — that's what the API expects
  // 2. The `as any` cast is because TypeScript gets strict with generic tool types
  //    on ToolLoopAgent — the runtime behavior is fine, just a type narrowing issue
  return createAgentUIStreamResponse({
    agent: agent as any,
    uiMessages: messages,
  });
});

export default chat;
