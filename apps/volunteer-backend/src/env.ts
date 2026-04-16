import "dotenv/config";
import { z } from "zod";

const rawEnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3090),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  CORS_ORIGIN: z.string().min(1).default("*"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  MINIO_ENDPOINT: z.string().min(1).default("localhost"),
  MINIO_PORT: z.coerce.number().int().positive().default(9000),
  MINIO_USE_SSL: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  MINIO_ACCESS_KEY: z.string().min(1).default("minioadmin"),
  MINIO_SECRET_KEY: z.string().min(1).default("minioadmin"),
  MINIO_BUCKET: z.string().min(1).default("volunteer-profiles"),
  SUGGESTION_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(120),
  PROFILE_VIEW_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 30),
});

export const env = rawEnvSchema.parse(process.env);
