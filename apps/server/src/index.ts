import { auth } from "@Poneglyph/auth";
import { env } from "@Poneglyph/env/server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { volunteerRoutes } from "../../volunteer-backend/src/routes/volunteer";
import type { AppBindings as VolunteerBindings } from "../../volunteer-backend/src/types";
import upload from "./routes/upload";

const app = new Hono<VolunteerBindings>();

app.use(logger());
app.use(
  "/*",
  cors({
    origin: env.CORS_ORIGIN,
    allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
);

app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.route("/api/volunteer", volunteerRoutes);
app.route("/api/upload", upload);

app.get("/", (c) => {
  c.header("Content-Type", "text/plain");
  return c.text("OK from Agasta");
});

app.get("/health", (c) =>
  c.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    version: "1.0.0",
  }),
);

export default app;
