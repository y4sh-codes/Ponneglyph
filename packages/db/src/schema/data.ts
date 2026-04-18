import { relations, sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  boolean,
  index,
  uniqueIndex,
  integer,
  varchar,
  uuid,
  pgEnum,
  vector,
  check,
  primaryKey,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

export const sourceTypeEnum = pgEnum("source_type", ["upload", "external_url", "api"]);

export const datasetStatusEnum = pgEnum("dataset_status", [
  "pending",
  "approved",
  "rejected",
  "archived",
]);

export const fileTypeEnum = pgEnum("file_type", [
  "pdf",
  "csv",
  "xlsx",
  "xls",
  "json",
  "docx",
  "other",
]);

export const sources = pgTable("sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").references(() => user.id, {
    onDelete: "cascade",
  }), // Only for user-uploads
  name: varchar("name", { length: 50 }).notNull(),
  url: text("url"), // Only for extranl sources
  sourceType: sourceTypeEnum("source_type").notNull().default("upload"),
  isVerified: boolean("is_verified").default(false).notNull(),
});

export const tags = pgTable("tags", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 100 }).notNull().unique(),
  slug: varchar("slug", { length: 100 }).notNull().unique(),
});

export const volunteer = pgTable(
  "volunteer",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    description: text("description"),
    city: varchar("city", { length: 100 }),
    pastWorks: text("past_works").array().notNull().default([]),
    bio: text("bio"),
    isOpenToWork: boolean("is_open_to_work").default(false).notNull(),
    wantsToStartOrg: boolean("wants_to_start_org").default(false).notNull(),
    wantsToHire: boolean("wants_to_hire").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("idx_volunteer_user_id").on(table.userId),
    index("idx_volunteer_city").on(table.city),
  ],
);

export const volunteerMessage = pgTable(
  "volunteer_message",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fromUserId: text("from_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    toUserId: text("to_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    message: text("message"),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_volunteer_message_to_user_id").on(table.toUserId),
    index("idx_volunteer_message_from_user_id").on(table.fromUserId),
    index("idx_volunteer_message_status").on(table.status),
    check(
      "volunteer_message_status_check",
      sql`${table.status} IN ('pending', 'accepted', 'rejected')`,
    ),
    check(
      "volunteer_message_no_self_check",
      sql`${table.fromUserId} <> ${table.toUserId}`,
    ),
    check(
      "volunteer_message_length_check",
      sql`${table.message} IS NULL OR char_length(${table.message}) <= 280`,
    ),
  ],
);

export const volunteerConnection = pgTable(
  "volunteer_connection",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userLowId: text("user_low_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    userHighId: text("user_high_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    connectedAt: timestamp("connected_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("volunteer_connection_user_pair_unique").on(table.userLowId, table.userHighId),
    index("idx_volunteer_connection_user_low_id").on(table.userLowId),
    index("idx_volunteer_connection_user_high_id").on(table.userHighId),
    check(
      "volunteer_connection_user_order_check",
      sql`${table.userLowId} < ${table.userHighId}`,
    ),
  ],
);

export const volunteerEngagement = pgTable(
  "volunteer_engagement",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    postId: text("post_id").notNull(),
    action: text("action").notNull(),
    topics: text("topics").array().notNull().default([]),
    engagedAt: timestamp("engaged_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_volunteer_engagement_user_id").on(table.userId),
    index("idx_volunteer_engagement_post_id").on(table.postId),
    index("idx_volunteer_engagement_topics_gin").using("gin", table.topics),
    check(
      "volunteer_engagement_action_check",
      sql`${table.action} IN ('like', 'save', 'open')`,
    ),
  ],
);

export const volunteerTags = pgTable(
  "volunteer_tags",
  {
    volunteerId: text("volunteer_id")
      .notNull()
      .references(() => volunteer.userId, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_volunteer_tags_tag_id").on(table.tagId),
    index("idx_volunteer_tags_volunteer_id").on(table.volunteerId),
    primaryKey({
      name: "volunteer_tags_pk",
      columns: [table.volunteerId, table.tagId],
    }),
  ],
);

// Core pointer record table
export const datasets = pgTable(
  "datasets",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    externalId: text("external_id").unique(), // CKAN/source package ID for dedup

    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),

    title: varchar("title", { length: 500 }).notNull(),
    description: text("description"), // for thumbnail card
    thumbnailS3Key: text("thumbnail_s3_key"),
    summary: text("summary"),

    publicationDate: timestamp("publication_date"),
    publisher: varchar("publisher", { length: 255 }),

    language: varchar("language", { length: 10 }).default("en").notNull(),

    s3Keys: text("s3_keys").array(), // Attchments
    fileTypes: fileTypeEnum("file_types").array(),
    sourceUrl: text("source_url"), // On demand fetch

    embedding: vector("embedding", { dimensions: 768 }),

    status: datasetStatusEnum("dataset_status").default("pending").notNull(),

    viewCount: integer("view_count").default(0).notNull(),
    downloadCount: integer("download_count").default(0).notNull(),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("datasets_source_id_idx").on(table.sourceId),
    index("datasets_embedding_idx").using("hnsw", table.embedding.op("vector_cosine_ops")),
  ],
);

// junction table for filtering
export const datasetTags = pgTable(
  "dataset_tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    datasetId: uuid("dataset_id")
      .notNull()
      .references(() => datasets.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("dataset_tags_dataset_id_idx").on(table.datasetId),
    index("dataset_tags_tag_id_idx").on(table.tagId), // for fast filtering
    uniqueIndex("dataset_tags_dataset_id_tag_id_unique").on(table.datasetId, table.tagId),
  ],
);

export const syncStatusEnum = pgEnum("sync_status", ["running", "completed", "failed"]);

export const syncLogs = pgTable("sync_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceId: uuid("source_id")
    .notNull()
    .references(() => sources.id, { onDelete: "cascade" }),
  syncStatus: syncStatusEnum("sync_status").default("running").notNull(),
  totalFound: integer("total_found").default(0).notNull(),
  added: integer("added").default(0).notNull(),
  updated: integer("updated").default(0).notNull(),
  archived: integer("archived").default(0).notNull(),
  errorCount: integer("error_count").default(0).notNull(),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
  error: text("error"),
});

export const sourcesRelations = relations(sources, ({ one, many }) => ({
  user: one(user, {
    fields: [sources.userId],
    references: [user.id],
  }),
  datasets: many(datasets),
}));

export const tagsRelations = relations(tags, ({ many }) => ({
  datasetTags: many(datasetTags),
  volunteerTags: many(volunteerTags),
}));

export const datasetsRelations = relations(datasets, ({ one, many }) => ({
  source: one(sources, {
    fields: [datasets.sourceId],
    references: [sources.id],
  }),
  datasetTags: many(datasetTags),
}));

export const datasetTagsRelations = relations(datasetTags, ({ one }) => ({
  dataset: one(datasets, {
    fields: [datasetTags.datasetId],
    references: [datasets.id],
  }),
  tag: one(tags, {
    fields: [datasetTags.tagId],
    references: [tags.id],
  }),
}));

export const volunteerRelations = relations(volunteer, ({ one, many }) => ({
  user: one(user, {
    fields: [volunteer.userId],
    references: [user.id],
  }),
  tags: many(volunteerTags),
}));

export const volunteerTagsRelations = relations(volunteerTags, ({ one }) => ({
  volunteer: one(volunteer, {
    fields: [volunteerTags.volunteerId],
    references: [volunteer.userId],
  }),
  tag: one(tags, {
    fields: [volunteerTags.tagId],
    references: [tags.id],
  }),
}));
