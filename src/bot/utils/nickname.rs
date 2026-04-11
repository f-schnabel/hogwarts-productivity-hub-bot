use regex::Regex;
use serenity::all::{EditMember, GuildId, Member, UserId};
use sqlx::PgPool;
use tracing::debug;

use crate::config::Config;
use crate::constants::ROLE_PROFESSOR;

use super::roles::has_any_role;

/// Update the `⚡N` streak suffix in a member's nickname.
pub async fn update_message_streak_in_nickname(
    http: &serenity::http::Http,
    member: &Member,
    config: &Config,
    new_streak: i32,
) -> anyhow::Result<()> {
    // Can't update guild owner or professors
    if member.user.id.get() == member.guild_id.get() // owner check would need guild
        || has_any_role(member, config, ROLE_PROFESSOR)
    {
        return Ok(());
    }

    // If streak is 0 and no nickname, nothing to do
    if new_streak == 0 && member.nick.is_none() {
        return Ok(());
    }

    let current_display = member
        .nick
        .clone()
        .or_else(|| member.user.global_name.clone())
        .unwrap_or_else(|| member.user.name.clone());

    // Strip existing ⚡N pattern
    let streak_re = Regex::new(r"⚡\d+").unwrap();
    let stripped = streak_re.replace_all(&current_display, "").trim().to_string();

    let new_nickname = if new_streak == 0 {
        stripped.clone()
    } else if streak_re.is_match(&current_display) {
        // Replace existing streak
        streak_re
            .replace_all(&current_display, &format!("⚡{new_streak}"))
            .trim()
            .to_string()
    } else {
        // Append new streak
        format!("{stripped} ⚡{new_streak}")
    };

    if new_nickname.len() > 32 {
        debug!("Nickname too long for streak update: '{new_nickname}'");
        return Ok(());
    }

    let current_nick = member.nick.as_deref().unwrap_or("");
    if new_nickname == current_nick {
        return Ok(()); // No change needed
    }

    debug!(
        user = %member.user.name,
        from = current_nick,
        to = new_nickname,
        "Updating streak nickname"
    );

    member
        .guild_id
        .edit_member(http, member.user.id, EditMember::new().nickname(new_nickname))
        .await?;
    Ok(())
}

/// Returns the new nickname with the VC emoji appended, or None if no change needed.
pub async fn vc_emoji_needs_adding(
    http: &serenity::http::Http,
    member: &Member,
    config: &Config,
    pool: &PgPool,
) -> anyhow::Result<Option<String>> {
    if has_any_role(member, config, ROLE_PROFESSOR) {
        return Ok(None);
    }
    let emoji = crate::db::get_vc_emoji(pool).await?;
    Ok(vc_emoji_needs_adding_sync(member, config, &emoji))
}

pub fn vc_emoji_needs_adding_sync(
    member: &Member,
    config: &Config,
    emoji: &str,
) -> Option<String> {
    if has_any_role(member, config, ROLE_PROFESSOR) {
        return None;
    }
    let current = member
        .nick
        .clone()
        .or_else(|| member.user.global_name.clone())
        .unwrap_or_else(|| member.user.name.clone());

    if current.contains(&format!(" {emoji}")) {
        return None;
    }

    let new_nick = format!("{current} {emoji}");
    if new_nick.len() > 32 {
        debug!("Nickname too long to add VC emoji: '{new_nick}'");
        return None;
    }
    Some(new_nick)
}

/// Returns the new nickname with the VC emoji removed, or None if no change needed.
pub async fn vc_emoji_needs_removal(
    http: &serenity::http::Http,
    member: &Member,
    config: &Config,
    pool: &PgPool,
) -> anyhow::Result<Option<String>> {
    if has_any_role(member, config, ROLE_PROFESSOR) {
        return Ok(None);
    }
    let emoji = crate::db::get_vc_emoji(pool).await?;
    Ok(vc_emoji_needs_removal_sync(member, config, &emoji))
}

pub fn vc_emoji_needs_removal_sync(
    member: &Member,
    config: &Config,
    emoji: &str,
) -> Option<String> {
    if has_any_role(member, config, ROLE_PROFESSOR) {
        return None;
    }
    let nick = member.nick.as_deref()?;
    if !nick.contains(&format!(" {emoji}")) {
        return None;
    }
    let new_nick = nick
        .replace(&format!(" {emoji}"), "")
        .replace(emoji, "")
        .trim()
        .to_string();
    if new_nick.is_empty() {
        return None;
    }
    Some(new_nick)
}

/// Apply nickname and/or role updates to a guild member in one API call.
pub async fn apply_member_update(
    http: &serenity::http::Http,
    guild_id: GuildId,
    user_id: UserId,
    current_roles: &[serenity::all::RoleId],
    new_nickname: Option<String>,
    roles_to_add: Vec<serenity::all::RoleId>,
    roles_to_remove: Vec<serenity::all::RoleId>,
    reason: &str,
) -> anyhow::Result<()> {
    let mut edit = EditMember::new().audit_log_reason(reason);
    let mut has_change = false;

    if let Some(nick) = new_nickname {
        edit = edit.nickname(nick);
        has_change = true;
    }

    if !roles_to_add.is_empty() || !roles_to_remove.is_empty() {
        let new_roles: Vec<serenity::all::RoleId> = current_roles
            .iter()
            .filter(|r| !roles_to_remove.contains(r))
            .cloned()
            .chain(roles_to_add.iter().cloned())
            .collect();
        edit = edit.roles(new_roles);
        has_change = true;
    }

    if has_change {
        guild_id.edit_member(http, user_id, edit).await?;
    }
    Ok(())
}
