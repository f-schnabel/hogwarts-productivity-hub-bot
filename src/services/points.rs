use anyhow::Context as _;
use chrono::NaiveDateTime;
use sqlx::PgPool;

use crate::constants::{FIRST_HOUR_POINTS, MAX_HOURS_PER_DAY, REST_HOURS_POINTS};
use crate::db::{get_month_start_date};

// ─── Points calculation ────────────────────────────────────────────────────

/// Pure calculation: given cumulative daily voice time in seconds, how many
/// points has the user earned today?
///
/// - First hour: 5 points (with 5-min grace period)
/// - Subsequent hours: 2 points each, capped at 12 h/day
pub fn calculate_points_helper(voice_time_secs: i32) -> i32 {
    const ONE_HOUR: i32 = 3600;
    const FIVE_MINUTES: i32 = 5 * 60;

    // 5-minute grace period
    let voice_time = voice_time_secs + FIVE_MINUTES;
    let hours = voice_time / ONE_HOUR;

    if hours < 1 {
        return 0;
    }

    let mut points = FIRST_HOUR_POINTS;
    if hours >= 2 {
        let extra_hours = (hours.min(MAX_HOURS_PER_DAY) - 1) as i32;
        points += REST_HOURS_POINTS * extra_hours;
    }
    points
}

/// Differential: how many additional points for going from `old` to `new`
/// daily voice seconds.
pub fn calculate_points(old_daily_secs: i32, new_daily_secs: i32) -> i32 {
    calculate_points_helper(new_daily_secs) - calculate_points_helper(old_daily_secs)
}

// ─── Database operations ───────────────────────────────────────────────────

/// Award points to a user (daily + monthly + total) and trigger scoreboard refresh.
/// Returns the user's house (needed for scoreboard refresh).
pub async fn award_points(pool: &PgPool, discord_id: &str, points: i32) -> anyhow::Result<()> {
    let row = sqlx::query!(
        r#"
        UPDATE "user"
        SET daily_points   = daily_points   + $1,
            monthly_points = monthly_points + $1,
            total_points   = total_points   + $1,
            updated_at     = NOW()
        WHERE discord_id = $2
        RETURNING house
        "#,
        points,
        discord_id,
    )
    .fetch_optional(pool)
    .await
    .context("award_points UPDATE failed")?;

    if let Some(row) = row {
        if let Some(house) = row.house {
            // fire-and-forget scoreboard refresh (non-blocking)
            let pool = pool.clone();
            tokio::spawn(async move {
                if let Err(e) =
                    crate::bot::utils::scoreboard::refresh_house_scoreboards(&pool, &house).await
                {
                    tracing::warn!("Scoreboard refresh failed for {house}: {e}");
                }
            });
        }
    }
    Ok(())
}

/// Reverse points that were awarded when a submission was approved.
/// Only reverses daily/monthly if the review happened within the current window.
pub async fn reverse_submission_points(
    pool: &PgPool,
    discord_id: &str,
    points: i32,
    reviewed_at: NaiveDateTime,
) -> anyhow::Result<()> {
    let month_start = get_month_start_date(pool).await?;

    let row = sqlx::query!(
        r#"
        UPDATE "user"
        SET daily_points = CASE
              WHEN last_daily_reset <= $1 THEN daily_points - $2
              ELSE daily_points
            END,
            monthly_points = CASE
              WHEN $1 >= $3 THEN monthly_points - $2
              ELSE monthly_points
            END,
            total_points = total_points - $2,
            updated_at   = NOW()
        WHERE discord_id = $4
        RETURNING house
        "#,
        reviewed_at,
        points,
        month_start,
        discord_id,
    )
    .fetch_optional(pool)
    .await
    .context("reverse_submission_points UPDATE failed")?;

    if let Some(row) = row {
        if let Some(house) = row.house {
            let pool = pool.clone();
            tokio::spawn(async move {
                if let Err(e) =
                    crate::bot::utils::scoreboard::refresh_house_scoreboards(&pool, &house).await
                {
                    tracing::warn!("Scoreboard refresh failed for {house}: {e}");
                }
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_points_zero_for_less_than_hour() {
        assert_eq!(calculate_points_helper(0), 0);
        assert_eq!(calculate_points_helper(30 * 60), 0); // 30 min
        // 55 min + 5 min grace = 60 min = exactly 1h → 5 pts
        assert_eq!(calculate_points_helper(55 * 60), 5);
    }

    #[test]
    fn test_first_hour_gives_5_points() {
        assert_eq!(calculate_points_helper(3600), 5); // 1h
    }

    #[test]
    fn test_second_hour_gives_7_points() {
        assert_eq!(calculate_points_helper(7200), 7); // 2h = 5 + 2
    }

    #[test]
    fn test_capped_at_12_hours() {
        // 12h → 5 + (11 * 2) = 27
        assert_eq!(calculate_points_helper(12 * 3600), 27);
        // 15h → still 27 (capped)
        assert_eq!(calculate_points_helper(15 * 3600), 27);
    }

    #[test]
    fn test_differential() {
        // 0 → 3600: gained 5 pts
        assert_eq!(calculate_points(0, 3600), 5);
        // 3600 → 7200: gained 2 pts
        assert_eq!(calculate_points(3600, 7200), 2);
    }
}
