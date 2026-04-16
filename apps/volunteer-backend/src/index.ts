import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { env } from "./env";
import { volunteerRoutes } from "./routes/volunteer";
import type { AppBindings } from "./types";

const app = new Hono<AppBindings>();

app.use(logger());
app.use(
  "/*",
  cors({
    origin: env.CORS_ORIGIN,
    allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: false,
  }),
);

app.route("/api", volunteerRoutes);

app.get("/", (c) => {
  return c.text("Volunteer matching backend is running");
});

app.get("/health", (c) =>
  c.json({
    status: "healthy",
    service: "volunteer-backend",
    timestamp: new Date().toISOString(),
  }),
);

app.onError((error, c) => {
  if (error instanceof HTTPException) {
    return c.json({ error: error.message }, error.status);
  }

  console.error(error);
  return c.json({ error: "Internal server error" }, 500);
});

export default app;
