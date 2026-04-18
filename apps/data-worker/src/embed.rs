use anyhow::{Context, Result};
use lazy_static::lazy_static;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Semaphore;

lazy_static! {
    static ref CLIENT: reqwest::Client = reqwest::Client::new();
}

const MAX_CONCURRENT: usize = 10;
const MAX_RETRIES: usize = 3;
const GEMINI_EMBED_URL: &str =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2-preview:embedContent";

#[derive(Debug, Serialize)]
struct EmbedContentRequest {
    content: Content,
    #[serde(rename = "output_dimensionality")]
    output_dimensionality: u32,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
enum Content {
    Text { parts: Vec<TextPart> },
    File { parts: Vec<FilePart> },
}

#[derive(Debug, Serialize)]
struct TextPart {
    text: String,
}

#[derive(Debug, Serialize)]
struct FilePart {
    #[serde(rename = "fileData")]
    file_data: FileData,
}

#[derive(Debug, Serialize)]
struct FileData {
    #[serde(rename = "mimeType")]
    mime_type: String,
    #[serde(rename = "fileUri")]
    file_uri: String,
}

#[derive(Debug, Deserialize)]
struct EmbedContentResponse {
    embedding: Embedding,
}

#[derive(Debug, Deserialize)]
struct Embedding {
    values: Vec<f32>,
}

/// Embed a single text string via Gemini API.
pub async fn embed_text(text: &str, api_key: &str) -> Result<Vec<f32>> {
    let client = &*CLIENT;

    let req_body = EmbedContentRequest {
        content: Content::Text {
            parts: vec![TextPart {
                text: text.to_string(),
            }],
        },
        output_dimensionality: 768,
    };

    let response = client
        .post(GEMINI_EMBED_URL)
        .header("x-goog-api-key", api_key)
        .header("Content-Type", "application/json")
        .json(&req_body)
        .send()
        .await
        .context("Gemini embed_text request failed")?;
    
    // Check HTTP status before parsing
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(anyhow::anyhow!(
            "Gemini API returned error status {}: {}",
            status,
            text
        ));
    }

    let resp: EmbedContentResponse = response
        .json()
        .await
        .context("Failed to parse Gemini embed response")?;

    Ok(resp.embedding.values)
}

/// Embed a file (PDF) via Gemini API using fileData.
pub async fn embed_file(
    file_uri: &str,
    mime_type: &str,
    api_key: &str,
) -> Result<Vec<f32>> {
    let client = &*CLIENT;

    let req_body = EmbedContentRequest {
        content: Content::File {
            parts: vec![FilePart {
                file_data: FileData {
                    mime_type: mime_type.to_string(),
                    file_uri: file_uri.to_string(),
                },
            }],
        },
        output_dimensionality: 768,
    };

    let response = client
        .post(GEMINI_EMBED_URL)
        .header("x-goog-api-key", api_key)
        .header("Content-Type", "application/json")
        .json(&req_body)
        .send()
        .await
        .context("Gemini embed_file request failed")?;
    
    // Check HTTP status before parsing
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(anyhow::anyhow!(
            "Gemini API returned error status {}: {}",
            status,
            text
        ));
    }

    let resp: EmbedContentResponse = response
        .json()
        .await
        .context("Failed to parse Gemini embed response")?;

    Ok(resp.embedding.values)
}

/// Embed a batch of (id, text) pairs with semaphore-controlled concurrency.
/// Returns Vec of (id, vector) for successes, skips failures.
pub async fn embed_batch(
    items: Vec<(uuid::Uuid, String)>,
    api_key: &str,
) -> Vec<(uuid::Uuid, Vec<f32>)> {
    let semaphore = Arc::new(Semaphore::new(MAX_CONCURRENT));
    let mut handles = Vec::with_capacity(items.len());

    for (id, text) in items {
        let sem = semaphore.clone();
        let api_key = api_key.to_string();

        handles.push(tokio::spawn(async move {
            let _permit = sem.acquire().await.unwrap();
            match embed_with_retry(&text, &api_key).await {
                Ok(vector) => Some((id, vector)),
                Err(e) => {
                    tracing::error!("Embed failed for dataset {}: {}", id, e);
                    None
                }
            }
        }));
    }

    let mut results = Vec::new();
    for handle in handles {
        if let Ok(Some(item)) = handle.await {
            results.push(item);
        }
    }

    results
}

