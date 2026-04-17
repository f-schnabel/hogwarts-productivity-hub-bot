use sqlx::PgPool;
use tracing::{debug, error, info, warn};

use crate::models::VoiceSessionInput;
use crate::services::points::{calculate_points};

/// Start a new voice session for a user.
/// If an open session already exists, it is closed without tracking first.
pub async fn start_voice_session(pool: &PgPool, session: &VoiceSessionInput) -> anyhow::Result<()> {
    let channel_id = match &session.channel_id {
        Some(id) => id.clone(),
        None => return Ok(()),
    };
    let channel_name = match &session.channel_name {
        Some(n) => n.clone(),
        None => return Ok(()),
    };

    let ctx = format!("user={} channel={}", session.discord_id, channel_name);

    // Check for existing open sessions
    let existing: Vec<i32> = sqlx::query_scalar!(
        "SELECT id FROM voice_session WHERE discord_id = $1 AND left_at IS NULL",
        session.discord_id
    )
    .fetch_all(pool)
    .await?;

    if !existing.is_empty() {
        warn!("{ctx}: existing open session(s) found ({}), closing", existing.len());
        // Close them without tracking
        sqlx::query!(
            "UPDATE voice_session SET left_at = NOW(), is_tracked = false WHERE discord_id = $1 AND left_at IS NULL",
            session.discord_id
        )
        .execute(pool)
        .await?;
    }

    sqlx::query!(
        "INSERT INTO voice_session (discord_id, channel_id, channel_name) VALUES ($1, $2, $3)",
        session.discord_id,
        channel_id,
        channel_name,
    )
    .execute(pool)
    .await?;

    info!("{ctx}: session started");
    Ok(())
}

/// Close an open voice session without awarding points.
pub async fn close_voice_session_untracked(
    pool: &PgPool,
    session: &VoiceSessionInput,
) -> anyhow::Result<()> {
    let channel_id = match &session.channel_id {
        Some(id) => id.clone(),
        None => return Ok(()),
    };

    sqlx::query!(
        r#"
        UPDATE voice_session
        SET left_at = NOW(), is_tracked = false
        WHERE discord_id = $1
          AND channel_id = ANY(ARRAY[$2, 'unknown'])
          AND left_at IS NULL
        "#,
        session.discord_id,
        channel_id,
    )
    .execute(pool)
    .await?;

    debug!("session closed (untracked): user={}", session.discord_id);
    Ok(())
}

/// End a voice session and award points based on the session duration.
/// Returns `(old_daily_voice_time, new_daily_voice_time, house, announced_year)`.
pub async fn end_voice_session(
    pool: &PgPool,
    session: &VoiceSessionInput,
) -> anyhow::Result<Option<crate::models::UserVoiceInfo>> {
    let channel_id = match &session.channel_id {
        Some(id) => id.clone(),
        None => return Ok(None),
    };

    let ctx = format!(
        "user={} channel={}",
        session.discord_id,
        session.channel_name.as_deref().unwrap_or("?")
    );

    let mut tx = pool.begin().await?;

    // Lock the session row
    let session_id: Option<i32> = sqlx::query_scalar!(
        r#"
        SELECT id FROM voice_session
        WHERE discord_id = $1
          AND channel_id = ANY(ARRAY[$2::TEXT, 'unknown'])
          AND left_at IS NULL
        FOR NO KEY UPDATE
        "#,
        session.discord_id,
        channel_id,
    )
    .fetch_optional(&mut *tx)
    .await?;

    let session_id = match session_id {
        Some(id) => id,
        None => {
            error!("{ctx}: no open session found to end");
            tx.rollback().await?;
            return Ok(None);
        }
    };

    // Close the session and get its duration
    let duration: Option<i32> = sqlx::query_scalar!(
        r#"
        UPDATE voice_session
        SET left_at = NOW(), is_tracked = true
        WHERE id = $1
        RETURNING duration
        "#,
        session_id,
    )
    .fetch_one(&mut *tx)
    .await?;

    let duration = duration.unwrap_or(0);

    // Update user's voice time and retrieve old/new values
    let user_row = sqlx::query!(
        r#"
        UPDATE "user"
        SET daily_voice_time   = daily_voice_time   + $1,
            monthly_voice_time = monthly_voice_time + $1,
            total_voice_time   = total_voice_time   + $1,
            updated_at         = NOW()
        WHERE discord_id = $2
        RETURNING daily_voice_time, monthly_voice_time, house, announced_year
        "#,
        duration,
        session.discord_id,
    )
    .fetch_optional(&mut *tx)
    .await?;

    let user_row = match user_row {
        Some(r) => r,
        None => {
            error!("{ctx}: user not found in DB");
            tx.rollback().await?;
            return Ok(None);
        }
    };

    let old_daily = user_row.daily_voice_time - duration;
    let new_daily = user_row.daily_voice_time;
    let points_earned = calculate_points(old_daily, new_daily);

    info!(
        "{ctx}: session ended, duration={}, points={}, old_daily={}, new_daily={}",
        crate::bot::utils::interaction::format_duration(duration),
        points_earned,
        crate::bot::utils::interaction::format_duration(old_daily),
        crate::bot::utils::interaction::format_duration(new_daily),
    );

    // Award points (inside the transaction via a direct query)
    if points_earned > 0 {
        sqlx::query!(
            r#"
            UPDATE "user"
            SET daily_points   = daily_points   + $1,
                monthly_points = monthly_points + $1,
                total_points   = total_points   + $1,
                updated_at     = NOW()
            WHERE discord_id = $2
            "#,
            points_earned,
            session.discord_id,
        )
        .execute(&mut *tx)
        .await?;
    }

    // Record points on session
    sqlx::query!(
        "UPDATE voice_session SET points = $1 WHERE id = $2",
        points_earned,
        session_id,
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    // Trigger scoreboard refresh (fire-and-forget)
    if let Some(ref house) = user_row.house {
        let pool = pool.clone();
        let house = house.clone();
        tokio::spawn(async move {
            if let Err(e) =
                crate::bot::utils::scoreboard::refresh_house_scoreboards(&pool, &house).await
            {
                warn!("Scoreboard refresh failed: {e}");
            }
        });
    }

    Ok(Some(crate::models::UserVoiceInfo {
        daily_voice_time: user_row.daily_voice_time,
        monthly_voice_time: user_row.monthly_voice_time,
        house: user_row.house,
        announced_year: user_row.announced_year,
    }))
}
