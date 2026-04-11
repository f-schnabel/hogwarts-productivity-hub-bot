pub mod routes;

use std::sync::Arc;

use axum::{Router, routing::get};
use sqlx::PgPool;
use tower_http::trace::TraceLayer;

use crate::config::Config;

/// Shared state for the analytics web server.
#[derive(Clone)]
pub struct WebState {
    pub pool: Arc<PgPool>,
    pub config: Arc<Config>,
    pub guild_id: serenity::model::id::GuildId,
    pub http: Arc<serenity::http::Http>,
    pub cache: Arc<serenity::cache::Cache>,
}

/// Build the analytics router (house standings, leaderboard, user profiles, hall of fame).
pub fn analytics_router(state: WebState) -> Router {
    Router::new()
        .route("/", get(routes::index))
        .route("/leaderboard", get(routes::leaderboard))
        .route("/user/{id}", get(routes::user_profile))
        .route("/hall-of-fame", get(routes::hall_of_fame))
        .route("/cup/{month}", get(routes::cup_detail))
        .with_state(state)
        .layer(TraceLayer::new_for_http())
}

/// Build the metrics router (Prometheus /metrics endpoint).
pub fn metrics_router() -> Router {
    Router::new().route("/metrics", get(routes::prometheus_metrics))
}
