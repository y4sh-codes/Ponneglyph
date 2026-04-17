import { getProfileViewScores } from "../cache";
import { asObject, asStringArray, pool } from "../db";
import type { PostInteractionMap, TopicScoreMap } from "../types";

type CandidateRow = {
  id: string;
  name: string;
  image: string | null;
  interests: string[] | null;
  connections: string[] | null;
  topic_engagement: TopicScoreMap | null;
  post_engagement: PostInteractionMap | null;
  common_interests: string[] | null;
  mutual_connections: number;
  interests_score: number;
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

function rankCandidate(input: {
  selfTopicMap: TopicScoreMap;
  selfPostMap: PostInteractionMap;
  candidate: CandidateRow;
  profileViewBoost: number;
}): Suggestion {
  const commonInterests = asStringArray(input.candidate.common_interests);
  const mutualConnections = Number(input.candidate.mutual_connections ?? 0);
  const interestsScore = Number(input.candidate.interests_score ?? 0);
  const candidateTopicMap = asObject<TopicScoreMap>(input.candidate.topic_engagement, {});
  const candidatePostMap = asObject<PostInteractionMap>(input.candidate.post_engagement, {});

  const topicScore = cosineFromMaps(input.selfTopicMap, candidateTopicMap);
  const behaviorScore = interactionSimilarity(input.selfPostMap, candidatePostMap);
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
  const selfResult = await pool.query<{
    topic_engagement: TopicScoreMap | null;
    post_engagement: PostInteractionMap | null;
  }>(
    `SELECT topic_engagement, post_engagement
     FROM volunteer
     WHERE user_id = $1`,
    [userId],
  );

  if (selfResult.rowCount === 0) {
    return [];
  }

  const self = selfResult.rows[0];
  if (!self) {
    return [];
  }

  const candidatesResult = await pool.query<CandidateRow>(
    `WITH self AS (
       SELECT
         COALESCE(
           ARRAY(
             SELECT jsonb_array_elements_text(COALESCE(interests, '[]'::jsonb))
           ),
           ARRAY[]::text[]
         ) AS self_interest_values,
         COALESCE(
           ARRAY(
             SELECT jsonb_array_elements_text(COALESCE(connections, '[]'::jsonb))
           ),
           ARRAY[]::text[]
         ) AS self_connection_values
       FROM volunteer
       WHERE user_id = $1
     )
     SELECT
       u.id,
       u.name,
       u.image,
       v.interests,
       v.connections,
       v.topic_engagement,
       v.post_engagement,
       common.common_interests,
       mutual.mutual_connections,
       CASE
         WHEN unioned.union_size = 0 THEN 0
         ELSE common.common_count::double precision / unioned.union_size::double precision
       END AS interests_score
     FROM volunteer v
     INNER JOIN "user" u ON u.id = v.user_id
     CROSS JOIN self
     CROSS JOIN LATERAL (
       SELECT
         COALESCE(jsonb_agg(interest_value), '[]'::jsonb) AS common_interests,
         COUNT(*)::int AS common_count
       FROM unnest(self.self_interest_values) AS interest_value
       WHERE v.interests ? interest_value
     ) AS common
     CROSS JOIN LATERAL (
       SELECT COUNT(*)::int AS mutual_connections
       FROM unnest(self.self_connection_values) AS connection_id
       WHERE v.connections ? connection_id
     ) AS mutual
     CROSS JOIN LATERAL (
       SELECT COUNT(DISTINCT value)::int AS union_size
       FROM (
         SELECT unnest(self.self_interest_values) AS value
         UNION ALL
         SELECT jsonb_array_elements_text(COALESCE(v.interests, '[]'::jsonb)) AS value
       ) AS all_values
     ) AS unioned
     WHERE v.user_id <> $1
       AND (
         cardinality(self.self_interest_values) = 0
         OR v.interests ?| self.self_interest_values
       )
     ORDER BY interests_score DESC, mutual.mutual_connections DESC
     LIMIT 250`,
    [userId],
  );

  const profileViewBoosts = await getProfileViewBoosts(userId);

  const selfTopicMap = asObject<TopicScoreMap>(self.topic_engagement, {});
  const selfPostMap = asObject<PostInteractionMap>(self.post_engagement, {});

  const ranked = candidatesResult.rows.map((candidate) =>
    rankCandidate({
      selfTopicMap,
      selfPostMap,
      candidate,
      profileViewBoost: profileViewBoosts.get(candidate.id) ?? 0,
    }),
  );

  return ranked
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}
