mod bot;
mod config;
mod constants;
mod db;
mod error;
mod metrics;
mod models;
mod services;
mod web;

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::Context as _;
use tokio::net::TcpListener;
use tokio::signal;
use tracing::info;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // ── Environment & logging ────────────────────────────────────────────
    dotenvy::dotenv().ok();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,hogwarts_bot=debug".into()),
        )
        .init();

    // ── Config ────────────────────────────────────────────────────────────
    let config = Arc::new(config::Config::from_env().context("Failed to load config")?);
    info!("Config loaded, guild_id={}", config.guild_id);

    // ── Database ──────────────────────────────────────────────────────────
    let pool = Arc::new(
        db::create_pool(&config.database_url)
            .await
            .context("Failed to connect to PostgreSQL")?,
    );
    info!("Database connected");

    db::run_migrations(&pool)
        .await
        .context("Failed to run migrations")?;
    info!("Migrations complete");

    // ── Metrics ───────────────────────────────────────────────────────────
    metrics::init();

    // ── Discord client ────────────────────────────────────────────────────
    let mut discord_client = bot::build_client((*pool).clone(), config.clone())
        .await
        .context("Failed to build Discord client")?;

    // Extract HTTP and Cache before starting the client
    let http = discord_client.http.clone();
    let cache = discord_client.cache.clone();

    // ── Cron schedulers ───────────────────────────────────────────────────
    let _reset_scheduler = services::reset::start(
        pool.clone(),
        config.clone(),
        http.clone(),
        cache.clone(),
    )
    .await
    .context("Failed to start reset scheduler")?;

    let _journal_scheduler = services::journal::start(
        pool.clone(),
        config.clone(),
        http.clone(),
    )
    .await
    .context("Failed to start journal scheduler")?;

    info!("Cron schedulers started");

    // ── Analytics web server ──────────────────────────────────────────────
    let web_state = web::WebState {
        pool: pool.clone(),
        config: config.clone(),
        guild_id: serenity::all::GuildId::new(config.guild_id),
        http: http.clone(),
        cache: cache.clone(),
    };

    let analytics_port: u16 = std::env::var("ANALYTICS_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(3000);

    let analytics_addr = SocketAddr::from(([0, 0, 0, 0], analytics_port));
    let analytics_listener = TcpListener::bind(analytics_addr)
        .await
        .with_context(|| format!("Failed to bind analytics server on port {analytics_port}"))?;

    info!(port = analytics_port, "Analytics server listening");

    tokio::spawn(async move {
        let router = web::analytics_router(web_state);
        if let Err(e) = axum::serve(analytics_listener, router).await {
            tracing::error!("Analytics server error: {e}");
        }
    });

    // ── Metrics web server ────────────────────────────────────────────────
    let metrics_port: u16 = std::env::var("METRICS_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8080);

    let metrics_addr = SocketAddr::from(([0, 0, 0, 0], metrics_port));
    let metrics_listener = TcpListener::bind(metrics_addr)
        .await
        .with_context(|| format!("Failed to bind metrics server on port {metrics_port}"))?;

    info!(port = metrics_port, "Metrics server listening");

    tokio::spawn(async move {
        let router = web::metrics_router();
        if let Err(e) = axum::serve(metrics_listener, router).await {
            tracing::error!("Metrics server error: {e}");
        }
    });

    // ── Graceful shutdown on SIGTERM/SIGINT ───────────────────────────────
    let shard_manager = discord_client.shard_manager.clone();
    let pool_shutdown = pool.clone();

    tokio::spawn(async move {
        tokio::select! {
            _ = signal::ctrl_c() => {
                info!("Received Ctrl-C, shutting down...");
            }
            _ = async {
                #[cfg(unix)]
                {
                    let mut sigterm = signal::unix::signal(signal::unix::SignalKind::terminate())
                        .expect("Failed to register SIGTERM handler");
                    sigterm.recv().await;
                    info!("Received SIGTERM, shutting down...");
                }
                #[cfg(not(unix))]
                {
                    futures::future::pending::<()>().await;
                }
            } => {}
        }

        // Close any open voice sessions before exiting
        let _ = close_all_voice_sessions(&pool_shutdown).await;

        shard_manager.shutdown_all().await;
    });

    // ── Run Discord bot ───────────────────────────────────────────────────
    info!("Starting Discord bot...");
    discord_client
        .start()
        .await
        .context("Discord client error")?;

    info!("Bot shut down gracefully");
    Ok(())
}

/// Close all open voice sessions on shutdown (prevents dangling sessions).
async fn close_all_voice_sessions(pool: &sqlx::PgPool) {
    match sqlx::query!(
        "UPDATE voice_session SET left_at = NOW(), is_tracked = false WHERE left_at IS NULL"
    )
    .execute(pool)
    .await
    {
        Ok(r) => info!(rows = r.rows_affected(), "Closed open voice sessions on shutdown"),
        Err(e) => tracing::error!("Failed to close voice sessions on shutdown: {e}"),
    }
}
