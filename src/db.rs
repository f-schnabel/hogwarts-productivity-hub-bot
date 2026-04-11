use anyhow::{anyhow, Context as _};
use chrono::{DateTime, Utc};
use sqlx::{PgPool, Postgres, Transaction};

use crate::constants::{
    SETTINGS_KEY_COUNTING_COUNT, SETTINGS_KEY_COUNTING_DISCORD_ID,
    SETTINGS_KEY_LAST_MONTHLY_RESET, SETTINGS_KEY_VC_EMOJI,
};
use crate::models::*;

// ─── Pool setup ────────────────────────────────────────────────────────────

pub async fn create_pool(database_url: &str) -> anyhow::Result<PgPool> {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(10)
        .connect(database_url)
        .await
        .context("Failed to connect to PostgreSQL")?;
    Ok(pool)
}

pub async fn run_migrations(pool: &PgPool) -> anyhow::Result<()> {
    sqlx::migrate!("./migrations")
        .run(pool)
        .await
        .context("Failed to run database migrations")?;
    Ok(())
}

// ─── User helpers ──────────────────────────────────────────────────────────

pub async fn ensure_user_exists(
    pool: &PgPool,
    discord_id: &str,
    username: &str,
    house: Option<&str>,
) -> anyhow::Result<()> {
    sqlx::query!(
        r#"
        INSERT INTO "user" (discord_id, username, house)
        VALUES ($1, $2, $3)
        ON CONFLICT (discord_id) DO UPDATE
            SET username = EXCLUDED.username,
                house    = COALESCE(EXCLUDED.house, "user".house),
                updated_at = NOW()
        "#,
        discord_id,
        username,
        house,
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_user(pool: &PgPool, discord_id: &str) -> anyhow::Result<Option<User>> {
    let user = sqlx::query_as!(
        User,
        r#"SELECT * FROM "user" WHERE discord_id = $1"#,
        discord_id
    )
    .fetch_optional(pool)
    .await?;
    Ok(user)
}

pub async fn get_user_timezone(pool: &PgPool, discord_id: &str) -> anyhow::Result<String> {
    let row = sqlx::query!(
        r#"SELECT timezone FROM "user" WHERE discord_id = $1"#,
        discord_id
    )
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| r.timezone).unwrap_or_else(|| "UTC".into()))
}

pub async fn get_all_users(pool: &PgPool) -> anyhow::Result<Vec<User>> {
    let users = sqlx::query_as!(User, r#"SELECT * FROM "user""#)
        .fetch_all(pool)
        .await?;
    Ok(users)
}

pub async fn update_user_timezone(
    pool: &PgPool,
    discord_id: &str,
    timezone: &str,
) -> anyhow::Result<u64> {
    let result = sqlx::query!(
        r#"UPDATE "user" SET timezone = $1, updated_at = NOW() WHERE discord_id = $2"#,
        timezone,
        discord_id
    )
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

// ─── Voice session helpers ─────────────────────────────────────────────────

pub async fn get_open_voice_sessions(
    pool: &PgPool,
    filter_discord_ids: Option<&[String]>,
) -> anyhow::Result<Vec<OpenVoiceSession>> {
    if let Some(ids) = filter_discord_ids {
        let rows = sqlx::query_as!(
            OpenVoiceSession,
            r#"
            SELECT vs.discord_id, u.username, vs.channel_id, vs.channel_name, vs.joined_at
            FROM voice_session vs
            JOIN "user" u ON u.discord_id = vs.discord_id
            WHERE vs.left_at IS NULL
              AND vs.discord_id = ANY($1)
            "#,
            ids
        )
        .fetch_all(pool)
        .await?;
        Ok(rows)
    } else {
        let rows = sqlx::query_as!(
            OpenVoiceSession,
            r#"
            SELECT vs.discord_id, u.username, vs.channel_id, vs.channel_name, vs.joined_at
            FROM voice_session vs
            JOIN "user" u ON u.discord_id = vs.discord_id
            WHERE vs.left_at IS NULL
            "#
        )
        .fetch_all(pool)
        .await?;
        Ok(rows)
    }
}

pub async fn get_open_voice_sessions_tx<'c>(
    tx: &mut Transaction<'c, Postgres>,
    filter_discord_ids: Option<&[String]>,
) -> anyhow::Result<Vec<OpenVoiceSession>> {
    if let Some(ids) = filter_discord_ids {
        let rows = sqlx::query_as!(
            OpenVoiceSession,
            r#"
            SELECT vs.discord_id, u.username, vs.channel_id, vs.channel_name, vs.joined_at
            FROM voice_session vs
            JOIN "user" u ON u.discord_id = vs.discord_id
            WHERE vs.left_at IS NULL
              AND vs.discord_id = ANY($1)
            "#,
            ids
        )
        .fetch_all(&mut **tx)
        .await?;
        Ok(rows)
    } else {
        let rows = sqlx::query_as!(
            OpenVoiceSession,
            r#"
            SELECT vs.discord_id, u.username, vs.channel_id, vs.channel_name, vs.joined_at
            FROM voice_session vs
            JOIN "user" u ON u.discord_id = vs.discord_id
            WHERE vs.left_at IS NULL
            "#
        )
        .fetch_all(&mut **tx)
        .await?;
        Ok(rows)
    }
}

// ─── Settings helpers ──────────────────────────────────────────────────────

pub async fn get_setting(pool: &PgPool, key: &str) -> anyhow::Result<Option<String>> {
    let row = sqlx::query!(
        "SELECT value FROM settings WHERE key = $1",
        key
    )
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| r.value))
}

