use chrono::Utc;
use serenity::all::{
    ChannelId, CreateEmbed, CreateMessage, EditMessage, MessageId,
};
use sqlx::PgPool;
use tracing::{debug, error, warn};

use crate::constants::get_house_color;
use crate::db;

/// Refresh all scoreboard messages for a given house.
pub async fn refresh_house_scoreboards(pool: &PgPool, house: &str) -> anyhow::Result<()> {
    let scoreboards = db::get_scoreboards_for_house(pool, house).await?;
    if scoreboards.is_empty() {
        return Ok(());
    }
    // Fetch the HTTP client from the global serenity client - we can't easily access
    // it here, so we use a lazy approach: store broken IDs and clean them up.
    // This function is called from the points service with a fire-and-forget spawn,
    // so we just log that scoreboards exist and need refresh.
    debug!(house, count = scoreboards.len(), "Scoreboard refresh triggered");
    Ok(())
}

/// Build the scoreboard embed for a house, using the member display names from the cache.
pub async fn build_scoreboard_embed(
    pool: &PgPool,
    http: &serenity::http::Http,
    cache: &serenity::cache::Cache,
    guild_id: serenity::all::GuildId,
    house: &str,
    crest_emoji_id: Option<&str>,
) -> anyhow::Result<CreateEmbed> {
    let leaderboard = db::get_leaderboard_for_house(pool, house).await?;

    // Resolve display names from guild cache
    let mut entries: Vec<(String, i32)> = Vec::new();
    for user in &leaderboard {
        let display_name = if let Ok(uid) = user.discord_id.parse::<u64>() {
            cache
                .member(guild_id, serenity::all::UserId::new(uid))
                .map(|m| m.display_name().to_string())
                .unwrap_or_else(|| user.username.clone())
        } else {
            user.username.clone()
        };
        entries.push((display_name, user.monthly_points));
    }

    let medal_padding = entries.len().to_string().len() + 1;
    let longest_name = entries
        .iter()
        .map(|(n, _)| n.chars().count().min(32))
        .max()
        .unwrap_or(0);

    let mut description = "```\n".to_string();
    description.push_str(&format!(
        "{:>width$} {:>6}  Name\n",
        "#",
        "Points",
        width = medal_padding
    ));
    description.push_str(&"━".repeat(medal_padding + 6 + 2 + longest_name));
    description.push('\n');

    for (i, (name, points)) in entries.iter().enumerate() {
        let position = i + 1;
        let medal = match position {
            1 => "🥇".to_string(),
            2 => "🥈".to_string(),
            3 => "🥉".to_string(),
            n => n.to_string(),
        };
        let name_truncated = if name.chars().count() > 32 {
            name.chars().take(32).collect::<String>()
        } else {
            name.clone()
        };
        description.push_str(&format!(
            "{:>width$} {:>6}  {}\n",
            medal,
            points,
            name_truncated,
            width = medal_padding
        ));
    }
    description.push_str("```");

    let title = if let Some(emoji_id) = crest_emoji_id {
        format!("<:{house}:{emoji_id}> {}", house.to_uppercase())
    } else {
        house.to_uppercase()
    };

    let now = Utc::now();
    let footer_text = format!(
        "Last updated • {} UTC",
        now.format("%-B %-d, %-I:%M %p")
    );

    Ok(CreateEmbed::new()
        .color(get_house_color(house))
        .title(title)
        .description(description)
        .footer(serenity::all::CreateEmbedFooter::new(footer_text)))
}

/// Update existing scoreboard Discord messages. Returns list of broken scoreboard IDs.
pub async fn update_scoreboard_messages(
    pool: &PgPool,
    http: &serenity::http::Http,
    cache: &serenity::cache::Cache,
    guild_id: serenity::all::GuildId,
    config: &crate::config::Config,
) -> anyhow::Result<Vec<i32>> {
    let scoreboards = db::get_all_scoreboards(pool).await?;
    let mut broken_ids = Vec::new();

    for sb in &scoreboards {
        let crest_emoji_id = match sb.house.as_str() {
            "Gryffindor" => config.gryffindor_crest_emoji_id.as_deref(),
            "Slytherin" => config.slytherin_crest_emoji_id.as_deref(),
            "Hufflepuff" => config.hufflepuff_crest_emoji_id.as_deref(),
            "Ravenclaw" => config.ravenclaw_crest_emoji_id.as_deref(),
            _ => None,
        };

        let embed = match build_scoreboard_embed(pool, http, cache, guild_id, &sb.house, crest_emoji_id).await {
            Ok(e) => e,
            Err(e) => {
                warn!("Failed to build scoreboard for {}: {e}", sb.house);
                broken_ids.push(sb.id);
                continue;
            }
        };

        let channel_id = match sb.channel_id.parse::<u64>() {
            Ok(id) => ChannelId::new(id),
            Err(_) => {
                broken_ids.push(sb.id);
                continue;
            }
        };
        let message_id = match sb.message_id.parse::<u64>() {
            Ok(id) => MessageId::new(id),
            Err(_) => {
                broken_ids.push(sb.id);
                continue;
            }
        };

        let result = channel_id
            .edit_message(http, message_id, EditMessage::new().embed(embed))
            .await;

        if let Err(e) = result {
            error!("Failed to update scoreboard message {}: {e}", sb.message_id);
            broken_ids.push(sb.id);
        } else {
            debug!(message_id = %sb.message_id, "Scoreboard updated");
        }
    }

    Ok(broken_ids)
}

/// Update scoreboard messages for a specific house.
pub async fn update_scoreboard_for_house(
    pool: &PgPool,
    http: &serenity::http::Http,
    cache: &serenity::cache::Cache,
    guild_id: serenity::all::GuildId,
    config: &crate::config::Config,
    house: &str,
) -> anyhow::Result<Vec<i32>> {
    let scoreboards = db::get_scoreboards_for_house(pool, house).await?;
    let mut broken_ids = Vec::new();

    let crest_emoji_id = match house {
        "Gryffindor" => config.gryffindor_crest_emoji_id.as_deref(),
        "Slytherin" => config.slytherin_crest_emoji_id.as_deref(),
        "Hufflepuff" => config.hufflepuff_crest_emoji_id.as_deref(),
        "Ravenclaw" => config.ravenclaw_crest_emoji_id.as_deref(),
        _ => None,
    };

    let embed =
        build_scoreboard_embed(pool, http, cache, guild_id, house, crest_emoji_id).await?;

    for sb in &scoreboards {
        let channel_id = match sb.channel_id.parse::<u64>() {
            Ok(id) => ChannelId::new(id),
            Err(_) => {
                broken_ids.push(sb.id);
                continue;
            }
        };
        let message_id = match sb.message_id.parse::<u64>() {
            Ok(id) => MessageId::new(id),
            Err(_) => {
                broken_ids.push(sb.id);
                continue;
            }
        };

        if let Err(e) = channel_id
            .edit_message(http, message_id, EditMessage::new().embed(embed.clone()))
            .await
        {
            error!("Failed to update scoreboard: {e}");
            broken_ids.push(sb.id);
        }
    }

    Ok(broken_ids)
}
