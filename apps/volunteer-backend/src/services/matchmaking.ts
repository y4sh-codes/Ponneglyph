import { getProfileViewScores } from "../cache";
import { pool } from "../db";
import type { PostAction, PostInteraction, PostInteractionMap, TopicScoreMap } from "../types";

type CandidateRow = {
  id: string;
  name: string;
  image: string | null;
  common_interests: string[] | null;
  mutual_connections: number;
  interests_score: number;
};

type EngagementRow = {
  user_id: string;
  post_id: string;
  action: PostAction;
  topics: string[] | null;
  engaged_at: string | Date;
};

type Suggestion = {
  userId: string;
  name: string;
  image: string | null;
  score: number;
  commonInterests: string[];
  mutualConnections: number;
  reasons: string[];
};

function cosineFromMaps(a: TopicScoreMap, b: TopicScoreMap): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  if (keys.size === 0) {
    return 0;
  }

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (const key of keys) {
    const aValue = a[key] ?? 0;
    const bValue = b[key] ?? 0;
    dot += aValue * bValue;
    magA += aValue * aValue;
    magB += bValue * bValue;
  }

  if (magA === 0 || magB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function interactionSimilarity(a: PostInteractionMap, b: PostInteractionMap): number {
  const postIdsA = Object.keys(a);
  const postIdsB = new Set(Object.keys(b));
  if (postIdsA.length === 0 || postIdsB.size === 0) {
    return 0;
  }

  let overlapScore = 0;

  for (const postId of postIdsA) {
    if (!postIdsB.has(postId)) {
      continue;
    }

    const left = a[postId];
    const right = b[postId];
    if (!left || !right) {
      continue;
    }

    overlapScore += Math.min(left.likes, right.likes) * 3;
    overlapScore += Math.min(left.saves, right.saves) * 2;
    overlapScore += Math.min(left.opens, right.opens);
  }

  const maxPossible = Math.max(postIdsA.length, postIdsB.size) * 10;
  return maxPossible === 0 ? 0 : Math.min(overlapScore / maxPossible, 1);
}

async function getProfileViewBoosts(userId: string): Promise<Map<string, number>> {
  const result = await getProfileViewScores(userId);
  const boosts = new Map<string, number>();

  for (let i = 0; i < result.length; i += 2) {
    const candidateId = result[i];
    const score = Number(result[i + 1]);
    if (typeof candidateId === "string" && !Number.isNaN(score)) {
      boosts.set(candidateId, Math.min(score / 10, 1));
    }
  }

  return boosts;
}

function toIsoString(value: string | Date): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return new Date(value).toISOString();
}

function getOrCreatePostInteraction(map: PostInteractionMap, postId: string): PostInteraction {
  const existing = map[postId];
  if (existing) {
    return existing;
  }

  const created: PostInteraction = {
    likes: 0,
    saves: 0,
    opens: 0,
    topics: [],
  };
  map[postId] = created;
  return created;
}

function buildEngagementFeatures(rows: EngagementRow[]): Map<string, {
  topicMap: TopicScoreMap;
  postMap: PostInteractionMap;
}> {
  const actionWeight: Record<PostAction, number> = {
    like: 3,
    save: 2,
    open: 1,
  };

  const features = new Map<string, {
    topicMap: TopicScoreMap;
    postMap: PostInteractionMap;
  }>();

  for (const row of rows) {
    const existing = features.get(row.user_id) ?? {
      topicMap: {},
      postMap: {},
    };

    const postInteraction = getOrCreatePostInteraction(existing.postMap, row.post_id);
    if (row.action === "like") {
      postInteraction.likes += 1;
    }
    if (row.action === "save") {
      postInteraction.saves += 1;
    }
    if (row.action === "open") {
      postInteraction.opens += 1;
      postInteraction.lastOpenedAt = toIsoString(row.engaged_at);
    }

    const topicSet = new Set(postInteraction.topics);
    const topics = row.topics ?? [];
    for (const topic of topics) {
      topicSet.add(topic);
      existing.topicMap[topic] = (existing.topicMap[topic] ?? 0) + actionWeight[row.action];
    }
    postInteraction.topics = [...topicSet];

    features.set(row.user_id, existing);
  }

  return features;
}

function rankCandidate(input: {
  selfTopicMap: TopicScoreMap;
  selfPostMap: PostInteractionMap;
  candidateTopicMap: TopicScoreMap;
  candidatePostMap: PostInteractionMap;
  candidate: CandidateRow;
  profileViewBoost: number;
}): Suggestion {
  const commonInterests = input.candidate.common_interests ?? [];
  const mutualConnections = Number(input.candidate.mutual_connections ?? 0);
  const interestsScore = Number(input.candidate.interests_score ?? 0);

  const topicScore = cosineFromMaps(input.selfTopicMap, input.candidateTopicMap);
  const behaviorScore = interactionSimilarity(input.selfPostMap, input.candidatePostMap);
  const mutualScore = Math.min(mutualConnections / 8, 1);

  const score =
    interestsScore * 0.45 +
    topicScore * 0.3 +
    behaviorScore * 0.15 +
    input.profileViewBoost * 0.07 +
    mutualScore * 0.03;

  const reasons: string[] = [];
  if (commonInterests.length > 0) {
    reasons.push(`Shares ${commonInterests.length} interest(s)`);
  }
  if (behaviorScore > 0.25) {
    reasons.push("Engages with similar posts");
  }
  if (input.profileViewBoost > 0) {
    reasons.push("Frequently viewed profile");
  }
  if (mutualConnections > 0) {
    reasons.push(`${mutualConnections} mutual connection(s)`);
  }

  return {
    userId: input.candidate.id,
    name: input.candidate.name,
    image: input.candidate.image,
    score: Number(score.toFixed(6)),
    commonInterests,
    mutualConnections,
    reasons,
  };
}

