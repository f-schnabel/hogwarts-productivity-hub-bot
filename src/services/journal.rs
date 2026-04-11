use std::sync::Arc;

use chrono::Utc;
use sqlx::PgPool;
use tokio_cron_scheduler::{Job, JobScheduler};
use tracing::{debug, info, warn};

use crate::config::Config;

const JOURNAL_STATIC_LINES: &[&str] = &[
    "Sleep Rating: 0 (couldn't sleep) - 5 (good refreshing sleep)",
    "Mood rating: 😢 bad mood / 🫤  meh day / 😮‍💨  could have been better / 😊  happy mood",
    "Emotions: happy, excited, grateful, relaxed, content, tired, unsure, bored, anxious, sad, stressed (can be multiple)",
];

pub fn build_journal_message(prompt: &str) -> String {
    let mut lines = JOURNAL_STATIC_LINES.to_vec();
    lines.push(&format!("Prompt: {prompt}"));
    let body = lines.join("\n");
    format!("**Daily Journal Check-In**\n```\n{body}\n```")
}

pub fn get_journal_date_str() -> String {
    Utc::now().format("%Y-%m-%d").to_string()
}

pub async fn start(
    pool: Arc<PgPool>,
    config: Arc<Config>,
    http: Arc<serenity::http::Http>,
) -> anyhow::Result<JobScheduler> {
    let sched = JobScheduler::new().await?;

    let pool_c = pool.clone();
    let config_c = config.clone();
    let http_c = http.clone();

    // Daily at 15:30 UTC: "0 30 15 * * *" (sec min hr dom mon dow)
    sched.add(Job::new_async("0 30 15 * * *", move |_id, _sched| {
        let pool = pool_c.clone();
        let config = config_c.clone();
        let http = http_c.clone();
        Box::pin(async move {
            let date = get_journal_date_str();
            match process_journal_entry(&pool, &config, &http).await {
                Ok(result) => info!(result, date, "Journal dispatch complete"),
                Err(e) => warn!("Journal dispatch error: {e}"),
            }
        })
    })?).await?;

    sched.start().await?;
    debug!("JournalService started");
    Ok(sched)
}

pub async fn process_journal_entry(
    pool: &PgPool,
    config: &Config,
    http: &serenity::http::Http,
) -> anyhow::Result<&'static str> {
    let date = get_journal_date_str();

    let entry = sqlx::query!(
        "SELECT id, prompt, message_id FROM journal_entry WHERE date = $1 LIMIT 1",
        date
    )
    .fetch_optional(pool)
    .await?;

    let entry = match entry {
        None => {
            debug!(date, "No journal entry configured");
            return Ok("missing");
        }
        Some(e) => e,
    };

    if entry.message_id.is_some() {
        debug!(date, "Journal entry already sent");
        return Ok("already-sent");
    }

    let channel_id = config
        .journal_channel_id
        .ok_or_else(|| anyhow::anyhow!("JOURNAL_CHANNEL_ID is not configured"))?;

    let channel_id = serenity::all::ChannelId::new(channel_id);
    let content = build_journal_message(&entry.prompt);

    let msg = channel_id
        .send_message(http, serenity::all::CreateMessage::new().content(content))
        .await?;

    sqlx::query!(
        "UPDATE journal_entry SET message_id = $1, updated_at = NOW() WHERE id = $2",
        msg.id.get().to_string(),
        entry.id
    )
    .execute(pool)
    .await?;

    info!(date, message_id = %msg.id, "Journal entry sent");
    Ok("sent")
}