/// Embed a single text with retry on 429 rate limit.
async fn embed_with_retry(text: &str, api_key: &str) -> Result<Vec<f32>> {
    for attempt in 0..MAX_RETRIES {
        match embed_text(text, api_key).await {
            Ok(vector) => return Ok(vector),
            Err(e) => {
                // Check if it's a rate limit error (HTTP 429)
                let is_rate_limit = e
                    .downcast_ref::<reqwest::Error>()
                    .map(|e| e.status() == Some(StatusCode::TOO_MANY_REQUESTS))
                    .unwrap_or_else(|| {
                        // Fallback: check error message for "429"
                        let msg = e.to_string().to_lowercase();
                        msg.contains("429") || msg.contains("too many requests")
                    });
                
                if is_rate_limit && attempt < MAX_RETRIES - 1 {
                    let delay = std::time::Duration::from_secs(1 << attempt);
                    tracing::warn!(
                        "Rate limited, retrying in {:?} (attempt {}/{})",
                        delay,
                        attempt + 1,
                        MAX_RETRIES
                    );
                    tokio::time::sleep(delay).await;
                } else {
                    return Err(e);
                }
            }
        }
    }
    unreachable!()
}

/// Embed a batch of file-based items (PDF via fileData) with semaphore.
pub async fn embed_file_batch(
    items: Vec<(uuid::Uuid, String, String)>, // (id, file_uri, mime_type)
    api_key: &str,
) -> Vec<(uuid::Uuid, Vec<f32>)> {
    let semaphore = Arc::new(Semaphore::new(MAX_CONCURRENT));
    let mut handles = Vec::with_capacity(items.len());

    for (id, file_uri, mime_type) in items {
        let sem = semaphore.clone();
        let api_key = api_key.to_string();

        handles.push(tokio::spawn(async move {
            let _permit = sem.acquire().await.unwrap();
            match embed_file_with_retry(&file_uri, &mime_type, &api_key).await {
                Ok(vector) => Some((id, vector)),
                Err(e) => {
                    tracing::error!("Embed file failed for dataset {}: {}", id, e);
                    None
                }
            }
        }));
    }

    let mut results = Vec::new();
    for handle in handles {
        if let Ok(Some(item)) = handle.await {
            results.push(item);
        }
    }

    results
}

async fn embed_file_with_retry(
    file_uri: &str,
    mime_type: &str,
    api_key: &str,
) -> Result<Vec<f32>> {
    for attempt in 0..MAX_RETRIES {
        match embed_file(file_uri, mime_type, api_key).await {
            Ok(vector) => return Ok(vector),
            Err(e) => {
                // Check if it's a rate limit error (HTTP 429)
                let is_rate_limit = e
                    .downcast_ref::<reqwest::Error>()
                    .map(|e| e.status() == Some(StatusCode::TOO_MANY_REQUESTS))
                    .unwrap_or_else(|| {
                        // Fallback: check error message
                        let msg = e.to_string().to_lowercase();
                        msg.contains("429") || msg.contains("too many requests")
                    });
                
                if is_rate_limit && attempt < MAX_RETRIES - 1 {
                    let delay = std::time::Duration::from_secs(1 << attempt);
                    tracing::warn!(
                        "Rate limited on file embed, retrying in {:?} (attempt {}/{})",
                        delay,
                        attempt + 1,
                        MAX_RETRIES
                    );
                    tokio::time::sleep(delay).await;
                } else {
                    return Err(e);
                }
            }
        }
    }
    unreachable!()
}
