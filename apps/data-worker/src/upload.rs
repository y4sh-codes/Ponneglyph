use anyhow::{Context, Result};
use bytes::Bytes;
use calamine::{open_workbook_from_rs, Reader, Xlsx};
use lapin::{
    options::{BasicAckOptions, BasicConsumeOptions, BasicNackOptions, BasicPublishOptions, BasicQosOptions, QueueDeclareOptions},
    types::FieldTable,
    Connection, ConnectionProperties,
};

use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::io::Cursor;
use uuid::Uuid;

use crate::{config, db, embed};

// Message types 
#[derive(Debug, Deserialize, Serialize)]
pub struct UploadMessage {
    pub upload_id: String,
    pub user_id: String,
    pub title: String,
    pub description: String,
    pub summary: Option<String>,
    pub publisher: Option<String>,
    pub tags: Vec<String>,
    pub attachments: Vec<AttachmentInfo>,
    pub thumbnail_s3_key: Option<String>,
    pub callback_url: String,
    #[serde(default)]
    pub _retry: u32,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct AttachmentInfo {
    pub s3_key: String,
    pub presigned_url: String,
    pub mime_type: String,
    pub file_type: String,
}

#[derive(Debug, Serialize)]
struct CallbackPayload {
    upload_id: String,
    dataset_id: Option<String>,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

// Consumer entry point 

/// Long-running RabbitMQ consumer.
/// Activated when `RABBITMQ_CONSUMER=true` is set.
pub async fn run_consumer(pool: PgPool) -> Result<()> {
    let cfg = &*config::CONFIG;

    tracing::info!("Connecting to RabbitMQ...");
    let conn = Connection::connect(&cfg.rabbitmq_url, ConnectionProperties::default())
        .await
        .context("Failed to connect to RabbitMQ")?;

    let channel = conn.create_channel().await.context("Failed to create channel")?;

    // Limit in-flight messages so we don't OOM on large files
    channel
        .basic_qos(cfg.rabbitmq_prefetch, BasicQosOptions::default())
        .await
        .context("Failed to set QoS")?;

    channel
        .queue_declare(
            &cfg.rabbitmq_queue,
            QueueDeclareOptions { durable: true, ..Default::default() },
            FieldTable::default(),
        )
        .await
        .context("Failed to declare main queue")?;

    channel
        .queue_declare(
            &cfg.rabbitmq_failed_queue,
            QueueDeclareOptions { durable: true, ..Default::default() },
            FieldTable::default(),
        )
        .await
        .context("Failed to declare failed queue")?;

    let mut consumer = channel
        .basic_consume(
            &cfg.rabbitmq_queue,
            "upload-consumer",
            BasicConsumeOptions::default(),
            FieldTable::default(),
        )
        .await
        .context("Failed to start consumer")?;

    tracing::info!(
        "Listening on queue '{}' (failed queue: '{}')",
        cfg.rabbitmq_queue,
        cfg.rabbitmq_failed_queue
    );

    use futures::StreamExt;
    while let Some(delivery) = consumer.next().await {
        let delivery = match delivery {
            Ok(d) => d,
            Err(e) => {
                tracing::error!("Delivery error: {}", e);
                continue;
            }
        };

        let data_bytes = delivery.data.clone();
        
        let msg: UploadMessage = match serde_json::from_slice(&data_bytes) {
            Ok(m) => m,
            Err(e) => {
                tracing::error!("Failed to parse upload message: {}", e);
                // Bad message — discard (nack, no requeue)
                let _ = delivery.nack(BasicNackOptions { requeue: false, ..Default::default() }).await;
                continue;
            }
        };

        let retry_count = msg._retry;
        
        tracing::info!(
            "Processing upload_id={} (retry={})",
            msg.upload_id,
            retry_count
        );

        match process_upload(&pool, msg).await {
            Ok(_) => {
                let _ = delivery.ack(BasicAckOptions::default()).await;
            }
            Err(e) => {
                tracing::error!(
                    "Upload processing failed: {:?} (retry={})",
                    e,
                    retry_count
                );

                // Republish with incremented retry count
                let mut retry_msg: UploadMessage = serde_json::from_slice(&data_bytes).unwrap();
                retry_msg._retry = retry_count + 1;
                let payload = serde_json::to_vec(&retry_msg).unwrap_or_default();

                if retry_count < 2 {
                    tracing::warn!(
                        "Retrying upload_id={} (attempt {}/2)",
                        retry_msg.upload_id,
                        retry_count + 1
                    );
                    let _ = channel
                        .basic_publish(
                            "",
                            &cfg.rabbitmq_queue,
                            BasicPublishOptions::default(),
                            &payload,
                            lapin::BasicProperties::default()
                                .with_content_type("application/json".into())
                                .with_delivery_mode(2),
                        )
                        .await;
                } else {
                    tracing::error!(
                        "Max retries exceeded for upload_id={}, sending to failed queue",
                        retry_msg.upload_id
                    );
                    // TODO: Add logging for failed job (e.g., database entry, external service, etc.)
                    let _ = channel
                        .basic_publish(
                            "",
                            &cfg.rabbitmq_failed_queue,
                            BasicPublishOptions::default(),
                            &payload,
                            lapin::BasicProperties::default()
                                .with_content_type("application/json".into())
                                .with_delivery_mode(2),
                        )
                        .await;
                }

                let _ = delivery.ack(BasicAckOptions::default()).await;
            }
        }
    }

    Ok(())
}

// Core processing

async fn process_upload(pool: &PgPool, msg: UploadMessage) -> Result<()> {
    let cfg = &*config::CONFIG;

    // 1. Create source record
    let user_id: Option<&str> = if msg.user_id == "anonymous" || msg.user_id.is_empty() {
        None
    } else {
        Some(msg.user_id.as_str())
    };
    let source_id = db::insert_source_for_upload(pool, user_id, &msg.title)
        .await
        .context("Failed to insert source")?;

    // 2. Create dataset record (status='pending')
    let s3_keys: Vec<String> = msg.attachments.iter().map(|a| a.s3_key.clone()).collect();
    let file_types: Vec<String> = msg.attachments.iter().map(|a| a.file_type.clone()).collect();

    let dataset_id = db::insert_upload_dataset(
        pool,
        source_id,
        &msg.title,
        &msg.description,
        msg.summary.as_deref(),
        msg.publisher.as_deref(),
        &s3_keys,
        &file_types,
        msg.thumbnail_s3_key.as_deref(),
    )
    .await
    .context("Failed to insert dataset")?;

    // 3. Embed title + description + summary as primary text
    let text = build_text_for_embedding(&msg);
    let text_vec = embed::embed_text(&text, &cfg.gemini_api_key)
        .await
        .context("Failed to embed text")?;

    // 4. Embed each attachment (strategy depends on file type)
    let mut all_vectors: Vec<Vec<f32>> = vec![text_vec];

    for attachment in &msg.attachments {
        match embed_attachment(attachment, &cfg.gemini_api_key).await {
            Ok(Some(vec)) => all_vectors.push(vec),
            Ok(None) => {
                tracing::info!(
                    "Skipped embedding for {} (unsupported type: {})",
                    attachment.s3_key,
                    attachment.mime_type
                );
            }
            Err(e) => {
                // Non-fatal: log and continue; text embedding still covers the dataset
                tracing::warn!("Failed to embed attachment {}: {:?}", attachment.s3_key, e);
            }
        }
    }

    // 5. Average all vectors into one 768-dim result
    let final_vector = average_vectors(all_vectors);

    // 6. Write embedding + set status='approved'
    db::update_embedding(pool, dataset_id, &final_vector)
        .await
        .context("Failed to update embedding")?;

    // 7. Upsert tags and link to dataset
    for tag_name in &msg.tags {
        match db::upsert_tag(pool, tag_name).await {
            Ok(tag_id) => {
                if let Err(e) = db::link_dataset_tag(pool, dataset_id, tag_id).await {
                    tracing::warn!("Failed to link tag '{}': {:?}", tag_name, e);
                }
            }
            Err(e) => tracing::warn!("Failed to upsert tag '{}': {:?}", tag_name, e),
        }
    }

    // 8. Notify server
    let callback_url = if msg.callback_url.is_empty() {
        cfg.server_callback_url.clone().unwrap_or_default()
    } else {
        msg.callback_url.clone()
    };
    notify_server(&callback_url, &msg.upload_id, dataset_id, None).await;

    tracing::info!(
        "Upload complete: upload_id={} dataset_id={}",
        msg.upload_id,
        dataset_id
    );

    Ok(())
}

// Embedding helpers 

fn build_text_for_embedding(msg: &UploadMessage) -> String {
    let mut parts = vec![msg.title.as_str(), msg.description.as_str()];
    if let Some(s) = msg.summary.as_deref() {
        parts.push(s);
    }
    if let Some(p) = msg.publisher.as_deref() {
        parts.push(p);
    }
    let joined = parts.join("\n");
    // Truncate to avoid Gemini token limits (same cap as CKAN worker)
    joined.chars().take(6000).collect()
}

/// Attempt to embed a single attachment.
/// Returns Ok(Some(vec)) on success, Ok(None) for unsupported types, Err on failures.
async fn embed_attachment(
    attachment: &AttachmentInfo,
    api_key: &str,
) -> Result<Option<Vec<f32>>> {
    match attachment.mime_type.as_str() {
        "application/pdf" => {
            let bytes = download_file(&attachment.presigned_url).await?;
            let file_uri = upload_to_gemini_file_api(&bytes, "application/pdf", api_key).await?;
            let vec = embed::embed_file(&file_uri, "application/pdf", api_key).await?;
            Ok(Some(vec))
        }
        "text/csv" | "application/json" | "text/plain" => {
            let bytes = download_file(&attachment.presigned_url).await?;
            let text: String = String::from_utf8_lossy(&bytes).chars().take(6000).collect();
            if text.trim().is_empty() {
                return Ok(None);
            }
            let vec = embed::embed_text(&text, api_key).await?;
            Ok(Some(vec))
        }
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        | "application/vnd.ms-excel" => {
            let bytes = download_file(&attachment.presigned_url).await?;
            match extract_excel_text(&bytes) {
                Ok(text) if !text.trim().is_empty() => {
                    let truncated: String = text.chars().take(6000).collect();
                    let vec = embed::embed_text(&truncated, api_key).await?;
                    Ok(Some(vec))
                }
                Ok(_) => Ok(None),
                Err(e) => {
                    tracing::warn!("Excel text extraction failed: {:?}", e);
                    Ok(None)
                }
            }
        }
        // DOCX and other binary formats — skip file embedding
        _ => Ok(None),
    }
}

/// Download file bytes from a presigned R2 URL.
async fn download_file(presigned_url: &str) -> Result<Bytes> {
    lazy_static::lazy_static! {
        static ref HTTP: reqwest::Client = reqwest::Client::new();
    }
    let resp = HTTP
        .get(presigned_url)
        .send()
        .await
        .context("Failed to download file from R2")?;

    if !resp.status().is_success() {
        anyhow::bail!("R2 download returned HTTP {}", resp.status());
    }

    resp.bytes().await.context("Failed to read file bytes")
}

/// Upload raw bytes to the Gemini File API using the resumable upload protocol.
/// Returns the file URI that can be used with embed_file().
/// Step 1: Initiate resumable upload, get upload URL from response headers.
/// Step 2: PUT raw bytes to that URL.
/// Step 3: Poll until file is ACTIVE, then return its URI.
async fn upload_to_gemini_file_api(
    data: &Bytes,
    mime_type: &str,
    api_key: &str,
) -> Result<String> {
    const UPLOAD_BASE: &str = "https://generativelanguage.googleapis.com/upload/v1beta/files";
    const API_BASE: &str = "https://generativelanguage.googleapis.com/v1beta/files";

    lazy_static::lazy_static! {
        static ref HTTP: reqwest::Client = reqwest::Client::new();
    }

    let size = data.len();

    // Step 1: Initiate resumable upload session
    let start_resp = HTTP
        .post(UPLOAD_BASE)
        .header("x-goog-api-key", api_key)
        .header("X-Goog-Upload-Protocol", "resumable")
        .header("X-Goog-Upload-Command", "start")
        .header("X-Goog-Upload-Header-Content-Length", size.to_string())
        .header("X-Goog-Upload-Header-Content-Type", mime_type)
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({
            "file": { "display_name": "upload" }
        }))
        .send()
        .await
        .context("Gemini File API: failed to initiate resumable upload")?;

