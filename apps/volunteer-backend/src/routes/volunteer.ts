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
  asObject,
  asStringArray,
  dedupeStrings,
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
  PostInteractionMap,
  RequestStatus,
  TopicScoreMap,
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
        respondedAt: obj.respondedAt,
        message: obj.message,
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

  const connections = asStringArray(existing.rows[0].connections);

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

  const [senderResult, targetResult] = await Promise.all([
    pool.query<{ connections: string[] | null; sent_requests: ConnectionRequest[] | null }>(
      "SELECT connections, sent_requests FROM volunteer WHERE user_id = $1 LIMIT 1",
      [fromUserId],
    ),
    pool.query<{ inbox_requests: ConnectionRequest[] | null }>(
      "SELECT inbox_requests FROM volunteer WHERE user_id = $1 LIMIT 1",
      [targetUserId],
    ),
  ]);

  if (senderResult.rowCount === 0 || targetResult.rowCount === 0) {
    return c.json({ error: "Volunteer profile not found" }, 404);
  }

  const senderConnections = asStringArray(senderResult.rows[0].connections);
  if (senderConnections.includes(targetUserId)) {
    return c.json({ error: "You are already connected" }, 409);
  }

  const senderSentRequests = asConnectionRequestArray(senderResult.rows[0].sent_requests);
  const pendingAlreadyExists = senderSentRequests.some(
    (request) => request.toUserId === targetUserId && request.status === "pending",
  );

  if (pendingAlreadyExists) {
    return c.json({ error: "Connection request already pending" }, 409);
  }

  const targetInboxRequests = asConnectionRequestArray(targetResult.rows[0].inbox_requests);

  const request: ConnectionRequest = {
    requestId: crypto.randomUUID(),
    fromUserId,
    toUserId: targetUserId,
    status: "pending",
    createdAt: toIsoNow(),
    message: parsed.data.message,
  };

  const nextSenderSent = [...senderSentRequests, request];
  const nextTargetInbox = [...targetInboxRequests, request];

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE volunteer
       SET sent_requests = $2::jsonb,
           updated_at = NOW()
       WHERE user_id = $1`,
      [fromUserId, JSON.stringify(nextSenderSent)],
    );

    await client.query(
      `UPDATE volunteer
       SET inbox_requests = $2::jsonb,
           updated_at = NOW()
       WHERE user_id = $1`,
      [targetUserId, JSON.stringify(nextTargetInbox)],
    );
  });

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

  const inbox = asConnectionRequestArray(result.rows[0].inbox_requests).sort((left, right) => {
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

  const meResult = await pool.query<{
    inbox_requests: ConnectionRequest[] | null;
    connections: string[] | null;
  }>(
    "SELECT inbox_requests, connections FROM volunteer WHERE user_id = $1 LIMIT 1",
    [userId],
  );

  if (meResult.rowCount === 0) {
    return c.json({ error: "Volunteer profile not found" }, 404);
  }

  const meInbox = asConnectionRequestArray(meResult.rows[0].inbox_requests);
  const targetRequest = meInbox.find((item) => item.requestId === requestId && item.toUserId === userId);

  if (!targetRequest) {
    return c.json({ error: "Connection request not found" }, 404);
  }

  if (targetRequest.status !== "pending") {
    return c.json({ error: "Connection request already processed" }, 409);
  }

  const senderId = targetRequest.fromUserId;

  const senderResult = await pool.query<{
    sent_requests: ConnectionRequest[] | null;
    connections: string[] | null;
  }>(
    "SELECT sent_requests, connections FROM volunteer WHERE user_id = $1 LIMIT 1",
    [senderId],
  );

  if (senderResult.rowCount === 0) {
    return c.json({ error: "Sender volunteer profile not found" }, 404);
  }

  const nextStatus: RequestStatus = parsed.data.action === "accept" ? "accepted" : "rejected";
  const respondedAt = toIsoNow();

  const nextInbox = meInbox.map((request) =>
    request.requestId === requestId
      ? {
          ...request,
          status: nextStatus,
          respondedAt,
        }
      : request,
  );

  const senderSent = asConnectionRequestArray(senderResult.rows[0].sent_requests);
  const nextSenderSent = senderSent.map((request) =>
    request.requestId === requestId
      ? {
          ...request,
          status: nextStatus,
          respondedAt,
        }
      : request,
  );

  const myConnections = asStringArray(meResult.rows[0].connections);
  const senderConnections = asStringArray(senderResult.rows[0].connections);

  let nextMyConnections = myConnections;
  let nextSenderConnections = senderConnections;

  if (nextStatus === "accepted") {
    nextMyConnections = dedupeStrings([...myConnections, senderId]);
    nextSenderConnections = dedupeStrings([...senderConnections, userId]);
  }

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE volunteer
       SET inbox_requests = $2::jsonb,
           connections = $3::jsonb,
           updated_at = NOW()
       WHERE user_id = $1`,
      [userId, JSON.stringify(nextInbox), JSON.stringify(nextMyConnections)],
    );

    await client.query(
      `UPDATE volunteer
       SET sent_requests = $2::jsonb,
           connections = $3::jsonb,
           updated_at = NOW()
       WHERE user_id = $1`,
      [senderId, JSON.stringify(nextSenderSent), JSON.stringify(nextSenderConnections)],
    );
  });

  await invalidateSuggestionCache([userId, senderId]);

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

  const connections = asStringArray(result.rows[0].connections);
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

  const result = await pool.query<{
    post_engagement: PostInteractionMap | null;
    topic_engagement: TopicScoreMap | null;
    connections: string[] | null;
  }>(
    `SELECT post_engagement, topic_engagement, connections
     FROM volunteer
     WHERE user_id = $1
     LIMIT 1`,
    [userId],
  );

  if (result.rowCount === 0) {
    return c.json({ error: "Volunteer profile not found" }, 404);
  }

  const row = result.rows[0];
  const postMap = asObject<PostInteractionMap>(row.post_engagement, {});
  const topicMap = asObject<TopicScoreMap>(row.topic_engagement, {});

  const current = postMap[postId] ?? {
    likes: 0,
    saves: 0,
    opens: 0,
    topics: [] as string[],
  };

  const nextPost = {
    ...current,
    topics: dedupeStrings([...current.topics, ...topics]),
  };

  if (action === "like") {
    nextPost.likes += 1;
  }
  if (action === "save") {
    nextPost.saves += 1;
  }
  if (action === "open") {
    nextPost.opens += 1;
    nextPost.lastOpenedAt = toIsoNow();
  }

  postMap[postId] = nextPost;

  const actionWeight: Record<PostAction, number> = {
    like: 3,
    save: 2,
    open: 1,
  };

  for (const topic of topics) {
    topicMap[topic] = (topicMap[topic] ?? 0) + actionWeight[action];
  }

  await pool.query(
    `UPDATE volunteer
     SET post_engagement = $2::jsonb,
         topic_engagement = $3::jsonb,
         updated_at = NOW()
     WHERE user_id = $1`,
    [userId, JSON.stringify(postMap), JSON.stringify(topicMap)],
  );

  const connections = asStringArray(row.connections);
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
