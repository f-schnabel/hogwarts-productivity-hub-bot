#![allow(dead_code)]
use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};

// ─── Database row types ────────────────────────────────────────────────────
// DB uses `timestamp` (without timezone) → maps to NaiveDateTime in sqlx.

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct User {
    pub discord_id: String,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
    pub username: String,
    pub house: Option<String>,
    pub timezone: String,
    pub last_daily_reset: NaiveDateTime,
    pub daily_points: i32,
    pub monthly_points: i32,
    pub total_points: i32,
    pub daily_voice_time: i32,
    pub monthly_voice_time: i32,
    pub total_voice_time: i32,
    pub daily_messages: i32,
    pub message_streak: i32,
    pub announced_year: i32,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct VoiceSession {
    pub id: i32,
    pub discord_id: String,
    pub joined_at: NaiveDateTime,
    pub left_at: Option<NaiveDateTime>,
    pub channel_id: String,
    pub channel_name: String,
    pub is_tracked: bool,
    pub points: Option<i32>,
    /// Generated column: EXTRACT(EPOCH FROM (left_at - joined_at))
    pub duration: Option<i32>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Submission {
    pub id: i32,
    pub discord_id: String,
    pub submitted_at: NaiveDateTime,
    pub reviewed_at: Option<NaiveDateTime>,
    pub reviewed_by: Option<String>,
    pub message_id: Option<String>,
    pub channel_id: Option<String>,
    pub house: String,
    pub house_id: i32,
    pub screenshot_url: String,
    pub points: i32,
    pub submission_type: Option<String>, // "NEW" | "COMPLETED"
    pub status: String,                  // "PENDING" | "APPROVED" | "REJECTED" | "CANCELED"
    pub linked_submission_id: Option<i32>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct HouseScoreboard {
    pub id: i32,
    pub house: String,
    pub channel_id: String,
    pub message_id: String,
    pub updated_at: NaiveDateTime,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Setting {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct HouseCupMonth {
    pub id: i32,
    pub month: String, // "YYYY-MM"
    pub winner: String,
    pub created_at: NaiveDateTime,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct HouseCupEntry {
    pub id: i32,
    pub month_id: i32,
    pub house: String,
    pub weighted_points: i32,
    pub raw_points: i32,
    pub member_count: i32,
    pub qualifying_count: i32,
    pub champion: Option<String>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct PointAdjustment {
    pub id: i32,
    pub discord_id: String,
    pub adjusted_by: String,
    pub amount: i32,
    pub reason: Option<String>,
    pub created_at: NaiveDateTime,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct JournalEntry {
    pub id: i32,
    pub date: chrono::NaiveDate, // DATE type in DB
    pub prompt: String,
    pub message_id: Option<String>,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

// ─── Lightweight projections ───────────────────────────────────────────────

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct UserVoiceInfo {
    pub daily_voice_time: i32,
    pub monthly_voice_time: i32,
    pub house: Option<String>,
    pub announced_year: i32,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct HousePoints {
    pub house: Option<String>,
    pub total_points: Option<i64>,
    pub member_count: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct OpenVoiceSession {
    pub discord_id: String,
    pub username: String,
    pub channel_id: String,
    pub channel_name: String,
    pub joined_at: NaiveDateTime,
}

// ─── Domain types ──────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct VoiceSessionInput {
    pub discord_id: String,
    pub username: String,
    pub channel_id: Option<String>,
    pub channel_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CountingState {
    pub count: i32,
    pub discord_id: Option<String>,
}

/// Aggregated point sums for integrity checks
#[derive(Debug, Default, Clone)]
pub struct Sums {
    pub total: i32,
    pub monthly: i32,
    pub daily: i32,
}
