import { createHash } from "node:crypto";

export function hashQuery(query: string): string {
  return createHash("sha256").update(query.trim().toLowerCase()).digest("hex");
}
