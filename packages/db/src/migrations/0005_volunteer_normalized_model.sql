CREATE EXTENSION IF NOT EXISTS pgcrypto;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "volunteer" (
  "user_id" text PRIMARY KEY NOT NULL,
  "description" text,
  "city" varchar(100),
  "past_works" text[] NOT NULL DEFAULT '{}'::text[],
  "bio" text,
  "is_open_to_work" boolean NOT NULL DEFAULT false,
  "wants_to_start_org" boolean NOT NULL DEFAULT false,
  "wants_to_hire" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "volunteer_user_id_user_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE "volunteer" ADD COLUMN IF NOT EXISTS "description" text;--> statement-breakpoint
ALTER TABLE "volunteer" ADD COLUMN IF NOT EXISTS "city" varchar(100);--> statement-breakpoint
ALTER TABLE "volunteer" ADD COLUMN IF NOT EXISTS "past_works" text[] DEFAULT '{}'::text[];--> statement-breakpoint
UPDATE "volunteer" SET "past_works" = '{}'::text[] WHERE "past_works" IS NULL;--> statement-breakpoint
ALTER TABLE "volunteer" ALTER COLUMN "past_works" SET DEFAULT '{}'::text[];--> statement-breakpoint
ALTER TABLE "volunteer" ALTER COLUMN "past_works" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "volunteer" ADD COLUMN IF NOT EXISTS "bio" text;--> statement-breakpoint
ALTER TABLE "volunteer" ADD COLUMN IF NOT EXISTS "is_open_to_work" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "volunteer" ADD COLUMN IF NOT EXISTS "wants_to_start_org" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "volunteer" ADD COLUMN IF NOT EXISTS "wants_to_hire" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "volunteer" ADD COLUMN IF NOT EXISTS "created_at" timestamptz NOT NULL DEFAULT now();--> statement-breakpoint
ALTER TABLE "volunteer" ADD COLUMN IF NOT EXISTS "updated_at" timestamptz NOT NULL DEFAULT now();--> statement-breakpoint

DROP INDEX IF EXISTS "volunteer_interests_gin_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "volunteer_connections_gin_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_volunteer_interests";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_volunteer_connections";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_volunteer_inbox_requests";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_volunteer_sent_requests";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_volunteer_post_engagement";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_volunteer_topic_engagement";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_volunteer_pending_inbox";--> statement-breakpoint

ALTER TABLE "volunteer" DROP COLUMN IF EXISTS "interests";--> statement-breakpoint
ALTER TABLE "volunteer" DROP COLUMN IF EXISTS "connections";--> statement-breakpoint
ALTER TABLE "volunteer" DROP COLUMN IF EXISTS "inbox_requests";--> statement-breakpoint
ALTER TABLE "volunteer" DROP COLUMN IF EXISTS "sent_requests";--> statement-breakpoint
ALTER TABLE "volunteer" DROP COLUMN IF EXISTS "post_engagement";--> statement-breakpoint
ALTER TABLE "volunteer" DROP COLUMN IF EXISTS "topic_engagement";--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "idx_volunteer_user_id" ON "volunteer" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_volunteer_city" ON "volunteer" USING btree ("city");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "volunteer_message" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "from_user_id" text NOT NULL,
  "to_user_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "message" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "responded_at" timestamptz,
  CONSTRAINT "volunteer_message_from_user_id_user_id_fk"
    FOREIGN KEY ("from_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "volunteer_message_to_user_id_user_id_fk"
    FOREIGN KEY ("to_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "volunteer_message_status_check"
    CHECK ("status" IN ('pending', 'accepted', 'rejected')),
  CONSTRAINT "volunteer_message_no_self_check"
    CHECK ("from_user_id" <> "to_user_id"),
  CONSTRAINT "volunteer_message_message_length_check"
    CHECK ("message" IS NULL OR char_length("message") <= 280)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_volunteer_message_to_user_id" ON "volunteer_message" USING btree ("to_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_volunteer_message_from_user_id" ON "volunteer_message" USING btree ("from_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_volunteer_message_status" ON "volunteer_message" USING btree ("status");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "volunteer_connection" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_low_id" text NOT NULL,
  "user_high_id" text NOT NULL,
  "connected_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "volunteer_connection_user_low_id_user_id_fk"
    FOREIGN KEY ("user_low_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "volunteer_connection_user_high_id_user_id_fk"
    FOREIGN KEY ("user_high_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "volunteer_connection_user_pair_unique"
    UNIQUE ("user_low_id", "user_high_id"),
  CONSTRAINT "volunteer_connection_user_order_check"
    CHECK ("user_low_id" < "user_high_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_volunteer_connection_user_low_id" ON "volunteer_connection" USING btree ("user_low_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_volunteer_connection_user_high_id" ON "volunteer_connection" USING btree ("user_high_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "volunteer_engagement" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "post_id" text NOT NULL,
  "action" text NOT NULL,
  "topics" text[] NOT NULL DEFAULT '{}'::text[],
  "engaged_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "volunteer_engagement_user_id_user_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "volunteer_engagement_action_check"
    CHECK ("action" IN ('like', 'save', 'open'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_volunteer_engagement_user_id" ON "volunteer_engagement" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_volunteer_engagement_post_id" ON "volunteer_engagement" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_volunteer_engagement_topics_gin" ON "volunteer_engagement" USING gin ("topics");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "volunteer_tags" (
  "volunteer_id" text NOT NULL,
  "tag_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "volunteer_tags_pk" PRIMARY KEY ("volunteer_id", "tag_id"),
  CONSTRAINT "volunteer_tags_volunteer_id_volunteer_user_id_fk"
    FOREIGN KEY ("volunteer_id") REFERENCES "public"."volunteer"("user_id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "volunteer_tags_tag_id_tags_id_fk"
    FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_volunteer_tags_tag_id" ON "volunteer_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_volunteer_tags_volunteer_id" ON "volunteer_tags" USING btree ("volunteer_id");