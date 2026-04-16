# Volunteer Matching Backend (Hono + Bun + PostgreSQL + Redis + MinIO)

This backend is added as a **new isolated app** under `apps/volunteer-backend` and does not modify any existing code.

It implements the requested feature set for:

- volunteer opt-in activation for existing users
- interest onboarding (minimum 3)
- smart volunteer suggestion and discovery
- connect request and inbox accept/reject
- post behavior based suggestions (likes/saves/opens)
- Redis tracking of repeatedly viewed profiles
- profile image upload to MinIO and URL persistence in user profile

## Tech Stack Usage

- **Bun**: package manager + runtime (`bun install`, `bun run ...`)
- **Hono**: API server and route handling
- **PostgreSQL**: source of truth for users and volunteer state
- **Redis**: profile view frequency tracking + suggestion cache
- **MinIO (S3 compatible)**: profile image object storage

## Data Model (Minimal Table Strategy)

As requested, this implementation keeps volunteer data in **one table only** and references existing `user.id`.

Table: `volunteer`

- `user_id` (PK, FK -> `user.id`)
- `interests` (`jsonb` array)
- `connections` (`jsonb` array)
- `inbox_requests` (`jsonb`)
- `sent_requests` (`jsonb`)
- `post_engagement` (`jsonb`)
- `topic_engagement` (`jsonb`)
- `created_at`, `updated_at`

This keeps query paths simple while supporting all required features.

## Why this design maps to your feature request

1. App-level signup/login first, then volunteer opt-in:
- users sign up / login through existing main auth (`/api/auth/*`)
- when a logged-in user chooses volunteer role, `POST /api/volunteer/volunteers/me/activate` creates the volunteer row using `user_id` FK

2. Next page interest selection (50-60 params):
- `GET /api/metadata/interests` returns catalog (60 items)
- `PUT /api/volunteers/me/interests` enforces minimum 3

3. Interest persistence:
- interests are stored in `volunteer.interests` (`jsonb` array)

4. Suggestions of similar people + connect request:
- `GET /api/volunteers/me/suggestions` ranks candidates using:
  - shared interests (primary)
  - similar topic/post behavior
  - repeated profile views from Redis
  - mutual connections
- `POST /api/volunteers/:targetUserId/connect` creates request in inbox

5. Accept request -> become connections:
- `POST /api/volunteers/me/inbox/:requestId/respond` with `accept` or `reject`
- on accept, both sides are inserted into `connections`

6. Track likes/saves/opens and suggest users with similar behavior:
- `POST /api/volunteers/me/posts/engagement`
- updates `post_engagement` and `topic_engagement` json maps
- matcher uses these fields in scoring

7. Redis stores repeatedly viewed profile data:
- sorted set key: `volunteer:profile-views:<viewerId>`
- metadata hash key: `volunteer:profile-view-meta:<viewerId>`
- `POST /api/volunteers/:targetUserId/view`

8. Profile image upload:
- `POST /api/volunteers/me/profile-image` (multipart file)
- uploaded to MinIO bucket
- URL is saved to `user.image`

## LinkedIn / Tinder style ideas included in this backend

- **LinkedIn-like ranking signals**:
  - mutual connections boost
  - common interests overlap
  - shared content engagement similarity

- **Tinder-like discovery tuning**:
  - profile revisit frequency boost from Redis (people you repeatedly inspect bubble up)

## API Endpoints

When integrated into the main backend (`apps/server`), volunteer routes are mounted under `/api/volunteer`.

Auth model:

- use existing app auth at `/api/auth/*` (Better Auth)
- volunteer routes validate existing app session token/cookie
- no separate volunteer signup/login API is required

Examples in integrated mode:

- `POST /api/auth/sign-up/email`
- `POST /api/auth/sign-in/email`
- `POST /api/volunteer/volunteers/me/activate`
- `GET /api/volunteer/metadata/interests`
- `GET /api/volunteer/volunteers/me`

Public:

- `GET /api/volunteer/metadata/interests`
- `GET /health`

Protected (existing app session cookie or `Authorization: Bearer <session-token>`):

- `POST /api/volunteer/volunteers/me/activate`
- `GET /api/volunteer/volunteers/me`
- `PUT /api/volunteer/volunteers/me/interests`
- `GET /api/volunteer/volunteers/me/suggestions`
- `POST /api/volunteer/volunteers/:targetUserId/view`
- `POST /api/volunteer/volunteers/:targetUserId/connect`
- `GET /api/volunteer/volunteers/me/inbox`
- `POST /api/volunteer/volunteers/me/inbox/:requestId/respond`
- `GET /api/volunteer/volunteers/me/connections`
- `POST /api/volunteer/volunteers/me/posts/engagement`
- `POST /api/volunteer/volunteers/me/profile-image`

## Setup

1. Install dependencies from repo root:

```bash
bun install
```

2. Create env file:

```bash
cp apps/volunteer-backend/.env.example apps/volunteer-backend/.env
```

3. Ensure services are running:

- PostgreSQL
- Redis
- MinIO

4. Ensure base auth schema already exists in the same database:

- The volunteer table uses a foreign key to `public.user`.
- If `public.user` does not exist yet, run the main repository database migrations first for the same `DATABASE_URL`.

5. Run migration bootstrap (creates/updates `volunteer` table):

```bash
bun run --cwd apps/volunteer-backend migrate
```

6. Start the main backend (integrated mode):

```bash
bun run dev:server
```

Optional: run volunteer backend standalone for isolated testing:

```bash
bun run --cwd apps/volunteer-backend dev
```

Default port is `3090`.

## Environment Variables

See `.env.example` in this app for all fields.

Important values:

- `DATABASE_URL`
- `REDIS_URL`
- `MINIO_*`
- `MINIO_BUCKET`

## Notes

- This backend intentionally avoids changing existing project files.
- It integrates with existing auth tables (`user`, `account`) by inserting new volunteer users there.
