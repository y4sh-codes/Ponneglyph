import { Client } from "minio";
import { env } from "./env";

export const minioClient = new Client({
  endPoint: env.MINIO_ENDPOINT,
  port: env.MINIO_PORT,
  useSSL: env.MINIO_USE_SSL,
  accessKey: env.MINIO_ACCESS_KEY,
  secretKey: env.MINIO_SECRET_KEY,
});

export async function ensureBucket(): Promise<void> {
  const exists = await minioClient.bucketExists(env.MINIO_BUCKET);
  if (!exists) {
    await minioClient.makeBucket(env.MINIO_BUCKET);
  }
}

export async function uploadProfileImage(userId: string, file: File): Promise<{ key: string; objectUrl: string; buffer: Buffer }> {
  const extension = file.name.includes(".") ? file.name.split(".").pop() : "bin";
  const key = `profiles/${userId}/${crypto.randomUUID()}.${extension}`;
  const fileBuffer = Buffer.from(await file.arrayBuffer());

  await minioClient.putObject(env.MINIO_BUCKET, key, fileBuffer, fileBuffer.byteLength, {
    "Content-Type": file.type || "application/octet-stream",
  });

  const objectUrl = `s3://${env.MINIO_BUCKET}/${key}`;
  return { key, objectUrl, buffer: fileBuffer };
}