export async function buildVolunteerSuggestions(userId: string, limit = 20): Promise<Suggestion[]> {
  const selfResult = await pool.query(
    `SELECT user_id
     FROM volunteer
     WHERE user_id = $1
     LIMIT 1`,
    [userId],
  );

  if (selfResult.rowCount === 0) {
    return [];
  }

  const candidatesResult = await pool.query<CandidateRow>(
    `WITH self_interests AS (
       SELECT COALESCE(array_agg(DISTINCT vt.tag_id), ARRAY[]::uuid[]) AS self_tag_ids
       FROM volunteer_tags vt
       WHERE vt.volunteer_id = $1
     ),
     self_connections AS (
       SELECT COALESCE(
         array_agg(
           DISTINCT CASE
             WHEN vc.user_low_id = $1 THEN vc.user_high_id
             ELSE vc.user_low_id
           END
         ),
         ARRAY[]::text[]
       ) AS self_connection_values
       FROM volunteer_connection vc
       WHERE vc.user_low_id = $1
          OR vc.user_high_id = $1
     )
     SELECT
       u.id,
       u.name,
       u.image,
       common.common_interests,
       mutual.mutual_connections,
       CASE
         WHEN unioned.union_size = 0 THEN 0
         ELSE common.common_count::double precision / unioned.union_size::double precision
       END AS interests_score
     FROM volunteer v
     INNER JOIN "user" u ON u.id = v.user_id
     CROSS JOIN self_interests si
     CROSS JOIN self_connections sc
     CROSS JOIN LATERAL (
       SELECT
         COALESCE(
           array_agg(DISTINCT t.slug) FILTER (WHERE vt.tag_id = ANY(si.self_tag_ids)),
           ARRAY[]::text[]
         ) AS common_interests,
         COUNT(DISTINCT vt.tag_id) FILTER (WHERE vt.tag_id = ANY(si.self_tag_ids))::int AS common_count,
         COUNT(DISTINCT vt.tag_id)::int AS candidate_count
       FROM volunteer_tags vt
       INNER JOIN tags t ON t.id = vt.tag_id
       WHERE vt.volunteer_id = v.user_id
     ) AS common
     CROSS JOIN LATERAL (
       SELECT COUNT(*)::int AS mutual_connections
       FROM volunteer_connection vc
       WHERE (
         vc.user_low_id = v.user_id
         AND vc.user_high_id = ANY(sc.self_connection_values)
       )
       OR (
         vc.user_high_id = v.user_id
         AND vc.user_low_id = ANY(sc.self_connection_values)
       )
     ) AS mutual
     CROSS JOIN LATERAL (
       SELECT (cardinality(si.self_tag_ids) + common.candidate_count - common.common_count)::int AS union_size
     ) AS unioned
     WHERE v.user_id <> $1
       AND (
         cardinality(si.self_tag_ids) = 0
         OR common.common_count > 0
       )
     ORDER BY interests_score DESC, mutual.mutual_connections DESC
     LIMIT 250`,
    [userId],
  );

  if (candidatesResult.rows.length === 0) {
    return [];
  }

  const candidateIds = candidatesResult.rows.map((row) => row.id);
  const engagementResult = await pool.query<EngagementRow>(
    `SELECT user_id, post_id, action, topics, engaged_at
     FROM volunteer_engagement
     WHERE user_id = ANY($1::text[])
     ORDER BY engaged_at DESC`,
    [[userId, ...candidateIds]],
  );

  const features = buildEngagementFeatures(engagementResult.rows);
  const selfFeatures = features.get(userId) ?? {
    topicMap: {},
    postMap: {},
  };

  const profileViewBoosts = await getProfileViewBoosts(userId);

  const ranked = candidatesResult.rows.map((candidate) => {
    const candidateFeatures = features.get(candidate.id) ?? {
      topicMap: {},
      postMap: {},
    };

    return rankCandidate({
      selfTopicMap: selfFeatures.topicMap,
      selfPostMap: selfFeatures.postMap,
      candidateTopicMap: candidateFeatures.topicMap,
      candidatePostMap: candidateFeatures.postMap,
      candidate,
      profileViewBoost: profileViewBoosts.get(candidate.id) ?? 0,
    });
  });

  return ranked
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}
