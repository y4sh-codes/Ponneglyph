import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { env } from "../env";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main(): Promise<void> {
  const sqlPath = join(__dirname, "../sql/bootstrap.sql");
  const sql = await readFile(sqlPath, "utf8");

  const pool = new Pool({ connectionString: env.DATABASE_URL });
  try {
    const preflight = await pool.query<{ user_table: string | null }>(
      "SELECT to_regclass('public.user') AS user_table",
    );

    if (!preflight.rows[0]?.user_table) {
      throw new Error(
        [
          "Required table public.user was not found.",
          "Volunteer table depends on the existing auth user table via FK.",
          "Fix:",
          "1) Ensure DATABASE_URL points to the same DB used by the main backend/auth service.",
          "2) Run base DB migrations first (packages/db migrations) for that database.",
          `Current DATABASE_URL: ${env.DATABASE_URL}`,
        ].join("\n"),
      );
    }

    await pool.query(sql);
    console.log("Volunteer table bootstrap migration applied successfully.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Failed to run volunteer migration:", error);
  process.exit(1);
});
