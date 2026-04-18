use anyhow::{Context, Result};
use serde::Deserialize;

use super::types::SourceDataset;

const DEFAULT_ROWS: usize = 100;

#[derive(Debug, Deserialize)]
struct CkanSearchResponse {
    result: CkanSearchResult,
}

#[derive(Debug, Deserialize)]
struct CkanSearchResult {
    count: usize,
    results: Vec<CkanPackage>,
}

#[derive(Debug, Deserialize)]
struct CkanPackage {
    id: String,
    title: String,
    notes: Option<String>,
    #[serde(rename = "metadata_created")]
    metadata_created: Option<String>,
    organization: Option<CkanOrganization>,
    url: Option<String>,
    tags: Option<Vec<CkanTag>>,
    resources: Option<Vec<CkanResource>>,
}

#[derive(Debug, Deserialize)]
struct CkanOrganization {
    title: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CkanTag {
    name: String,
}

#[derive(Debug, Deserialize)]
struct CkanResource {
    url: Option<String>,
    format: Option<String>,
}

pub async fn fetch_all(query: &str) -> Result<Vec<SourceDataset>> {
    let client = reqwest::Client::new();
    let base_url = &crate::config::CONFIG.ckan_base_url;
    let mut all_packages = Vec::new();
    let mut offset: usize = 0;

    loop {
        let search_url = format!("{base_url}/api/3/action/package_search");

        let resp: CkanSearchResponse = client
            .post(&search_url)
            .json(&serde_json::json!({
                "q": query,
                "rows": DEFAULT_ROWS,
                "start": offset,
            }))
            .send()
            .await
            .context("CKAN package_search request failed")?
            .json()
            .await
            .context("Failed to parse CKAN package_search response")?;

        let total = resp.result.count;
        let batch = resp.result.results.len();

        for pkg in resp.result.results {
            all_packages.push(map_package(pkg));
        }

        offset += batch;
        if offset >= total || batch == 0 {
            break;
        }

        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }

    tracing::info!("CKAN fetch_all: got {} datasets", all_packages.len());
    Ok(all_packages)
}

/// Build the embedding text for a dataset from its metadata.
fn map_package(pkg: CkanPackage) -> SourceDataset {
    let publisher = pkg.organization.and_then(|o| o.title);

    // Parse ISO 8601 timestamp - CKAN returns various formats
    let publication_date = pkg.metadata_created.and_then(|s| {
        chrono::DateTime::parse_from_rfc3339(&s)
            .ok()
            .map(|dt| dt.naive_utc())
    });

    let tags = pkg
        .tags
        .unwrap_or_default()
        .into_iter()
        .map(|t| t.name)
        .collect();

    let mut resource_urls = Vec::new();
    let mut resource_formats = Vec::new();

    for res in pkg.resources.unwrap_or_default() {
        if let Some(url) = res.url {
            resource_urls.push(url);
        }
        let fmt = res
            .format
            .map(|f| f.to_lowercase())
            .unwrap_or_else(|| "other".to_string());
        resource_formats.push(map_file_type(&fmt));
    }

    SourceDataset {
        external_id: pkg.id,
        title: pkg.title,
        description: pkg.notes,
        publisher,
        publication_date,
        source_url: pkg.url,
        tags,
        resource_urls,
        resource_formats,
    }
}

fn map_file_type(fmt: &str) -> String {
    match fmt {
        "pdf" => "pdf".to_string(),
        "csv" => "csv".to_string(),
        "xlsx" | "xls" => "xlsx".to_string(),
        "json" => "json".to_string(),
        "docx" => "docx".to_string(),
        _ => "other".to_string(),
    }
}

pub fn build_embedding_text(ds: &SourceDataset) -> String {
    let mut parts = Vec::new();

    parts.push(ds.title.clone());

    if let Some(desc) = &ds.description {
        let trimmed = desc.trim();
        if !trimmed.is_empty() {
            parts.push(trimmed.to_string());
        }
    }

    if let Some(pub_name) = &ds.publisher {
        parts.push(format!("Organization: {pub_name}"));
    }

    if !ds.tags.is_empty() {
        parts.push(format!("Tags: {}", ds.tags.join(", ")));
    }

    let resource_parts: Vec<String> = ds
        .resource_formats
        .iter()
        .enumerate()
        .map(|(i, fmt)| {
            let name = ds.resource_urls.get(i)
                .and_then(|u| u.split('/').next_back())
                .unwrap_or("resource");
            format!("[{fmt}] {name}")
        })
        .collect();

    if !resource_parts.is_empty() {
        parts.push(format!("Resources: {}", resource_parts.join(", ")));
    }

    let full = parts.join("\n");

    // Truncate at ~6000 chars (word boundary), safely handling UTF-8
    if full.len() > 6000 {
        let truncated: String = full.chars().take(6000).collect();
        if let Some(last_space) = truncated.rfind(' ') {
            truncated[..last_space].to_string()
        } else {
            truncated
        }
    } else {
        full
    }
}
