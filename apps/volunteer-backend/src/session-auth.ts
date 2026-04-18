import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";
import { pool } from "./db";
import type { AppBindings } from "./types";

const SESSION_COOKIE_CANDIDATES = [
  "better-auth.session_token",
  "__Secure-better-auth.session_token",
  "better-auth.session-token",
  "__Secure-better-auth.session-token",
];

function parseCookieHeader(cookieHeader: string | undefined): Map<string, string> {
  const result = new Map<string, string>();
  if (!cookieHeader) {
    return result;
  }

  for (const chunk of cookieHeader.split(";")) {
    const trimmed = chunk.trim();
    if (!trimmed) {
      continue;
    }

    const equalIndex = trimmed.indexOf("=");
    if (equalIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, equalIndex).trim();
    const value = decodeURIComponent(trimmed.slice(equalIndex + 1).trim());
    result.set(key, value);
  }

  return result;
}

function extractSessionToken(c: Context<AppBindings>): string | null {
  const authorization = c.req.header("Authorization");
  if (authorization?.startsWith("Bearer ")) {
    const token = authorization.slice("Bearer ".length).trim();
    if (token) {
      return token;
    }
  }

  const cookies = parseCookieHeader(c.req.header("Cookie"));
  for (const name of SESSION_COOKIE_CANDIDATES) {
    const value = cookies.get(name);
    if (value) {
      return value;
    }
  }

  return null;
}

export async function requireAuthenticatedUser(
  c: Context<AppBindings>,
  next: Next,
): Promise<void> {
  const sessionToken = extractSessionToken(c);
  if (!sessionToken) {
    throw new HTTPException(401, { message: "Authentication required" });
  }

  const sessionResult = await pool.query<{ user_id: string }>(
    `SELECT user_id
     FROM session
     WHERE token = $1
       AND expires_at > NOW()
     LIMIT 1`,
    [sessionToken],
  );

  if (sessionResult.rowCount === 0) {
    throw new HTTPException(401, { message: "Invalid or expired session" });
  }

  const sessionRow = sessionResult.rows[0];
  if (!sessionRow) {
    throw new HTTPException(401, { message: "Invalid or expired session" });
  }

  c.set("userId", sessionRow.user_id);
  await next();
}

export function getAuthenticatedUserId(c: Context<AppBindings>): string {
  const userId = c.get("userId");
  if (!userId) {
    throw new HTTPException(401, { message: "Authentication required" });
  }

  return userId;
}
