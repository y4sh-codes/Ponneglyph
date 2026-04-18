use anyhow::{Context, Result};
use sqlx::postgres::PgConnectOptions;
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};
use std::collections::HashSet;
use std::str::FromStr;
use uuid::Uuid;

use crate::sources::types::SourceDataset;

pub async fn create_pool(database_url: &str) -> Result<PgPool> {
    let connect_options = PgConnectOptions::from_str(database_url)
        .context("Invalid DATABASE_URL")?
        // Supabase poolers (PgBouncer transaction mode) can fail with
        // "prepared statement already exists" when statement caching is on.
        .statement_cache_capacity(0);

    PgPoolOptions::new()
        .max_connections(5)
        .connect_with(connect_options)
        .await
        .context("Failed to create database pool")
}

/// Look up source id by name.
pub async fn get_source_id_by_name(pool: &PgPool, name: &str) -> Result<Option<Uuid>> {
    let row = sqlx::query("SELECT id FROM sources WHERE name = $1")
        .persistent(false)
        .bind(name)
        .fetch_optional(pool)
        .await
        .context("Failed to query source by name")?;

    Ok(row.map(|r| r.get("id")))
}

/// Return external_ids that already exist for a source.
pub async fn get_existing_external_ids(
    pool: &PgPool,
    source_id: Uuid,
    external_ids: &[String],
) -> Result<HashSet<String>> {
    if external_ids.is_empty() {
        return Ok(HashSet::new());
    }

    let rows = sqlx::query(
        r#"
        SELECT external_id
        FROM datasets
        WHERE source_id = $1
          AND external_id = ANY($2)
        "#,
    )
    .persistent(false)
    .bind(source_id)
    .bind(external_ids)
    .fetch_all(pool)
    .await
    .context("Failed to fetch existing external ids")?;

    let mut existing = HashSet::with_capacity(rows.len());
    for row in rows {
        let external_id: String = row.get("external_id");
        existing.insert(external_id);
    }

    Ok(existing)
}

/// Upsert a dataset by external_id. Returns (dataset_id, was_insert).
pub async fn upsert_dataset(
    pool: &PgPool,
    ds: &SourceDataset,
    source_id: Uuid,
) -> Result<(Uuid, bool)> {
    let row = sqlx::query(
        r#"
        INSERT INTO datasets (external_id, source_id, title, description, publisher, publication_date, source_url, s3_keys, file_types, dataset_status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::file_type[], 'pending')
        ON CONFLICT (external_id) DO UPDATE SET
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        publisher = EXCLUDED.publisher,
        publication_date = EXCLUDED.publication_date,
        source_url = EXCLUDED.source_url,
        s3_keys = EXCLUDED.s3_keys,
        file_types = EXCLUDED.file_types,
        updated_at = NOW()
        RETURNING id, (xmax = 0) AS inserted
        "#,
    )
    .persistent(false)
    .bind(&ds.external_id)
    .bind(source_id)
    .bind(&ds.title)
    .bind(&ds.description)
    .bind(&ds.publisher)
    .bind(ds.publication_date)
    .bind(&ds.source_url)
    .bind(&ds.resource_urls)
    .bind(&ds.resource_formats)
    .fetch_one(pool)
    .await
    .context("Failed to upsert dataset")?;

    Ok((row.get("id"), row.get("inserted")))
}

/// Upsert a tag by name. Returns tag_id.
pub async fn upsert_tag(pool: &PgPool, tag_name: &str) -> Result<Uuid> {
    let slug = tag_name.to_lowercase().replace(' ', "-");

    let inserted = sqlx::query(
        r#"
        INSERT INTO tags (name, slug)
        VALUES ($1, $2)
        ON CONFLICT (name) DO NOTHING
        RETURNING id
        "#,
    )
    .persistent(false)
    .bind(tag_name)
    .bind(&slug)
    .fetch_optional(pool)
    .await
    .context("Failed to upsert tag")?;

    if let Some(row) = inserted {
        return Ok(row.get("id"));
    }

    let row = sqlx::query("SELECT id FROM tags WHERE name = $1")
        .persistent(false)
        .bind(tag_name)
        .fetch_one(pool)
        .await
        .context("Failed to fetch existing tag id")?;

    Ok(row.get("id"))
}

/// Link a dataset to a tag (ignore if already linked).
pub async fn link_dataset_tag(pool: &PgPool, dataset_id: Uuid, tag_id: Uuid) -> Result<()> {
    sqlx::query(
        r#"
        INSERT INTO dataset_tags (dataset_id, tag_id)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
        "#,
    )
    .persistent(false)
    .bind(dataset_id)
    .bind(tag_id)
    .execute(pool)
    .await
    .context("Failed to link dataset tag")?;

    Ok(())
}

const EXPECTED_VECTOR_DIMENSIONS: usize = 768;

