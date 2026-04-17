import { Hono } from "hono";
import { z } from "zod";
import {
  getCachedSuggestions,
  invalidateSuggestionCache,
  setCachedSuggestions,
  trackProfileView,
} from "../cache";
import { INTEREST_CATALOG } from "../constants/interests";
import {
  asStringArray,
  pool,
  withTransaction,
} from "../db";
import { env } from "../env";
import { buildVolunteerSuggestions } from "../services/matchmaking";
import { getAuthenticatedUserId, requireAuthenticatedUser } from "../session-auth";
import { ensureBucket, uploadProfileImage } from "../storage";
import type {
  AppBindings,
  ConnectionRequest,
  PostAction,
  RequestStatus,
} from "../types";
import {
  normalizeInterests,
  normalizeTopics,
  toIsoNow,
  validateInterests,
} from "../utils";

const interestsSchema = z.object({
  interests: z.array(z.string().min(2)).min(3),
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

function asConnectionRequestArray(input: unknown): ConnectionRequest[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        return null;
      }

      const obj = item as Partial<ConnectionRequest>;
      if (
        typeof obj.requestId !== "string" ||
        typeof obj.fromUserId !== "string" ||
        typeof obj.toUserId !== "string" ||
        typeof obj.status !== "string" ||
        typeof obj.createdAt !== "string"
      ) {
        return null;
      }

      const status = obj.status as RequestStatus;
      if (!["pending", "accepted", "rejected"].includes(status)) {
        return null;
      }

      return {
        requestId: obj.requestId,
        fromUserId: obj.fromUserId,
        toUserId: obj.toUserId,
        status,
        createdAt: obj.createdAt,
        ...(typeof obj.respondedAt === "string" ? { respondedAt: obj.respondedAt } : {}),
        ...(typeof obj.message === "string" ? { message: obj.message } : {}),
      } satisfies ConnectionRequest;
    })
    .filter((item): item is ConnectionRequest => item !== null);
}

export const volunteerRoutes = new Hono<AppBindings>();

volunteerRoutes.get("/metadata/interests", (c) => {
  return c.json({
    count: INTEREST_CATALOG.length,
    interests: INTEREST_CATALOG,
  });
});

volunteerRoutes.use("/volunteers/*", requireAuthenticatedUser);

