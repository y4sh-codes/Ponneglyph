import { Hono } from "hono";
import { z } from "zod";
import {
  getCachedSuggestions,
  invalidateSuggestionCache,
  setCachedSuggestions,
  trackProfileView,
} from "../cache";
import { pool, withTransaction } from "../db";
import { env } from "../env";
import { buildVolunteerSuggestions } from "../services/matchmaking.js";
import { getAuthenticatedUserId, requireAuthenticatedUser } from "../session-auth";
import { ensureBucket, uploadProfileImage } from "../storage";
import type { AppBindings, ConnectionRequest, RequestStatus } from "../types";
import { normalizeInterests, normalizeTopics } from "../utils";

type InterestTag = {
  id: string;
  name: string;
  slug: string;
};

type MessageRow = {
  id: string;
  from_user_id: string;
  to_user_id: string;
  status: RequestStatus;
  message: string | null;
  created_at: string | Date;
  responded_at: string | Date | null;
};

const interestsSchema = z.object({
  interests: z.array(z.string().min(1)).min(1),
});

const profileUpdateSchema = z.object({
  description: z.string().trim().max(4000).nullable().optional(),
  city: z.string().trim().max(100).nullable().optional(),
  pastWorks: z.array(z.string().trim().min(1).max(160)).max(50).optional(),
  bio: z.string().trim().max(1000).nullable().optional(),
  isOpenToWork: z.boolean().optional(),
  wantsToStartOrg: z.boolean().optional(),
  wantsToHire: z.boolean().optional(),
});

const connectSchema = z.object({
  message: z.string().trim().max(280).optional(),
});

const respondSchema = z.object({
  action: z.enum(["accept", "reject"]),
});

const engagementSchema = z.object({
  postId: z.string().trim().min(1).max(120),
  action: z.enum(["like", "save", "open"]),
  topics: z.array(z.string().min(1).max(60)).max(10).optional(),
});

function countWordsExcludingSpaces(value: string): number {
  const words = value.trim().split(/\s+/).filter(Boolean);
  return words.length;
}

function normalizeNullableText(value: string | null | undefined): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toIsoString(value: string | Date | null): string | null {
  if (value === null) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return new Date(value).toISOString();
}

function asInterestTagArray(input: unknown): InterestTag[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        return null;
      }

      const value = item as Partial<InterestTag>;
      if (
        typeof value.id !== "string" ||
        typeof value.name !== "string" ||
        typeof value.slug !== "string"
      ) {
        return null;
      }

      return {
        id: value.id,
        name: value.name,
        slug: value.slug,
      };
    })
    .filter((item): item is InterestTag => item !== null);
}

function canonicalPair(leftUserId: string, rightUserId: string): [string, string] {
  if (leftUserId < rightUserId) {
    return [leftUserId, rightUserId];
  }

  return [rightUserId, leftUserId];
}

function toConnectionRequest(row: MessageRow): ConnectionRequest {
  const createdAt = toIsoString(row.created_at);
  const respondedAt = toIsoString(row.responded_at);

  return {
    requestId: row.id,
    fromUserId: row.from_user_id,
    toUserId: row.to_user_id,
    status: row.status,
    createdAt: createdAt ?? new Date().toISOString(),
    ...(respondedAt ? { respondedAt } : {}),
    ...(row.message ? { message: row.message } : {}),
  };
}

async function getConnectedUserIds(userId: string): Promise<string[]> {
  const result = await pool.query<{ peer_user_id: string }>(
    `SELECT CASE
              WHEN user_low_id = $1 THEN user_high_id
              ELSE user_low_id
            END AS peer_user_id
     FROM volunteer_connection
     WHERE user_low_id = $1
        OR user_high_id = $1`,
    [userId],
  );

  return result.rows.map((row) => row.peer_user_id);
}

export const volunteerRoutes = new Hono<AppBindings>();

volunteerRoutes.get("/metadata/interests", async (c) => {
  const result = await pool.query<{ slug: string }>(
    `SELECT slug
     FROM tags
     ORDER BY name ASC`,
  );

  const interests = result.rows.map((row) => row.slug);

  return c.json({
    count: interests.length,
    interests,
  });
});

volunteerRoutes.use("/volunteers/*", requireAuthenticatedUser);