/// Update the embedding vector for a dataset and set status to 'approved'.
pub async fn update_embedding(
    pool: &PgPool,
    dataset_id: Uuid,
    vector: &[f32],
) -> Result<()> {
    // Validate vector dimensions
    if vector.len() != EXPECTED_VECTOR_DIMENSIONS {
        return Err(anyhow::anyhow!(
            "Invalid vector dimensions: expected {}, got {}",
            EXPECTED_VECTOR_DIMENSIONS,
            vector.len()
        ));
    }

    let vec_str = format!(
        "[{}]",
        vector
            .iter()
            .map(|v| v.to_string())
            .collect::<Vec<_>>()
            .join(",")
    );

    sqlx::query(
        r#"
        UPDATE datasets
        SET embedding = $1::vector, dataset_status = 'approved', updated_at = NOW()
        WHERE id = $2
        "#,
    )
    .persistent(false)
    .bind(&vec_str)
    .bind(dataset_id)
    .execute(pool)
    .await
    .context("Failed to update embedding")?;

    Ok(())
}

/// Archive datasets from a source that are no longer present in the live set.
pub async fn archive_missing_datasets(
    pool: &PgPool,
    source_id: Uuid,
    live_external_ids: &[String],
) -> Result<u64> {
    let result = sqlx::query(
        r#"
        UPDATE datasets
        SET dataset_status = 'archived', updated_at = NOW()
        WHERE source_id = $1
        AND external_id IS NOT NULL
        AND external_id != ALL($2)
        AND dataset_status != 'archived'
        "#,
    )
    .persistent(false)
    .bind(source_id)
    .bind(live_external_ids)
    .execute(pool)
    .await
    .context("Failed to archive missing datasets")?;

    Ok(result.rows_affected())
}

/// Create a sync_log entry. Returns the log id.
pub async fn create_sync_log(pool: &PgPool, source_id: Uuid, total_found: i32) -> Result<Uuid> {
    let row = sqlx::query(
        r#"
        INSERT INTO sync_logs (source_id, total_found, sync_status)
        VALUES ($1, $2, 'running')
        RETURNING id
        "#,
    )
    .persistent(false)
    .bind(source_id)
    .bind(total_found)
    .fetch_one(pool)
    .await
    .context("Failed to create sync log")?;

    Ok(row.get("id"))
}

/// Update a sync_log entry with final results.
pub async fn update_sync_log(
    pool: &PgPool,
    log_id: Uuid,
    added: i32,
    updated: i32,
    archived: i32,
    error_count: i32,
    errors: &[String],
) -> Result<()> {
    let error_text = if errors.is_empty() {
        None
    } else {
        Some(errors.join("\n"))
    };

    sqlx::query(
        r#"
        UPDATE sync_logs
        SET sync_status = 'completed',
        added = $2,
        updated = $3,
        archived = $4,
        error_count = $5,
        completed_at = NOW(),
        error = $6
        WHERE id = $1
        "#,
    )
    .persistent(false)
    .bind(log_id)
    .bind(added)
    .bind(updated)
    .bind(archived)
    .bind(error_count)
    .bind(error_text)
    .execute(pool)
    .await
    .context("Failed to update sync log")?;

    Ok(())
}

/// Mark a sync_log as failed.
pub async fn fail_sync_log(pool: &PgPool, log_id: Uuid, error: &str) -> Result<()> {
    sqlx::query(
        r#"
        UPDATE sync_logs
        SET sync_status = 'failed', completed_at = NOW(), error = $2
        WHERE id = $1
        "#,
    )
    .persistent(false)
    .bind(log_id)
    .bind(error)
    .execute(pool)
    .await
    .context("Failed to mark sync log as failed")?;

    Ok(())
}

/// Insert a new source record for a user upload.
/// source_type is always 'upload'. Returns the new source id.
/// user_id is optional — pass None for anonymous/unauthenticated uploads.
pub async fn insert_source_for_upload(
    pool: &PgPool,
    user_id: Option<&str>,
    name: &str,
) -> Result<Uuid> {
    let row = sqlx::query(
        r#"
        INSERT INTO sources (user_id, name, url, source_type, is_verified)
        VALUES ($1, $2, '', 'upload', false)
        RETURNING id
        "#,
    )
    .persistent(false)
    .bind(user_id)
    .bind(name)
    .fetch_one(pool)
    .await
    .context("Failed to insert upload source")?;

    Ok(row.get("id"))
}

/// Insert a new dataset for a user upload (no external_id).
/// Status starts as 'pending'; embedding update sets it to 'approved'.
pub async fn insert_upload_dataset(
    pool: &PgPool,
    source_id: Uuid,
    title: &str,
    description: &str,
    summary: Option<&str>,
    publisher: Option<&str>,
    s3_keys: &[String],
    file_types: &[String],
    thumbnail_s3_key: Option<&str>,
) -> Result<Uuid> {
    let row = sqlx::query(
        r#"
        INSERT INTO datasets
            (source_id, title, description, summary, publisher,
             s3_keys, file_types, thumbnail_s3_key, dataset_status)
        VALUES ($1, $2, $3, $4, $5, $6, $7::file_type[], $8, 'pending')
        RETURNING id
        "#,
    )
    .persistent(false)
    .bind(source_id)
    .bind(title)
    .bind(description)
    .bind(summary)
    .bind(publisher)
    .bind(s3_keys)
    .bind(file_types)
    .bind(thumbnail_s3_key)
    .fetch_one(pool)
    .await
    .context("Failed to insert upload dataset")?;

    Ok(row.get("id"))
}
