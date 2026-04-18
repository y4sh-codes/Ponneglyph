mod config;
mod db;
mod embed;
mod sources;
mod sync;
mod upload;

use anyhow::Result;
use lambda_http::{service_fn, Body, Error, Request, Response};
use serde_json::json;
use sources::types::{EmbedBatchRequest, SyncRequest};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn init_tracing() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    init_tracing();
    let _ = dotenvy::dotenv();
    let _ = &config::CONFIG;

    let pool = db::create_pool(&config::CONFIG.database_url)
        .await
        .expect("Failed to connect to database");

    tracing::info!("Worker initialized, database connected");

    // ENTRY POINT SELECTION
    //
    // RABBITMQ_CONSUMER=true → long-running queue consumer (user upload processing)
    // AWS_LAMBDA_FUNCTION_NAME set → AWS Lambda (CKAN sync / embed-batch)
    // otherwise → local HTTP dev server
    if std::env::var("RABBITMQ_CONSUMER").is_ok() {
        tracing::info!("Starting in RabbitMQ consumer mode");
        upload::run_consumer(pool).await?;
    } else if std::env::var("AWS_LAMBDA_FUNCTION_NAME").is_ok() {
        lambda_http::run(service_fn(|req: Request| {
            handler(req, &pool)
        }))
        .await?;
    } else {
        // Local HTTP Server
        // 
        // Dev commands:
        //   curl -X POST http://localhost:8080/sync \
        //     -H "Content-Type: application/json" \
        //     -d '{"source":"opencity","query":"Survey"}'
        //   curl http://localhost:8080/health
        start_local_server(pool).await?;
    }

    Ok(())
}


// ENTRY POINT 1: Local Development HTTP Server
//
// Purpose: Accepts raw HTTP requests over TCP when running via `cargo run`.
//          Provides the same routes as the Lambda handler, but locally.
//
// Routes:
//   POST /sync          → sync::run_sync     (fetch + ingest external datasets)
//   POST /embed-batch   → sync::run_embed_batch (generate embeddings for datasets)
//   GET  /health        → 200 OK
//   POST /health        → 200 OK
//
// Notes:
//   • Uses a bare TCP listener — no framework, just tokio::net::TcpListener.
//   • Request body is read raw into an 8KB buffer and parsed manually.
//   • Response is raw HTTP/1.1 with a JSON body.
//   • Each connection is handled in its own tokio task (spawned).
//   • Safe to expose on 0.0.0.0 locally; restrict to 127.0.0.1 in prod.
async fn start_local_server(pool: sqlx::PgPool) -> Result<()> {
    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080").await?;
    tracing::info!("Starting local HTTP server on http://0.0.0.0:8080");

    loop {
        let (mut stream, _) = listener.accept().await?;
        let pool = pool.clone();

        tokio::spawn(async move {
            let mut buf = vec![0u8; 8192];
            let n = match stream.read(&mut buf).await {
                Ok(0) => return,
                Ok(n) => n,
                Err(_) => return,
            };
            let request_str = match std::str::from_utf8(&buf[..n]) {
                Ok(s) => s,
                Err(_) => return,
            };

            let (method, path, _) = match parse_request_line(request_str) {
                Some(v) => v,
                None => return,
            };

            let body_start = request_str.find("\r\n\r\n").map(|i| i + 4).unwrap_or(0);
            let body = &request_str[body_start..];

            match (method, path) {
                ("POST", "/sync") => {
                    let sync_req: SyncRequest = match serde_json::from_str(body) {
                        Ok(r) => r,
                        Err(e) => {
                            make_response(&mut stream, 400, &json!({"error": format!("Invalid request body: {}", e)})).await;
                            return;
                        }
                    };

                    match sync::run_sync(&pool, &sync_req).await {
                        Ok(resp) => make_response(&mut stream, 200, &resp).await,
                        Err(e) => {
                            tracing::error!("Sync failed: {:?}", e);
                            make_response(&mut stream, 500, &json!({"error": "Internal server error"})).await;
                        }
                    }
                }
                ("POST", "/embed-batch") => {
                    let embed_req: EmbedBatchRequest = match serde_json::from_str(body) {
                        Ok(r) => r,
                        Err(e) => {
                            make_response(&mut stream, 400, &json!({"error": format!("Invalid request body: {}", e)})).await;
                            return;
                        }
                    };

                    match sync::run_embed_batch(&pool, &embed_req).await {
                        Ok(resp) => make_response(&mut stream, 200, &resp).await,
                        Err(e) => {
                            tracing::error!("Embed batch failed: {:?}", e);
                            make_response(&mut stream, 500, &json!({"error": "Internal server error"})).await;
                        }
                    }
                }
                ("GET", "/health") | ("POST", "/health") => {
                    make_response(&mut stream, 200, &json!({"status": "healthy"})).await;
                }
                _ => {
                    make_response(&mut stream, 404, &json!({"error": "Not found"})).await;
                }
            }
        });
    }
}

