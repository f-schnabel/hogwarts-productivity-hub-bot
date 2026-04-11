use std::sync::Arc;

use chrono::Utc;
use chrono_tz::Tz;
use serenity::all::GuildId;
use sqlx::PgPool;
use tokio_cron_scheduler::{Job, JobScheduler};
use tracing::{debug, info, warn};

use crate::config::Config;
use crate::constants::MIN_DAILY_MESSAGES_FOR_STREAK;
use crate::metrics::RESET_TIMER;

pub async fn start(pool: Arc<PgPool>, config: Arc<Config>, http: Arc<serenity::http::Http>, cache: Arc<serenity::cache::Cache>) -> anyhow::Result<JobScheduler> {
    let sched = JobScheduler::new().await?;

    let pool_c = pool.clone();
    let config_c = config.clone();
    let http_c = http.clone();
    let cache_c = cache.clone();

    // Hourly daily reset check: 6-field cron (sec min hr dom mon dow)
    sched.add(Job::new_async("0 0 * * * *", move |_id, _sched| {
        let pool = pool_c.clone();
        let config = config_c.clone();
        let http = http_c.clone();
        let cache = cache_c.clone();
        Box::pin(async move {
            if let Err(e) = process_daily_resets(&pool, &config, &http, &cache).await {
                warn!("Daily reset error: {e}");
            }
        })
    })?).await?;

    sched.start().await?;
    debug!("CentralResetService started");
    Ok(sched)
}

pub async fn process_daily_resets(
    pool: &PgPool,
    config: &Config,
    http: &serenity::http::Http,
    cache: &serenity::cache::Cache,
) -> anyhow::Result<()> {
    let timer = RESET_TIMER
        .get_metric_with_label_values(&["daily"])
        .ok();
    let start = std::time::Instant::now();

    let guild_id = GuildId::new(config.guild_id);

    // Get all users from DB
    let all_users = sqlx::query!(
        r#"SELECT discord_id, timezone, last_daily_reset FROM "user""#
    )
    .fetch_all(pool)
    .await?;

    let now_utc = Utc::now();

    // Filter users who need reset: still in guild AND past their local midnight
    let mut users_needing_reset: Vec<String> = Vec::new();
    for user in &all_users {
        // Check if member is still in the guild (cache check)
        let user_id = serenity::all::UserId::new(
            user.discord_id.parse::<u64>().unwrap_or(0)
        );
        let member_in_guild = cache.guild(guild_id)
            .map(|g| g.members.contains_key(&user_id))
            .unwrap_or(false);
        if !member_in_guild {
            continue;
        }

        let tz: Tz = user.timezone.parse().unwrap_or(chrono_tz::UTC);
        let user_local = now_utc.with_timezone(&tz);
        let last_reset_local = user.last_daily_reset.and_utc().with_timezone(&tz);

        if user_local.date_naive() != last_reset_local.date_naive() {
            users_needing_reset.push(user.discord_id.clone());
        }
    }

    if users_needing_reset.is_empty() {
        debug!("Daily reset: no users need reset");
        if let Some(t) = timer {
            t.observe(start.elapsed().as_secs_f64());
        }
        return Ok(());
    }

    // Get open voice sessions for users needing reset
    let open_sessions = crate::db::get_open_voice_sessions(pool, Some(&users_needing_reset)).await?;
    info!(
        total = users_needing_reset.len(),
        in_voice = open_sessions.len(),
        "Daily reset: users identified"
    );

    // Close voice sessions
    for session in &open_sessions {
        let sess_input = crate::models::VoiceSessionInput {
            discord_id: session.discord_id.clone(),
            username: session.username.clone(),
            channel_id: Some(session.channel_id.clone()),
            channel_name: Some(session.channel_name.clone()),
        };
        if let Err(e) = crate::bot::utils::voice::end_voice_session(pool, &sess_input).await {
            warn!("Failed to end voice session for {} during reset: {e}", session.discord_id);
        }
    }

    // Determine boosters (members with premiumSince set)
    let booster_ids: Vec<String> = {
        let users_set: std::collections::HashSet<&str> =
            users_needing_reset.iter().map(String::as_str).collect();
        cache
            .guild(guild_id)
            .map(|g| {
                g.members
                    .values()
                    .filter(|m| {
                        m.premium_since.is_some() && users_set.contains(m.user.id.get().to_string().as_str())
                    })
                    .map(|m| m.user.id.get().to_string())
                    .collect()
            })
            .unwrap_or_default()
    };

    if !booster_ids.is_empty() {
        debug!("Boosters preserving streak: {}", booster_ids.len());
    }

    // Perform the reset update
    let updated = sqlx::query!(
        r#"
        UPDATE "user"
        SET daily_points     = 0,
            daily_voice_time = 0,
            daily_messages   = 0,
            last_daily_reset = NOW(),
            updated_at       = NOW(),
            message_streak   = CASE
              WHEN daily_messages >= $1
                THEN message_streak + 1
              WHEN discord_id = ANY($2)
                THEN message_streak
              ELSE 0
            END
        WHERE discord_id = ANY($3)
        RETURNING discord_id, message_streak
        "#,
        MIN_DAILY_MESSAGES_FOR_STREAK,
        &booster_ids as &Vec<String>,
        &users_needing_reset,
    )
    .fetch_all(pool)
    .await?;

    // Reopen voice sessions that were closed
    for session in &open_sessions {
        let sess_input = crate::models::VoiceSessionInput {
            discord_id: session.discord_id.clone(),
            username: session.username.clone(),
            channel_id: Some(session.channel_id.clone()),
            channel_name: Some(session.channel_name.clone()),
        };
        if let Err(e) = crate::bot::utils::voice::start_voice_session(pool, &sess_input).await {
            warn!("Failed to reopen voice session for {} after reset: {e}", session.discord_id);
        }
    }

    // Update streak nicknames
    for row in &updated {
        let user_id = match row.discord_id.parse::<u64>() {
            Ok(id) => serenity::all::UserId::new(id),
            Err(_) => continue,
        };
        let member = cache.guild(guild_id)
            .and_then(|g| g.members.get(&user_id).cloned());
        if let Some(member) = member {
            if let Err(e) = crate::bot::utils::nickname::update_message_streak_in_nickname(
                http,
                &member,
                config,
                row.message_streak,
            )
            .await
            {
                warn!("Failed to update nickname for {}: {e}", row.discord_id);
            }
        }
    }

    let elapsed_ms = start.elapsed().as_millis();
    if let Some(t) = timer {
        t.observe(start.elapsed().as_secs_f64());
    }
    info!(users_reset = updated.len(), ms = elapsed_ms, "Daily reset complete");
    Ok(())
}
