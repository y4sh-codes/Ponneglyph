import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { uploadFile, getPresignedUrl } from "../lib/s3";
import { publishUploadMessage } from "../lib/queue";

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

const upload = new Hono();

// File type → mime type mapping matching the DB file_type enum
const MIME_TO_FILE_TYPE: Record<string, string> = {
  "application/pdf": "pdf",
  "text/csv": "csv",
  "application/json": "json",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
};

function resolveFileType(mime: string): string {
  return MIME_TO_FILE_TYPE[mime] ?? "other";
}

/**
 * POST /api/upload
 * Accepts multipart/form-data with:
 *   - title        (required)
 *   - description  (required)
 *   - summary      (optional)
 *   - publisher    (optional)
 *   - tags         (optional, comma-separated)
 *   - files        (one or more attachments)
 *   - thumbnail    (optional, image file)
 *
 * Uploads files to R2 in parallel, enqueues processing job, returns upload_id.
 */
upload.post("/", async (c) => {
  // Better-auth session check
  const session = c.get("user" as never) as { id: string } | undefined;
  const userId = session?.id ?? "anonymous";

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json({ error: "Expected multipart/form-data" }, 400);
  }

  const title = formData.get("title");
  const description = formData.get("description");
  if (!title || !description) {
    return c.json({ error: "title and description are required" }, 400);
  }

  const summary = formData.get("summary")?.toString() ?? undefined;
  const publisher = formData.get("publisher")?.toString() ?? undefined;
  const tagsRaw = formData.get("tags")?.toString() ?? "";
  const tags = tagsRaw
    ? tagsRaw
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : [];

  // Collect all uploaded files
  const fileEntries = formData.getAll("files") as File[];
  if (fileEntries.length === 0) {
    return c.json({ error: "At least one file is required" }, 400);
  }

  // TODO: When switching to presigned URLs (Zero Wait approach), I will remove this guard.
  // Currently using arrayBuffer() which holds entire file in memory - size guard
  // prevents OOM. With presigned URLs, client uploads directly to R2.
  //
  // Issue: https://github.com/Itz-Agasta/Poneglyph/issues/8
  for (const file of fileEntries) {
    if (file.size > MAX_FILE_SIZE) {
      return c.json(
        {
          error: `File ${file.name} is too large. Max limit is ${MAX_FILE_SIZE / 1024 / 1024}MB.`,
        },
        413,
      );
    }
  }

  const uploadId = crypto.randomUUID();

  // Parallel upload all attachments to R2
  const attachmentPromises = fileEntries.map(async (file) => {
    const ext = file.name.split(".").pop() ?? "bin";
    const key = `uploads/${uploadId}/${crypto.randomUUID()}.${ext}`;
    // TODO: Replace with presigned URLs - client uploads directly to R2 (Zero Wait)
    const buffer = await file.arrayBuffer();

    await uploadFile(key, buffer, file.type || "application/octet-stream");
    const presignedUrl = await getPresignedUrl(key);

    return {
      s3_key: key,
      presigned_url: presignedUrl,
      mime_type: file.type || "application/octet-stream",
      file_type: resolveFileType(file.type),
    };
  });

  // Upload thumbnail in parallel with attachments
  const thumbnailFile = formData.get("thumbnail") as File | null;

  if (thumbnailFile && thumbnailFile.size > MAX_FILE_SIZE) {
    return c.json(
      {
        error: `Thumbnail ${thumbnailFile.name} is too large. Max limit is ${MAX_FILE_SIZE / 1024 / 1024}MB.`,
      },
      413,
    );
  }

  const thumbnailPromise = thumbnailFile
    ? (async () => {
        const thumbExt = thumbnailFile.name.split(".").pop() ?? "bin";
        const thumbKey = `uploads/${uploadId}/thumbnail.${thumbExt}`;
        // TODO: Replace with presigned URLs - client uploads directly to R2 (Zero Wait)
        const thumbBuffer = await thumbnailFile.arrayBuffer();
        await uploadFile(thumbKey, thumbBuffer, thumbnailFile.type || "image/*");
        return thumbKey;
      })()
    : Promise.resolve(undefined);

  const [attachments, thumbnailS3Key] = await Promise.all([
    Promise.all(attachmentPromises),
    thumbnailPromise,
  ]);

  // Publish to RabbitMQ — worker handles everything from here
  await publishUploadMessage({
    upload_id: uploadId,
    user_id: userId,
    title: title.toString(),
    description: description.toString(),
    summary,
    publisher,
    tags,
    attachments,
    thumbnail_s3_key: thumbnailS3Key,
    callback_url: `${c.req.url.split("/api/")[0]}/api/upload/callback`,
  });

  return c.json({ upload_id: uploadId, status: "queued" }, 202);
});

const callbackSchema = z.object({
  upload_id: z.string().uuid(),
  dataset_id: z.string().uuid(),
  status: z.enum(["completed", "failed"]),
  error: z.string().optional(),
});

/**
 * POST /api/upload/callback
 * Called by the Rust worker when processing is done.
 * Extend this to push WebSocket/SSE events to the frontend.
 */
upload.post("/callback", zValidator("json", callbackSchema), async (c) => {
  const body = c.req.valid("json");

  if (body.status === "completed") {
    console.log(
      `[upload] completed: upload_id=${body.upload_id} dataset_id=${body.dataset_id}`,
    );
  } else {
    console.error(
      `[upload] failed: upload_id=${body.upload_id} error=${body.error}`,
    );
  }

  // TODO: push real-time notification to frontend (WebSocket/SSE)
  return c.json({ ok: true });
});

export default upload;