fn parse_request_line(s: &str) -> Option<(&str, &str, &str)> {
    let mut lines = s.splitn(2, "\r\n");
    let request_line = lines.next()?;
    let mut parts = request_line.splitn(3, ' ');
    let method = parts.next()?;
    let path = parts.next()?;
    let http_ver = parts.next()?;
    Some((method, path, http_ver))
}

async fn make_response(stream: &mut tokio::net::TcpStream, status: u16, body: &impl serde::Serialize) {
    let body_str = serde_json::to_string(body).unwrap_or_else(|_| "{}".to_string());
    let response = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
        status,
        status_text(status),
        body_str.len(),
        body_str
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.flush().await;
}

fn status_text(code: u16) -> &'static str {
    match code {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "Unknown",
    }
}


// AWS Lambda Handler
//
// Purpose: Handle API Gateway proxy requests from the Lambda runtime.
//          Called by lambda_http::run() — same routes as local server.
//
// Routes (identical to local server):
//   POST /sync          → sync::run_sync
//   POST /embed-batch   → sync::run_embed_batch
//   GET  /health        → 200 OK
//
// Notes:
//   • lambda_http wraps Lambda's event format into a Request/Response.
//   • Logs go to CloudWatch via stdout (no file writing in Lambda).
//   • Lambda cold starts load the config + pool once, then reuse.
async fn handler(req: Request, pool: &sqlx::PgPool) -> Result<Response<Body>, Error> {
    let path = req.uri().path().to_string();
    let method = req.method().as_str();

    tracing::info!("{} {}", method, path);

    let response = match (method, path.as_str()) {
        ("POST", "/sync") => handle_sync(req, pool).await,
        ("POST", "/embed-batch") => handle_embed_batch(req, pool).await,
        ("GET", "/health") => Ok(json_response(200, &json!({"status": "healthy"}))),
        _ => Ok(json_response(404, &json!({"error": "Not found"}))),
    };

    response
}

async fn handle_sync(req: Request, pool: &sqlx::PgPool) -> Result<Response<Body>, Error> {
    let body = req.body();
    let sync_req: SyncRequest = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(e) => {
            return Ok(json_response(
                400,
                &json!({"error": format!("Invalid request body: {}", e)}),
            ));
        }
    };

    match sync::run_sync(pool, &sync_req).await {
        Ok(resp) => Ok(json_response(200, &resp)),
        Err(e) => {
            tracing::error!("Sync failed: {:?}", e);
            Ok(json_response(
                500,
                &json!({"error": format!("Sync failed: {}", e)}),
            ))
        }
    }
}

async fn handle_embed_batch(req: Request, pool: &sqlx::PgPool) -> Result<Response<Body>, Error> {
    let body = req.body();
    let embed_req: EmbedBatchRequest = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(e) => {
            return Ok(json_response(
                400,
                &json!({"error": format!("Invalid request body: {}", e)}),
            ));
        }
    };

    match sync::run_embed_batch(pool, &embed_req).await {
        Ok(resp) => Ok(json_response(200, &resp)),
        Err(e) => {
            tracing::error!("Embed batch failed: {:?}", e);
            Ok(json_response(
                500,
                &json!({"error": format!("Embed batch failed: {}", e)}),
            ))
        }
    }
}

fn json_response(status: u16, body: &impl serde::Serialize) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("Content-Type", "application/json")
        .body(Body::from(serde_json::to_string(body).unwrap_or_else(|_| "{}".to_string())))
        .expect("Failed to build response")
}
