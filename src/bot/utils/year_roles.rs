use serenity::all::{
    ChannelId, CreateEmbed, CreateMessage, GuildId, Member, RoleId,
};
use sqlx::PgPool;
use tracing::{debug, error};

use crate::config::Config;
use crate::constants::{YEAR_MESSAGES, YEAR_THRESHOLDS_HOURS, get_house_color};
use crate::models::UserVoiceInfo;

/// Convert monthly voice time (seconds) → year rank 1–7, or None if < 1h.
pub fn get_year_from_monthly_voice_time(seconds: i32) -> Option<u8> {
    let hours = seconds as f64 / 3600.0;
    for year in (1u8..=7).rev() {
        let threshold = YEAR_THRESHOLDS_HOURS[(year - 1) as usize] as f64;
        if hours >= threshold {
            return Some(year);
        }
    }
    None
}

/// Compute which year roles to add and remove for a member.
/// Returns `None` if the user has no house or year roles are not configured.
pub fn calculate_year_roles(
    member: &Member,
    user_info: &UserVoiceInfo,
    config: &Config,
) -> Option<(Vec<RoleId>, Vec<RoleId>)> {
    if user_info.house.is_none() {
        return None;
    }
    if config.year_role_ids.len() != 7 {
        return None;
    }

    let year = get_year_from_monthly_voice_time(user_info.monthly_voice_time);
    let target_role_id: Option<RoleId> = year.map(|y| RoleId::new(config.year_role_ids[(y - 1) as usize]));

    let all_year_roles: Vec<RoleId> = config
        .year_role_ids
        .iter()
        .map(|&id| RoleId::new(id))
        .collect();

    let roles_to_remove: Vec<RoleId> = all_year_roles
        .iter()
        .filter(|r| Some(**r) != target_role_id && member.roles.contains(r))
        .cloned()
        .collect();

    let roles_to_add: Vec<RoleId> = match target_role_id {
        Some(rid) if !member.roles.contains(&rid) => vec![rid],
        _ => vec![],
    };

    Some((roles_to_add, roles_to_remove))
}

/// Send the year-promotion announcement message if the user advanced to a new year.
pub async fn announce_year_promotion(
    http: &serenity::http::Http,
    member: &Member,
    user_info: &UserVoiceInfo,
    config: &Config,
) {
    let house = match &user_info.house {
        Some(h) => h.as_str(),
        None => return,
    };

    let year = match get_year_from_monthly_voice_time(user_info.monthly_voice_time) {
        Some(y) => y,
        None => return,
    };

    if user_info.announced_year >= year as i32 {
        return; // Already announced this year or higher
    }

    if config.year_announcement_channel_id == 0 {
        return;
    }

    let role_id = match config.year_role_ids.get((year - 1) as usize) {
        Some(&id) => id,
        None => return,
    };

    let hours = YEAR_THRESHOLDS_HOURS[(year - 1) as usize];
    let hours_str = if hours == 1 {
        "1 hour".to_string()
    } else {
        format!("{hours} hours")
    };

    let template = YEAR_MESSAGES
        .iter()
        .find(|(h, _)| *h == house)
        .map(|(_, msg)| *msg)
        .unwrap_or("{ROLE} after **{HOURS}**.");

    let description = template
        .replace("{ROLE}", &format!("<@&{role_id}>"))
        .replace("{HOURS}", &hours_str);

    let channel_id = ChannelId::new(config.year_announcement_channel_id);

    let result = channel_id
        .send_message(
            http,
            CreateMessage::new()
                .content(format!("Congratulations {}!", member.mention()))
                .embed(
                    CreateEmbed::new()
                        .title("New Activity Rank Attained!")
                        .description(description)
                        .color(get_house_color(house)),
                ),
        )
        .await;

    if let Err(e) = result {
        error!(
            "Failed to send year promotion for {}: {e}",
            member.user.name
        );
        return;
    }

    // Update announced_year in DB
    // We don't have the pool here, so callers should update announced_year.
}

/// Update announced_year in the database.
pub async fn update_announced_year(
    pool: &PgPool,
    discord_id: &str,
    year: i32,
) -> anyhow::Result<()> {
    sqlx::query!(
        r#"UPDATE "user" SET announced_year = $1, updated_at = NOW() WHERE discord_id = $2"#,
        year,
        discord_id
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Refresh year roles for all users in the guild.
pub async fn refresh_all_year_roles(
    pool: &PgPool,
    http: &serenity::http::Http,
    cache: &serenity::cache::Cache,
    guild_id: GuildId,
    config: &Config,
) -> anyhow::Result<usize> {
    if config.year_role_ids.len() != 7 {
        return Ok(0);
    }

    let users = sqlx::query!(
        r#"SELECT discord_id, monthly_voice_time, house FROM "user" WHERE house IS NOT NULL"#
    )
    .fetch_all(pool)
    .await?;

    let mut updated = 0usize;

    for user in &users {
        let user_id = match user.discord_id.parse::<u64>() {
            Ok(id) => serenity::all::UserId::new(id),
            Err(_) => continue,
        };

        let member = match cache.member(guild_id, user_id) {
            Some(m) => m,
            None => continue,
        };

        let info = UserVoiceInfo {
            daily_voice_time: 0,
            monthly_voice_time: user.monthly_voice_time,
            house: user.house.clone(),
            announced_year: 0,
        };

        if let Some((to_add, to_remove)) = calculate_year_roles(&member, &info, config) {
            if to_add.is_empty() && to_remove.is_empty() {
                continue;
            }
            let new_roles: Vec<RoleId> = member
                .roles
                .iter()
                .filter(|r| !to_remove.contains(r))
                .cloned()
                .chain(to_add.iter().cloned())
                .collect();

            if let Err(e) = guild_id
                .edit_member(
                    http,
                    user_id,
                    serenity::all::EditMember::new()
                        .roles(new_roles)
                        .audit_log_reason("Refreshing year roles"),
                )
                .await
            {
                debug!("Failed to refresh year role for {}: {e}", user.discord_id);
            } else {
                updated += 1;
            }
        }
    }

    Ok(updated)
}
