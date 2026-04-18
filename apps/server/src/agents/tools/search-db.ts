import { tool } from "ai";
import { z } from "zod";
import { db, sql } from "@Poneglyph/db";
import { embedQuery } from "../../lib/embeddings";
import { getPresignedUrl } from "../../lib/s3";

const TOP_K = 5; // FIXME: I will make it 10 after we have much more data in db

/**
 * Embeds user query and runs pgvector cosine similarity against datasets.
 * Returns top-K results with metadata and presigned S3 file links.
 *
 * I have to use raw SQL instead of drizzle's query builder here.
 * As the `ai` package installs its own copy of drizzle-orm. Importing eq, cosineDistance,
 * desc from the hoisted copy and using them with db (which uses ai's copy) causes
 * TypeScript type conflicts even though runtime behavior is identical.
 * Using db.execute() + sql`` bypasses this cleanly.
 */
export const searchDatabaseTool = tool({
  description:
    "Search Poneglyph's internal database of humanitarian datasets, field reports, and NGO uploads using semantic similarity. Use this for finding relevant internal data, reports, and documents.",
  inputSchema: z.object({
    query: z.string().describe("The search query describing what data or reports to find"),
  }),
  execute: async ({ query }) => {
    const queryEmbedding = await embedQuery(query);
    const embeddingStr = `[${queryEmbedding.join(",")}]`;

    // `<=>` is pgvector's cosine distance operator — same as drizzle's cosineDistance()
    const results = await db.execute<{
      id: string;
      title: string;
      description: string | null;
      summary: string | null;
      publisher: string | null;
      publication_date: string | null;
      s3_keys: string[] | null;
      file_types: string[] | null;
      source_url: string | null;
      source_name: string;
      source_type: string;
      similarity: number;
    }>(sql`
      SELECT
        d.id,
        d.title,
        d.description,
        d.summary,
        d.publisher,
        d.publication_date,
        d.s3_keys,
        d.file_types,
        d.source_url,
        s.name AS source_name,
        s.source_type,
        1 - (d.embedding <=> ${embeddingStr}::vector) AS similarity
      FROM datasets d
      INNER JOIN sources s ON d.source_id = s.id
      WHERE d.embedding IS NOT NULL
      ORDER BY similarity DESC
      LIMIT ${TOP_K}
    `);

    const rows = results.rows;

    if (rows.length === 0) {
      return {
        datasets: [],
        message: "No matching datasets found in the internal database.",
      };
    }

    // Batch-fetch tags for all result dataset IDs in a single query
    const datasetIds = rows.map((r) => r.id);
    const allTags = await db.execute<{ dataset_id: string; name: string }>(sql`
      SELECT dt.dataset_id, t.name
      FROM dataset_tags dt
      INNER JOIN tags t ON dt.tag_id = t.id
      WHERE dt.dataset_id IN (${sql.join(
        datasetIds.map((id) => sql`${id}`),
        sql`, `,
      )})
    `);

    // Map tags to their datasets for O(1) lookup
    const tagsByDataset = new Map<string, string[]>();
    for (const t of allTags.rows) {
      const existing = tagsByDataset.get(t.dataset_id);
      if (existing) existing.push(t.name);
      else tagsByDataset.set(t.dataset_id, [t.name]);
    }

    // Enrich each result: generate presigned S3 URLs for file access,
    // and attach pre-fetched tags for filtering/display.
    const enriched = await Promise.all(
      rows.map(async (r) => {
        const fileLinks = r.s3_keys
          ? await Promise.all(
              r.s3_keys.map(async (key: string) => ({
                key,
                url: await getPresignedUrl(key),
              })),
            )
          : [];

        return {
          title: r.title,
          description: r.description,
          summary: r.summary,
          publisher: r.publisher,
          publicationDate: r.publication_date,
          sourceUrl: r.source_url,
          sourceName: r.source_name,
          sourceType: r.source_type,
          fileTypes: r.file_types,
          files: fileLinks,
          tags: tagsByDataset.get(r.id) ?? [],
          relevanceScore: Number(r.similarity).toFixed(4),
        };
      }),
    );

    return {
      datasets: enriched,
      message: `Found ${enriched.length} relevant datasets.`,
    };
  },
});