pub async fn set_setting(pool: &PgPool, key: &str, value: &str) -> anyhow::Result<()> {
    sqlx::query!(
        "INSERT INTO settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        key,
        value
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn set_setting_tx<'c>(
    tx: &mut Transaction<'c, Postgres>,
    key: &str,
    value: &str,
) -> anyhow::Result<()> {
    sqlx::query!(
        "INSERT INTO settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        key,
        value
    )
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub async fn get_month_start_date(pool: &PgPool) -> anyhow::Result<DateTime<Utc>> {
    match get_setting(pool, SETTINGS_KEY_LAST_MONTHLY_RESET).await? {
        Some(s) => s
            .parse::<DateTime<Utc>>()
            .map_err(|e| anyhow!("Invalid month start date in settings: {e}")),
        None => Ok(start_of_current_month()),
    }
}

pub fn start_of_current_month() -> DateTime<Utc> {
    use chrono::Datelike;
    let now = Utc::now();
    let naive = chrono::NaiveDate::from_ymd_opt(now.year(), now.month(), 1)
        .unwrap_or_else(|| now.date_naive())
        .and_hms_opt(0, 0, 0)
        .unwrap();
    DateTime::<Utc>::from_naive_utc_and_offset(naive, Utc)
}

pub async fn set_month_start_date(pool: &PgPool, date: DateTime<Utc>) -> anyhow::Result<()> {
    set_setting(pool, SETTINGS_KEY_LAST_MONTHLY_RESET, &date.to_rfc3339()).await
}

pub async fn set_month_start_date_tx<'c>(
    tx: &mut Transaction<'c, Postgres>,
    date: DateTime<Utc>,
) -> anyhow::Result<()> {
    set_setting_tx(tx, SETTINGS_KEY_LAST_MONTHLY_RESET, &date.to_rfc3339()).await
}

pub async fn get_vc_emoji(pool: &PgPool) -> anyhow::Result<String> {
    Ok(get_setting(pool, SETTINGS_KEY_VC_EMOJI)
        .await?
        .unwrap_or_else(|| "🎆".into()))
}

pub async fn set_vc_emoji(pool: &PgPool, emoji: &str) -> anyhow::Result<()> {
    set_setting(pool, SETTINGS_KEY_VC_EMOJI, emoji).await
}

pub async fn get_counting_state(pool: &PgPool) -> anyhow::Result<CountingState> {
    let count_str = get_setting(pool, SETTINGS_KEY_COUNTING_COUNT)
        .await?
        .unwrap_or_default();
    let discord_id = get_setting(pool, SETTINGS_KEY_COUNTING_DISCORD_ID).await?;
    let count = count_str.parse::<i32>().unwrap_or(0);
    Ok(CountingState { count, discord_id })
}

pub async fn set_counting_state(pool: &PgPool, state: &CountingState) -> anyhow::Result<()> {
    set_setting(pool, SETTINGS_KEY_COUNTING_COUNT, &state.count.to_string()).await?;
    set_setting(
        pool,
        SETTINGS_KEY_COUNTING_DISCORD_ID,
        state.discord_id.as_deref().unwrap_or(""),
    )
    .await?;
    Ok(())
}

pub async fn get_counting_state_tx<'c>(
    tx: &mut Transaction<'c, Postgres>,
) -> anyhow::Result<CountingState> {
    let count_row = sqlx::query!(
        "SELECT value FROM settings WHERE key = $1 FOR NO KEY UPDATE",
        SETTINGS_KEY_COUNTING_COUNT
    )
    .fetch_optional(&mut **tx)
    .await?;
    let discord_id_row = sqlx::query!(
        "SELECT value FROM settings WHERE key = $1 FOR NO KEY UPDATE",
        SETTINGS_KEY_COUNTING_DISCORD_ID
    )
    .fetch_optional(&mut **tx)
    .await?;
    let count = count_row
        .and_then(|r| r.value.parse::<i32>().ok())
        .unwrap_or(0);
    let discord_id = discord_id_row.map(|r| r.value).filter(|s| !s.is_empty());
    Ok(CountingState { count, discord_id })
}

