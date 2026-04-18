use std::sync::LazyLock;

pub struct Config {
    pub database_url: String,
    pub gemini_api_key: String,
    pub ckan_base_url: String,
    // RabbitMQ
    pub rabbitmq_url: String,
    pub rabbitmq_queue: String,
    pub rabbitmq_failed_queue: String,
    pub rabbitmq_prefetch: u16,
    // Callback URL for notifying the server after processing
    pub server_callback_url: Option<String>,
}

pub static CONFIG: LazyLock<Config> = LazyLock::new(|| {
    let queue_name =
        std::env::var("RABBITMQ_QUEUE").unwrap_or_else(|_| "poneglyph-upload".to_string());
    let failed_queue_name = format!("{}-failed", queue_name);

    Config {
        database_url: std::env::var("DATABASE_URL").expect("DATABASE_URL must be set"),
        gemini_api_key: std::env::var("GEMINI_API_KEY").expect("GEMINI_API_KEY must be set"),
        ckan_base_url: std::env::var("CKAN_BASE_URL").expect("CKAN_BASE_URL must be set"),
        rabbitmq_url: std::env::var("RABBITMQ_URL").expect("RABBITMQ_URL must be set"),
        rabbitmq_queue: queue_name,
        rabbitmq_failed_queue: failed_queue_name,
        rabbitmq_prefetch: std::env::var("RABBITMQ_PREFETCH")
            .unwrap_or_else(|_| "5".to_string())
            .parse()
            .unwrap_or(5),
        server_callback_url: std::env::var("SERVER_CALLBACK_URL").ok(),
    }
});