    let start_status = start_resp.status();
    if !start_status.is_success() {
        let body = start_resp.text().await.unwrap_or_default();
        anyhow::bail!("Gemini File API start returned {}: {}", start_status, body);
    }

    // Extract the upload URL from response headers
    let upload_url = start_resp
        .headers()
        .get("x-goog-upload-url")
        .and_then(|v| v.to_str().ok())
        .context("Gemini File API: no X-Goog-Upload-URL in response headers")?;

    tracing::debug!("Gemini File API: got upload URL, uploading {} bytes", size);

    // Step 2: PUT raw bytes to the upload URL
    let put_resp = HTTP
        .put(upload_url)
        .header("Content-Length", size.to_string())
        .header("X-Goog-Upload-Offset", "0")
        .header("X-Goog-Upload-Command", "upload, finalize")
        .body(data.clone())
        .send()
        .await
        .context("Gemini File API: failed to PUT bytes")?;

    let put_status = put_resp.status();
    if !put_status.is_success() {
        let body = put_resp.text().await.unwrap_or_default();
        anyhow::bail!("Gemini File API PUT returned {}: {}", put_status, body);
    }

    // Step 3: Parse the response body for file info.
    // IMPORTANT: The Gemini API returns file metadata NESTED under a "file" object.
    // Example response: { "file": { "name": "files/abc", "uri": "https://...", "state": "ACTIVE" } }
    // This is different from the poll response which has fields at root level!
    #[derive(Deserialize)]
    struct FileInfo {
        file: FileData,
    }

