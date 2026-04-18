import amqplib from "amqplib";
import { env } from "@Poneglyph/env/server";

export interface AttachmentInfo {
  s3_key: string;
  presigned_url: string;
  mime_type: string;
  file_type: string;
}

export interface UploadMessage {
  upload_id: string;
  user_id: string;
  title: string;
  description: string;
  summary?: string;
  publisher?: string;
  tags: string[];
  attachments: AttachmentInfo[];
  thumbnail_s3_key?: string;
  callback_url: string;
  _retry?: number;
}

const FAILED_QUEUE_SUFFIX = "-failed";

/**
 * Get the dead letter queue name for a given queue.
 */
function getFailedQueueName(queueName: string): string {
  return `${queueName}${FAILED_QUEUE_SUFFIX}`;
}

/**
 * Publish an upload message to the RabbitMQ queue.
 * Opens a connection, publishes, then closes — keeps server stateless.
 *
 * Messages include _retry count starting at 0 for retry tracking.
 */
export async function publishUploadMessage(msg: UploadMessage): Promise<void> {
  const conn = await amqplib.connect(env.RABBITMQ_URL);
  try {
    const channel = await conn.createChannel();

    const queueName = env.RABBITMQ_QUEUE;
    const failedQueueName = getFailedQueueName(queueName);

    // Assert both main queue and dead letter queue (durable)
    await channel.assertQueue(queueName, { durable: true });
    await channel.assertQueue(failedQueueName, { durable: true });

    // Add retry count if not present (should be 0 for new messages)
    const messageWithRetry: UploadMessage = {
      ...msg,
      _retry: msg._retry ?? 0,
    };

    channel.sendToQueue(queueName, Buffer.from(JSON.stringify(messageWithRetry)), {
      persistent: true,
      contentType: "application/json",
    });
    await channel.close();
  } finally {
    await conn.close();
  }
}

/**
 * Republish a message to the failed queue (after max retries exceeded).
 */
export async function publishToFailedQueue(msg: UploadMessage): Promise<void> {
  const conn = await amqplib.connect(env.RABBITMQ_URL);
  try {
    const channel = await conn.createChannel();

    const failedQueueName = getFailedQueueName(env.RABBITMQ_QUEUE);

    // Ensure failed queue exists
    await channel.assertQueue(failedQueueName, { durable: true });

    channel.sendToQueue(failedQueueName, Buffer.from(JSON.stringify(msg)), {
      persistent: true,
      contentType: "application/json",
    });
    await channel.close();
  } finally {
    await conn.close();
  }
}