pub async fn set_counting_state_tx<'c>(
    tx: &mut Transaction<'c, Postgres>,
    state: &CountingState,
) -> anyhow::Result<()> {
    sqlx::query!(
        "INSERT INTO settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        SETTINGS_KEY_COUNTING_COUNT,
        &state.count.to_string()
    )
    .execute(&mut **tx)
    .await?;
    sqlx::query!(
        "INSERT INTO settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        SETTINGS_KEY_COUNTING_DISCORD_ID,
        state.discord_id.as_deref().unwrap_or("")
    )
    .execute(&mut **tx)
    .await?;
    Ok(())
}

// ─── House points ──────────────────────────────────────────────────────────

pub async fn get_weighted_house_points(pool: &PgPool) -> anyhow::Result<Vec<HousePoints>> {
    let rows = sqlx::query_as!(
        HousePoints,
        r#"
        SELECT house,
               SUM(monthly_points) / COUNT(*)  AS total_points,
               COUNT(*)                         AS "member_count!: i64"
        FROM "user"
        WHERE house IS NOT NULL
          AND monthly_points > $1
        GROUP BY house
        ORDER BY total_points DESC
        "#,
        crate::constants::MIN_MONTHLY_POINTS_FOR_WEIGHTED
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn get_unweighted_house_points(pool: &PgPool) -> anyhow::Result<Vec<HousePoints>> {
    let rows = sqlx::query_as!(
        HousePoints,
        r#"
        SELECT house,
               SUM(monthly_points)::BIGINT AS total_points,
               COUNT(*)                    AS "member_count!: i64"
        FROM "user"
        WHERE house IS NOT NULL
          AND monthly_points > 0
        GROUP BY house
        ORDER BY total_points DESC
        "#,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn get_weighted_house_points_tx<'c>(
    tx: &mut Transaction<'c, Postgres>,
) -> anyhow::Result<Vec<HousePoints>> {
    let rows = sqlx::query_as!(
        HousePoints,
        r#"
        SELECT house,
               SUM(monthly_points) / COUNT(*)  AS total_points,
               COUNT(*)                         AS "member_count!: i64"
        FROM "user"
        WHERE house IS NOT NULL
          AND monthly_points > $1
        GROUP BY house
        ORDER BY total_points DESC
        "#,
        crate::constants::MIN_MONTHLY_POINTS_FOR_WEIGHTED
    )
    .fetch_all(&mut **tx)
    .await?;
    Ok(rows)
}

pub async fn get_unweighted_house_points_tx<'c>(
    tx: &mut Transaction<'c, Postgres>,
) -> anyhow::Result<Vec<HousePoints>> {
    let rows = sqlx::query_as!(
        HousePoints,
        r#"
        SELECT house,
               SUM(monthly_points)::BIGINT AS total_points,
               COUNT(*)                    AS "member_count!: i64"
        FROM "user"
        WHERE house IS NOT NULL
          AND monthly_points > 0
        GROUP BY house
        ORDER BY total_points DESC
        "#,
    )
    .fetch_all(&mut **tx)
    .await?;
    Ok(rows)
}

// ─── Scoreboards ───────────────────────────────────────────────────────────

pub async fn get_scoreboards_for_house(
    pool: &PgPool,
    house: &str,
) -> anyhow::Result<Vec<HouseScoreboard>> {
    let rows = sqlx::query_as!(
        HouseScoreboard,
        "SELECT * FROM house_scoreboard WHERE house = $1",
        house
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn get_all_scoreboards(pool: &PgPool) -> anyhow::Result<Vec<HouseScoreboard>> {
    let rows = sqlx::query_as!(HouseScoreboard, "SELECT * FROM house_scoreboard")
        .fetch_all(pool)
        .await?;
    Ok(rows)
}

pub async fn delete_scoreboards(pool: &PgPool, ids: &[i32]) -> anyhow::Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    sqlx::query!("DELETE FROM house_scoreboard WHERE id = ANY($1)", ids)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn get_leaderboard_for_house(
    pool: &PgPool,
    house: &str,
) -> anyhow::Result<Vec<User>> {
    let rows = sqlx::query_as!(
        User,
        r#"
        SELECT * FROM "user"
        WHERE house = $1 AND monthly_points > 0
        ORDER BY monthly_points DESC
        "#,
        house
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

// ─── Submissions ───────────────────────────────────────────────────────────

pub async fn get_submission_by_message_id(
    pool: &PgPool,
    message_id: &str,
) -> anyhow::Result<Option<Submission>> {
    let row = sqlx::query_as!(
        Submission,
        "SELECT * FROM submission WHERE message_id = $1",
        message_id
    )
    .fetch_optional(pool)
    .await?;
    Ok(row)
}