    #[derive(Deserialize)]
    struct FileData {
        name: String,
        #[allow(dead_code)]
        uri: String,
        #[allow(dead_code)]
        #[serde(default)]
        state: String,
    }

    let file_info: FileInfo = put_resp
        .json()
        .await
        .context("Gemini File API: failed to parse file info response")?;

    // Gemini processes small files synchronously - if state is already ACTIVE,
    // we can skip the polling step entirely and return the URI immediately.
    // This avoids unnecessary API calls and potential rate limiting.
    if file_info.file.state == "ACTIVE" {
        tracing::debug!("Gemini File API: file is ACTIVE, skipping poll");
        return Ok(file_info.file.uri);
    }

    // Poll until file is ACTIVE (for larger files that need async processing)
    let uri = poll_file_until_active(&HTTP, API_BASE, api_key, &file_info.file.name).await?;

    tracing::debug!("Gemini File API: file ACTIVE at {}", uri);
    Ok(uri)
}

/// Poll GET /v1beta/files/{name} until state == "ACTIVE" or timeout.
async fn poll_file_until_active(
    http: &reqwest::Client,
    api_base: &str,
    api_key: &str,
    file_name: &str,
) -> Result<String> {
    const MAX_ATTEMPTS: usize = 20;
    const POLL_INTERVAL_MS: u64 = 1500;

    for attempt in 0..MAX_ATTEMPTS {
        let resp = http
            .get(format!("{}/{}", api_base, file_name))
            .header("x-goog-api-key", api_key)
            .send()
            .await
            .context("Gemini File API: poll request failed")?;

        #[derive(Deserialize)]
        struct FileStatus {
            #[allow(dead_code)]
            name: String,
            uri: String,
            state: String,
        }

        let status: FileStatus = resp.json().await?;

        if status.state == "ACTIVE" {
            return Ok(status.uri);
        }

        tracing::debug!(
            "Gemini File API: file state={} (attempt {}/{})",
            status.state,
            attempt + 1,
            MAX_ATTEMPTS
        );

        if attempt < MAX_ATTEMPTS - 1 {
            tokio::time::sleep(std::time::Duration::from_millis(POLL_INTERVAL_MS)).await;
        }
    }

    anyhow::bail!(
        "Gemini File API: file did not become ACTIVE within {} attempts",
        MAX_ATTEMPTS
    );
}


/// Extract all cell text from an Excel workbook (.xlsx or .xls).
fn extract_excel_text(data: &[u8]) -> Result<String> {
    let cursor = Cursor::new(data);
    let mut workbook: Xlsx<_> =
        open_workbook_from_rs(cursor).context("Failed to open Excel workbook")?;

    let mut parts: Vec<String> = Vec::new();

    for sheet_name in workbook.sheet_names().to_vec() {
        if let Ok(range) = workbook.worksheet_range(&sheet_name) {
            for row in range.rows() {
                let cells: Vec<String> = row
                    .iter()
                    .filter_map(|cell| {
                        let s = cell.to_string();
                        if s.is_empty() { None } else { Some(s) }
                    })
                    .collect();
                if !cells.is_empty() {
                    parts.push(cells.join(" "));
                }
            }
        }
    }

    Ok(parts.join("\n"))
}

/// Element-wise average of a list of 768-dim vectors.
fn average_vectors(vectors: Vec<Vec<f32>>) -> Vec<f32> {
    assert!(!vectors.is_empty(), "Cannot average an empty vector list");
    let dim = vectors[0].len();
    let n = vectors.len() as f32;
    let mut result = vec![0f32; dim];
    for v in &vectors {
        for (i, val) in v.iter().enumerate() {
            result[i] += val;
        }
    }
    result.iter_mut().for_each(|x| *x /= n);
    result
}

// Server notification

/// Fire-and-forget POST to the server callback URL.
/// Non-fatal: logs on failure but does not fail the overall job.
async fn notify_server(
    callback_url: &str,
    upload_id: &str,
    dataset_id: Uuid,
    error: Option<&str>,
) {
    lazy_static::lazy_static! {
        static ref HTTP: reqwest::Client = reqwest::Client::new();
    }

    let payload = CallbackPayload {
        upload_id: upload_id.to_string(),
        dataset_id: Some(dataset_id.to_string()),
        status: if error.is_none() { "completed".to_string() } else { "failed".to_string() },
        error: error.map(str::to_string),
    };

    match HTTP.post(callback_url).json(&payload).send().await {
        Ok(resp) if resp.status().is_success() => {
            tracing::info!("Server notified successfully");
        }
        Ok(resp) => {
            tracing::warn!("Server callback returned HTTP {}", resp.status());
        }
        Err(e) => {
            tracing::warn!("Server callback failed (non-fatal): {:?}", e);
        }
    }
}