volunteerRoutes.post("/volunteers/me/activate", async (c) => {
  const userId = getAuthenticatedUserId(c);

  const result = await pool.query(
    `INSERT INTO volunteer (
       user_id,
       past_works,
       is_open_to_work,
       wants_to_start_org,
       wants_to_hire
     )
     VALUES ($1, '{}'::text[], false, false, false)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );

  return c.json({
    message:
      result.rowCount === 1
        ? "Volunteer profile created"
        : "Volunteer profile already exists",
    volunteerProfileCreated: result.rowCount === 1,
  });
});

volunteerRoutes.get("/volunteers/me", async (c) => {
  const userId = getAuthenticatedUserId(c);
  const result = await pool.query<{
    id: string;
    name: string;
    email: string;
    image: string | null;
    description: string | null;
    city: string | null;
    past_works: string[] | null;
    bio: string | null;
    is_open_to_work: boolean;
    wants_to_start_org: boolean;
    wants_to_hire: boolean;
    interests: unknown;
    connections_count: number;
  }>(
    `SELECT
       u.id,
       u.name,
       u.email,
       u.image,
       v.description,
       v.city,
       v.past_works,
       v.bio,
       v.is_open_to_work,
       v.wants_to_start_org,
       v.wants_to_hire,
       COALESCE(
         (
           SELECT json_agg(
             json_build_object(
               'id', t.id,
               'name', t.name,
               'slug', t.slug
             )
             ORDER BY t.name ASC
           )
           FROM volunteer_tags vt
           INNER JOIN tags t ON t.id = vt.tag_id
           WHERE vt.volunteer_id = v.user_id
         ),
         '[]'::json
       ) AS interests,
       (
         SELECT COUNT(*)::int
         FROM volunteer_connection vc
         WHERE vc.user_low_id = v.user_id
            OR vc.user_high_id = v.user_id
       ) AS connections_count
     FROM volunteer v
     INNER JOIN "user" u ON u.id = v.user_id
     WHERE v.user_id = $1
     LIMIT 1`,
    [userId],
  );

  if (result.rowCount === 0) {
    return c.json({ error: "Volunteer profile not found" }, 404);
  }

  const row = result.rows[0];
  if (!row) {
    return c.json({ error: "Volunteer profile not found" }, 404);
  }

  return c.json({
    user: {
      id: row.id,
      name: row.name,
      email: row.email,
      image: row.image,
    },
    interests: asInterestTagArray(row.interests),
    connectionsCount: Number(row.connections_count ?? 0),
    city: row.city,
    bio: row.bio,
    description: row.description,
    pastWorks: row.past_works ?? [],
    isOpenToWork: row.is_open_to_work,
    wantsToStartOrg: row.wants_to_start_org,
    wantsToHire: row.wants_to_hire,
  });
});

volunteerRoutes.put("/volunteers/me", async (c) => {
  const userId = getAuthenticatedUserId(c);
  const body = await c.req.json().catch(() => null);
  const parsed = profileUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: "Invalid request payload",
        details: parsed.error.flatten(),
      },
      400,
    );
  }

  const description = normalizeNullableText(parsed.data.description);
  const bio = normalizeNullableText(parsed.data.bio);

  if (typeof description === "string" && countWordsExcludingSpaces(description) > 200) {
    return c.json(
      {
        error: "Description exceeds max allowed word count",
        field: "description",
        maxWords: 200,
      },
      400,
    );
  }

  if (typeof bio === "string" && countWordsExcludingSpaces(bio) > 20) {
    return c.json(
      {
        error: "Bio exceeds max allowed word count",
        field: "bio",
        maxWords: 20,
      },
      400,
    );
  }

  const city = normalizeNullableText(parsed.data.city);
  const pastWorks =
    parsed.data.pastWorks === undefined
      ? undefined
      : [...new Set(parsed.data.pastWorks.map((value) => value.trim()).filter(Boolean))];

  const updates: string[] = [];
  const values: Array<string | boolean | string[] | null> = [userId];

  if (description !== undefined) {
    updates.push(`description = $${values.length + 1}`);
    values.push(description);
  }

  if (city !== undefined) {
    updates.push(`city = $${values.length + 1}`);
    values.push(city);
  }

  if (pastWorks !== undefined) {
    updates.push(`past_works = $${values.length + 1}::text[]`);
    values.push(pastWorks);
  }

  if (bio !== undefined) {
    updates.push(`bio = $${values.length + 1}`);
    values.push(bio);
  }

  if (parsed.data.isOpenToWork !== undefined) {
    updates.push(`is_open_to_work = $${values.length + 1}`);
    values.push(parsed.data.isOpenToWork);
  }

  if (parsed.data.wantsToStartOrg !== undefined) {
    updates.push(`wants_to_start_org = $${values.length + 1}`);
    values.push(parsed.data.wantsToStartOrg);
  }

  if (parsed.data.wantsToHire !== undefined) {
    updates.push(`wants_to_hire = $${values.length + 1}`);
    values.push(parsed.data.wantsToHire);
  }

  if (updates.length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }

  updates.push("updated_at = NOW()");

  const result = await pool.query(
    `UPDATE volunteer
     SET ${updates.join(", ")}
     WHERE user_id = $1`,
    values,
  );

  if (result.rowCount === 0) {
    return c.json({ error: "Volunteer profile not found" }, 404);
  }

  const connectedUserIds = await getConnectedUserIds(userId);
  await invalidateSuggestionCache([userId, ...connectedUserIds]);

  return c.json({
    message: "Volunteer profile updated",
  });
});

volunteerRoutes.put("/volunteers/me/interests", async (c) => {
  const userId = getAuthenticatedUserId(c);
  const body = await c.req.json().catch(() => null);
  const parsed = interestsSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: "Invalid request payload",
        details: parsed.error.flatten(),
      },
      400,
    );
  }

  const slugs = normalizeInterests(parsed.data.interests);

  const profileExists = await pool.query(
    `SELECT user_id
     FROM volunteer
     WHERE user_id = $1
     LIMIT 1`,
    [userId],
  );

  if (profileExists.rowCount === 0) {
    return c.json({ error: "Volunteer profile not found" }, 404);
  }

  const tagResult = await pool.query<InterestTag>(
    `SELECT id, name, slug
     FROM tags
     WHERE slug = ANY($1::text[])
     ORDER BY name ASC`,
    [slugs],
  );

  const foundBySlug = new Set(tagResult.rows.map((row) => row.slug));
  const invalidSlugs = slugs.filter((slug) => !foundBySlug.has(slug));

  if (invalidSlugs.length > 0) {
    return c.json(
      {
        error: "Some interests do not exist in tags",
        invalidSlugs,
      },
      400,
    );
  }

  const tagIds = tagResult.rows.map((row) => row.id);

  await withTransaction(async (client) => {
    await client.query(
      `DELETE FROM volunteer_tags
       WHERE volunteer_id = $1`,
      [userId],
    );

    if (tagIds.length > 0) {
      await client.query(
        `INSERT INTO volunteer_tags (volunteer_id, tag_id)
         SELECT $1, UNNEST($2::uuid[])
         ON CONFLICT (volunteer_id, tag_id) DO NOTHING`,
        [userId, tagIds],
      );
    }
  });

  const connectedUserIds = await getConnectedUserIds(userId);
  await invalidateSuggestionCache([userId, ...connectedUserIds]);

  return c.json({
    message: "Interests updated",
    interests: slugs,
  });
});

volunteerRoutes.get("/volunteers/me/suggestions", async (c) => {
  const userId = getAuthenticatedUserId(c);

  const cached = await getCachedSuggestions(userId);
  if (cached) {
    return c.json({ source: "cache", suggestions: JSON.parse(cached) });
  }

  const suggestions = await buildVolunteerSuggestions(userId, 20);
  await setCachedSuggestions(
    userId,
    JSON.stringify(suggestions),
    env.SUGGESTION_CACHE_TTL_SECONDS,
  );

  return c.json({ source: "computed", suggestions });
});

volunteerRoutes.post("/volunteers/:targetUserId/view", async (c) => {
  const viewerId = getAuthenticatedUserId(c);
  const targetUserId = c.req.param("targetUserId");

  if (viewerId === targetUserId) {
    return c.json({ message: "Self-profile views are ignored" });
  }

  const targetExists = await pool.query(
    `SELECT user_id
     FROM volunteer
     WHERE user_id = $1
     LIMIT 1`,
    [targetUserId],
  );
  if (targetExists.rowCount === 0) {
    return c.json({ error: "Target volunteer not found" }, 404);
  }

  const viewCountRaw = await trackProfileView(
    viewerId,
    targetUserId,
    env.PROFILE_VIEW_TTL_SECONDS,
  );

  await invalidateSuggestionCache([viewerId]);

  return c.json({
    message: viewCountRaw === null ? "Profile view received (cache unavailable)" : "Profile view tracked",
    targetUserId,
    viewCount: viewCountRaw,
    cacheStatus: viewCountRaw === null ? "unavailable" : "ok",
  });
});

volunteerRoutes.post("/volunteers/:targetUserId/connect", async (c) => {
  const fromUserId = getAuthenticatedUserId(c);
  const targetUserId = c.req.param("targetUserId");

  if (fromUserId === targetUserId) {
    return c.json({ error: "You cannot connect with yourself" }, 400);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = connectSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return c.json(
      {
        error: "Invalid request payload",
        details: parsed.error.flatten(),
      },
      400,
    );
  }

  const requestResult = await withTransaction(async (client) => {
    const lockedUsers = await client.query<{ user_id: string }>(
      `SELECT user_id
       FROM volunteer
       WHERE user_id = ANY($1::text[])
       FOR UPDATE`,
      [[fromUserId, targetUserId]],
    );

    if (lockedUsers.rowCount !== 2) {
      return { kind: "missing" as const };
    }

    const [userLowId, userHighId] = canonicalPair(fromUserId, targetUserId);

    const alreadyConnectedResult = await client.query(
      `SELECT 1
       FROM volunteer_connection
       WHERE user_low_id = $1
         AND user_high_id = $2
       LIMIT 1`,
      [userLowId, userHighId],
    );

    if ((alreadyConnectedResult.rowCount ?? 0) > 0) {
      return { kind: "connected" as const };
    }

    const pendingAlreadyExistsResult = await client.query(
      `SELECT 1
       FROM volunteer_message
       WHERE status = 'pending'
         AND (
           (from_user_id = $1 AND to_user_id = $2)
           OR (from_user_id = $2 AND to_user_id = $1)
         )
       LIMIT 1`,
      [fromUserId, targetUserId],
    );

    if ((pendingAlreadyExistsResult.rowCount ?? 0) > 0) {
      return { kind: "pending" as const };
    }

    const inserted = await client.query<MessageRow>(
      `INSERT INTO volunteer_message (from_user_id, to_user_id, status, message)
       VALUES ($1, $2, 'pending', $3)
       RETURNING id, from_user_id, to_user_id, status, message, created_at, responded_at`,
      [fromUserId, targetUserId, parsed.data.message ?? null],
    );

    const insertedRow = inserted.rows[0];
    if (!insertedRow) {
      return { kind: "failed" as const };
    }

    return {
      kind: "ok" as const,
      request: toConnectionRequest(insertedRow),
    };
  });

  if (requestResult.kind === "missing") {
    return c.json({ error: "Volunteer profile not found" }, 404);
  }

  if (requestResult.kind === "connected") {
    return c.json({ error: "You are already connected" }, 409);
  }

  if (requestResult.kind === "pending") {
    return c.json({ error: "Connection request already pending" }, 409);
  }

  if (requestResult.kind === "failed") {
    return c.json({ error: "Unable to create request" }, 500);
  }

  await invalidateSuggestionCache([fromUserId, targetUserId]);

  return c.json({
    message: "Connection request sent",
    request: requestResult.request,
  });
});

volunteerRoutes.get("/volunteers/me/inbox", async (c) => {
  const userId = getAuthenticatedUserId(c);

  const profileResult = await pool.query(
    `SELECT user_id
     FROM volunteer
     WHERE user_id = $1
     LIMIT 1`,
    [userId],
  );

  if (profileResult.rowCount === 0) {
    return c.json({ error: "Volunteer profile not found" }, 404);
  }

  const result = await pool.query<MessageRow>(
    `SELECT id, from_user_id, to_user_id, status, message, created_at, responded_at
     FROM volunteer_message
     WHERE to_user_id = $1
     ORDER BY (status = 'pending') DESC, created_at DESC`,
    [userId],
  );

  const inbox = result.rows.map((row) => toConnectionRequest(row));

  return c.json({ inbox });
});

volunteerRoutes.post("/volunteers/me/inbox/:requestId/respond", async (c) => {
  const userId = getAuthenticatedUserId(c);
  const requestId = c.req.param("requestId");

  const body = await c.req.json().catch(() => null);
  const parsed = respondSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: "Invalid request payload",
        details: parsed.error.flatten(),
      },
      400,
    );
  }

  const nextStatus: RequestStatus = parsed.data.action === "accept" ? "accepted" : "rejected";

  const responseResult = await withTransaction(async (client) => {
    const meProfileResult = await client.query(
      `SELECT user_id
       FROM volunteer
       WHERE user_id = $1
       FOR UPDATE`,
      [userId],
    );

    if (meProfileResult.rowCount === 0) {
      return { kind: "missing-profile" as const };
    }

    const requestResult = await client.query<{
      from_user_id: string;
      status: RequestStatus;
    }>(
      `SELECT from_user_id, status
       FROM volunteer_message
       WHERE id = $2
         AND to_user_id = $1
       FOR UPDATE`,
      [userId, requestId],
    );

    if (requestResult.rowCount === 0) {
      return { kind: "request-not-found" as const };
    }

    const requestRow = requestResult.rows[0];
    if (!requestRow) {
      return { kind: "request-not-found" as const };
    }

    const senderId = requestRow.from_user_id;
    if (requestRow.status !== "pending") {
      return { kind: "already-processed" as const };
    }

    const senderProfileResult = await client.query(
      `SELECT user_id
       FROM volunteer
       WHERE user_id = $1
       FOR UPDATE`,
      [senderId],
    );

    if (senderProfileResult.rowCount === 0) {
      return { kind: "missing-sender" as const };
    }

    await client.query(
      `UPDATE volunteer_message
       SET status = $3,
           responded_at = NOW()
       WHERE id = $2
         AND to_user_id = $1`,
      [userId, requestId, nextStatus],
    );

    if (nextStatus === "accepted") {
      const [userLowId, userHighId] = canonicalPair(userId, senderId);

      await client.query(
        `INSERT INTO volunteer_connection (user_low_id, user_high_id)
         VALUES ($1, $2)
         ON CONFLICT (user_low_id, user_high_id) DO NOTHING`,
        [userLowId, userHighId],
      );
    }

    return {
      kind: "ok" as const,
      senderId,
    };
  });

  if (responseResult.kind === "missing-profile") {
    return c.json({ error: "Volunteer profile not found" }, 404);
  }

  if (responseResult.kind === "request-not-found") {
    return c.json({ error: "Connection request not found" }, 404);
  }

  if (responseResult.kind === "already-processed") {
    return c.json({ error: "Connection request already processed" }, 409);
  }

  if (responseResult.kind === "missing-sender") {
    return c.json({ error: "Sender volunteer profile not found" }, 404);
  }

  await invalidateSuggestionCache([userId, responseResult.senderId]);

  return c.json({
    message: `Request ${nextStatus}`,
    requestId,
    status: nextStatus,
  });
});

volunteerRoutes.get("/volunteers/me/connections", async (c) => {
  const userId = getAuthenticatedUserId(c);

  const profileResult = await pool.query(
    `SELECT user_id
     FROM volunteer
     WHERE user_id = $1
     LIMIT 1`,
    [userId],
  );

  if (profileResult.rowCount === 0) {
    return c.json({ error: "Volunteer profile not found" }, 404);
  }

  const connectionResult = await pool.query<{ connection_user_id: string }>(
    `SELECT CASE
              WHEN user_low_id = $1 THEN user_high_id
              ELSE user_low_id
            END AS connection_user_id
     FROM volunteer_connection
     WHERE user_low_id = $1
        OR user_high_id = $1`,
    [userId],
  );

  const connections = connectionResult.rows.map((row) => row.connection_user_id);
  if (connections.length === 0) {
    return c.json({ connections: [] });
  }

  const profileRows = await pool.query<{
    id: string;
    name: string;
    email: string;
    image: string | null;
  }>(
    `SELECT id, name, email, image
     FROM "user"
     WHERE id = ANY($1::text[])
     ORDER BY name ASC`,
    [connections],
  );

  return c.json({ connections: profileRows.rows });
});

volunteerRoutes.post("/volunteers/me/posts/engagement", async (c) => {
  const userId = getAuthenticatedUserId(c);
  const body = await c.req.json().catch(() => null);
  const parsed = engagementSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: "Invalid request payload",
        details: parsed.error.flatten(),
      },
      400,
    );
  }

  const { postId, action } = parsed.data;
  const topics = normalizeTopics(parsed.data.topics ?? []);

  const volunteerExists = await pool.query(
    `SELECT user_id
     FROM volunteer
     WHERE user_id = $1
     LIMIT 1`,
    [userId],
  );

  if (volunteerExists.rowCount === 0) {
    return c.json({ error: "Volunteer profile not found" }, 404);
  }

  await pool.query(
    `INSERT INTO volunteer_engagement (user_id, post_id, action, topics)
     VALUES ($1, $2, $3, $4::text[])`,
    [userId, postId, action, topics],
  );

  const connections = await getConnectedUserIds(userId);
  await invalidateSuggestionCache([userId, ...connections]);

  return c.json({
    message: "Engagement tracked",
    postId,
    action,
  });
});

volunteerRoutes.post("/volunteers/me/profile-image", async (c) => {
  const userId = getAuthenticatedUserId(c);
  const formData = await c.req.formData();
  const image = formData.get("image");

  if (!(image instanceof File)) {
    return c.json({ error: "Expected multipart form-data with image file" }, 400);
  }

  await ensureBucket();
  const uploaded = await uploadProfileImage(userId, image);

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE "user"
       SET image = $2,
           updated_at = NOW()
       WHERE id = $1`,
      [userId, uploaded.objectUrl],
    );
  });

  await invalidateSuggestionCache([userId]);

  return c.json({
    message: "Profile image uploaded",
    imageUrl: uploaded.objectUrl,
  });
});