volunteerRoutes.post("/volunteers/me/activate", async (c) => {
  const userId = getAuthenticatedUserId(c);

  const result = await pool.query(
    `INSERT INTO volunteer (user_id)
     VALUES ($1)
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
    interests: string[] | null;
    connections: string[] | null;
  }>(
    `SELECT u.id, u.name, u.email, u.image, v.interests, v.connections
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
    interests: asStringArray(row.interests),
    connectionsCount: asStringArray(row.connections).length,
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

  const interests = normalizeInterests(parsed.data.interests);
  const validation = validateInterests(interests);
  if (!validation.valid) {
    return c.json(
      {
        error: "Some interests are not in the allowed catalog",
        invalidInterests: validation.invalid,
      },
      400,
    );
  }

  const existing = await pool.query<{ connections: string[] | null }>(
    "SELECT connections FROM volunteer WHERE user_id = $1 LIMIT 1",
    [userId],
  );

  if (existing.rowCount === 0) {
    return c.json({ error: "Volunteer profile not found" }, 404);
  }

  const existingRow = existing.rows[0];
  if (!existingRow) {
    return c.json({ error: "Volunteer profile not found" }, 404);
  }

  const connections = asStringArray(existingRow.connections);

  await pool.query(
    `UPDATE volunteer
     SET interests = $2::jsonb,
         updated_at = NOW()
     WHERE user_id = $1`,
    [userId, JSON.stringify(interests)],
  );

  await invalidateSuggestionCache([userId, ...connections]);

  return c.json({
    message: "Interests updated",
    interests,
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

  const targetExists = await pool.query("SELECT user_id FROM volunteer WHERE user_id = $1 LIMIT 1", [
    targetUserId,
  ]);
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

  const request: ConnectionRequest = {
    requestId: crypto.randomUUID(),
    fromUserId,
    toUserId: targetUserId,
    status: "pending",
    createdAt: toIsoNow(),
    message: parsed.data.message,
  };

  const mutationResult = await withTransaction(async (client) => {
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

    const alreadyConnectedResult = await client.query(
      `SELECT 1
       FROM volunteer
       WHERE user_id = $1
         AND connections @> $2::jsonb
       LIMIT 1`,
      [fromUserId, JSON.stringify([targetUserId])],
    );

    if ((alreadyConnectedResult.rowCount ?? 0) > 0) {
      return { kind: "connected" as const };
    }

    const pendingAlreadyExistsResult = await client.query(
      `SELECT 1
       FROM volunteer v
       WHERE v.user_id = $1
         AND EXISTS (
           SELECT 1
           FROM jsonb_array_elements(v.sent_requests) AS req
           WHERE req->>'toUserId' = $2
             AND req->>'status' = 'pending'
         )
       LIMIT 1`,
      [fromUserId, targetUserId],
    );

    if ((pendingAlreadyExistsResult.rowCount ?? 0) > 0) {
      return { kind: "pending" as const };
    }

    await client.query(
      `UPDATE volunteer
       SET sent_requests = sent_requests || jsonb_build_array($2::jsonb),
           updated_at = NOW()
       WHERE user_id = $1`,
      [fromUserId, JSON.stringify(request)],
    );

    await client.query(
      `UPDATE volunteer
       SET inbox_requests = inbox_requests || jsonb_build_array($2::jsonb),
           updated_at = NOW()
       WHERE user_id = $1`,
      [targetUserId, JSON.stringify(request)],
    );

    return { kind: "ok" as const };
  });

  if (mutationResult.kind === "missing") {
    return c.json({ error: "Volunteer profile not found" }, 404);
  }

  if (mutationResult.kind === "connected") {
    return c.json({ error: "You are already connected" }, 409);
  }

  if (mutationResult.kind === "pending") {
    return c.json({ error: "Connection request already pending" }, 409);
  }

  await invalidateSuggestionCache([fromUserId, targetUserId]);

  return c.json({
    message: "Connection request sent",
    request,
  });
});

volunteerRoutes.get("/volunteers/me/inbox", async (c) => {
  const userId = getAuthenticatedUserId(c);
  const result = await pool.query<{ inbox_requests: ConnectionRequest[] | null }>(
    "SELECT inbox_requests FROM volunteer WHERE user_id = $1 LIMIT 1",
    [userId],
  );

  if (result.rowCount === 0) {
    return c.json({ error: "Volunteer profile not found" }, 404);
  }

  const inboxRow = result.rows[0];
  if (!inboxRow) {
    return c.json({ error: "Volunteer profile not found" }, 404);
  }

  const inbox = asConnectionRequestArray(inboxRow.inbox_requests).sort((left, right) => {
    if (left.status !== right.status) {
      if (left.status === "pending") {
        return -1;
      }
      if (right.status === "pending") {
        return 1;
      }
    }

    return right.createdAt.localeCompare(left.createdAt);
  });

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
  const respondedAt = toIsoNow();

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
      `SELECT req->>'fromUserId' AS from_user_id,
              req->>'status' AS status
       FROM volunteer v
       CROSS JOIN LATERAL jsonb_array_elements(v.inbox_requests) AS req
       WHERE v.user_id = $1
         AND req->>'requestId' = $2
         AND req->>'toUserId' = $1
       LIMIT 1`,
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
      `UPDATE volunteer v
       SET inbox_requests = updates.updated_inbox,
           connections = CASE
             WHEN $3::boolean AND NOT (v.connections @> $4::jsonb)
               THEN v.connections || $4::jsonb
             ELSE v.connections
           END,
           updated_at = NOW()
       FROM (
         SELECT owner.user_id,
                COALESCE(
                  jsonb_agg(
                    CASE
                      WHEN req->>'requestId' = $2 THEN
                        jsonb_set(
                          jsonb_set(req, '{status}', to_jsonb($5::text), false),
                          '{respondedAt}',
                          to_jsonb($6::text),
                          true
                        )
                      ELSE req
                    END
                  ),
                  '[]'::jsonb
                ) AS updated_inbox
         FROM volunteer owner
         CROSS JOIN LATERAL jsonb_array_elements(owner.inbox_requests) AS req
         WHERE owner.user_id = $1
         GROUP BY owner.user_id
       ) AS updates
       WHERE v.user_id = updates.user_id`,
      [
        userId,
        requestId,
        nextStatus === "accepted",
        JSON.stringify([senderId]),
        nextStatus,
        respondedAt,
      ],
    );

    await client.query(
      `UPDATE volunteer v
       SET sent_requests = updates.updated_sent,
           connections = CASE
             WHEN $3::boolean AND NOT (v.connections @> $4::jsonb)
               THEN v.connections || $4::jsonb
             ELSE v.connections
           END,
           updated_at = NOW()
       FROM (
         SELECT owner.user_id,
                COALESCE(
                  jsonb_agg(
                    CASE
                      WHEN req->>'requestId' = $2 THEN
                        jsonb_set(
                          jsonb_set(req, '{status}', to_jsonb($5::text), false),
                          '{respondedAt}',
                          to_jsonb($6::text),
                          true
                        )
                      ELSE req
                    END
                  ),
                  '[]'::jsonb
                ) AS updated_sent
         FROM volunteer owner
         CROSS JOIN LATERAL jsonb_array_elements(owner.sent_requests) AS req
         WHERE owner.user_id = $1
         GROUP BY owner.user_id
       ) AS updates
       WHERE v.user_id = updates.user_id`,
      [
        senderId,
        requestId,
        nextStatus === "accepted",
        JSON.stringify([userId]),
        nextStatus,
        respondedAt,
      ],
    );

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
  const result = await pool.query<{ connections: string[] | null }>(
    "SELECT connections FROM volunteer WHERE user_id = $1 LIMIT 1",
    [userId],
  );

  if (result.rowCount === 0) {
    return c.json({ error: "Volunteer profile not found" }, 404);
  }

  const connectionsRow = result.rows[0];
  if (!connectionsRow) {
    return c.json({ error: "Volunteer profile not found" }, 404);
  }

  const connections = asStringArray(connectionsRow.connections);
  if (connections.length === 0) {
    return c.json({ connections: [] });
  }

  const profileResult = await pool.query<{
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

  return c.json({ connections: profileResult.rows });
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
  const actionWeight: Record<PostAction, number> = {
    like: 3,
    save: 2,
    open: 1,
  };
  const openedAt = action === "open" ? toIsoNow() : null;

  const result = await pool.query<{ connections: string[] | null }>(
    `WITH RECURSIVE
       selected AS (
         SELECT user_id, post_engagement, topic_engagement, connections
         FROM volunteer
         WHERE user_id = $1
         FOR UPDATE
       ),
       post_updated AS (
         SELECT
           s.user_id,
           s.connections,
           s.topic_engagement,
           jsonb_set(
             s.post_engagement,
             ARRAY[$2::text],
             jsonb_strip_nulls(
               jsonb_build_object(
                 'likes', COALESCE((s.post_engagement -> $2 ->> 'likes')::int, 0) + CASE WHEN $3 = 'like' THEN 1 ELSE 0 END,
                 'saves', COALESCE((s.post_engagement -> $2 ->> 'saves')::int, 0) + CASE WHEN $3 = 'save' THEN 1 ELSE 0 END,
                 'opens', COALESCE((s.post_engagement -> $2 ->> 'opens')::int, 0) + CASE WHEN $3 = 'open' THEN 1 ELSE 0 END,
                 'topics', COALESCE(
                   (
                     SELECT jsonb_agg(topic_value)
                     FROM (
                       SELECT DISTINCT topic_value
                       FROM (
                         SELECT jsonb_array_elements_text(COALESCE(s.post_engagement -> $2 -> 'topics', '[]'::jsonb)) AS topic_value
                         UNION ALL
                         SELECT unnest($4::text[]) AS topic_value
                       ) AS topic_union
                     ) AS deduped_topics
                   ),
                   '[]'::jsonb
                 ),
                 'lastOpenedAt',
                 CASE
                   WHEN $3 = 'open' THEN to_jsonb($5::text)
                   ELSE s.post_engagement -> $2 -> 'lastOpenedAt'
                 END
               )
             ),
             true
           ) AS post_engagement
         FROM selected s
       ),
       topic_updated AS (
         SELECT
           p.user_id,
           p.connections,
           p.post_engagement,
           p.topic_engagement AS topic_map,
           1 AS idx
         FROM post_updated p

         UNION ALL

         SELECT
           t.user_id,
           t.connections,
           t.post_engagement,
           jsonb_set(
             t.topic_map,
             ARRAY[$4[t.idx]::text],
             to_jsonb(COALESCE((t.topic_map ->> $4[t.idx])::int, 0) + $6::int),
             true
           ) AS topic_map,
           t.idx + 1 AS idx
         FROM topic_updated t
         WHERE t.idx <= COALESCE(array_length($4::text[], 1), 0)
       ),
       final_state AS (
         SELECT
           user_id,
           connections,
           post_engagement,
           topic_map AS topic_engagement
         FROM topic_updated
         ORDER BY idx DESC
         LIMIT 1
       )
     UPDATE volunteer v
     SET post_engagement = f.post_engagement,
         topic_engagement = f.topic_engagement,
         updated_at = NOW()
     FROM final_state f
     WHERE v.user_id = f.user_id
     RETURNING v.connections`,
    [userId, postId, action, topics, openedAt, actionWeight[action]],
  );

  if (result.rowCount === 0) {
    return c.json({ error: "Volunteer profile not found" }, 404);
  }

  const engagementRow = result.rows[0];
  if (!engagementRow) {
    return c.json({ error: "Volunteer profile not found" }, 404);
  }

  const connections = asStringArray(engagementRow.connections);
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
