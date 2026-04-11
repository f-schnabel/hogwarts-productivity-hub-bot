use std::collections::{HashMap, HashSet};

use chrono::Utc;
use poise::serenity_prelude as serenity;
use serenity::all::{ChannelType, GuildId, Member, Reaction, ReactionType, UserId};
use tracing::{debug, error, info, warn};

use crate::bot::utils::interaction::get_house_from_member;
use crate::bot::utils::nickname::{
    apply_member_update, update_message_streak_in_nickname, vc_emoji_needs_adding,
    vc_emoji_needs_removal, vc_emoji_needs_removal_sync,
};
use crate::bot::utils::roles::{has_any_role, vc_role_needs_adding, vc_role_needs_removal};
use crate::bot::utils::voice::{
    close_voice_session_untracked, end_voice_session, start_voice_session,
};
use crate::bot::utils::year_roles::{
    announce_year_promotion, calculate_year_roles, get_year_from_monthly_voice_time,
    update_announced_year,
};
use crate::constants::{MAX_SESSION_AGE_SECS, MIN_USERS_FOR_SAFE_DELETION, ROLE_PREFECT};
use crate::models::{CountingState, VoiceSessionInput};

use super::Data;

// ─── Main dispatcher ───────────────────────────────────────────────────────

pub async fn event_handler(
    ctx: &serenity::Context,
    event: &serenity::FullEvent,
    _framework: poise::FrameworkContext<'_, Data, crate::error::Error>,
    data: &Data,
) -> crate::error::Result {
    match event {
        serenity::FullEvent::Ready { data_about_bot } => {
            if let Err(e) = on_ready(ctx, data).await {
                error!("Startup error: {e:#}");
                crate::bot::utils::alerting::alert_owner(
                    &ctx.http,
                    data.config.owner_id,
                    &format!("Startup error: {e}"),
                )
                .await;
                std::process::exit(1);
            }
            info!(user = %data_about_bot.user.name, "Bot ready");
        }

        serenity::FullEvent::VoiceStateUpdate { old, new } => {
            let timer = crate::metrics::VOICE_SESSION_TIMER
                .get_metric_with_label_values(&[""])
                .ok();
            if let Err(e) = on_voice_state_update(ctx, old.as_ref(), new, data).await {
                error!("Voice state update error: {e:#}");
                crate::bot::utils::alerting::alert_owner(
                    &ctx.http,
                    data.config.owner_id,
                    &format!("Voice state update error: {e}"),
                )
                .await;
            }
            drop(timer);
        }

        serenity::FullEvent::Message { new_message } => {
            if let Err(e) = on_message(ctx, new_message, data).await {
                error!("Message handler error: {e:#}");
            }
        }

        serenity::FullEvent::ReactionAdd { add_reaction } => {
            if let Err(e) = on_reaction_add(ctx, add_reaction, data).await {
                error!("Reaction add error: {e:#}");
            }
        }

        serenity::FullEvent::InteractionCreate { interaction } => {
            if let Err(e) = on_interaction_create(ctx, interaction, data).await {
                error!("Interaction handler error: {e:#}");
            }
        }

        _ => {}
    }
    Ok(())
}

// ─── Ready ─────────────────────────────────────────────────────────────────

async fn on_ready(ctx: &serenity::Context, data: &Data) -> anyhow::Result<()> {
    let guild_id = GuildId::new(data.config.guild_id);

    // Fetch all guild members to populate the cache
    guild_id.members(ctx, None, None).await?;
    info!("Guild member cache populated");

    // Warm recent submission message cache
    warm_submission_messages(ctx, data).await;

    // Scan voice channels and start tracking
    scan_and_start_tracking(ctx, guild_id, data).await?;

    // Reset nickname streaks to match DB state
    reset_nickname_streaks(ctx, guild_id, data).await?;

    // Reset VC emojis and roles for users not in voice
    reset_vc_emojis_and_roles(ctx, guild_id, data).await?;

    // Check DB user retention and delete stale users
    let (stale_ids, total) = log_user_retention(ctx, guild_id, data).await?;
    delete_stale_users(&data.pool, &stale_ids, total, &ctx.http, &data.config).await?;

    // Refresh all scoreboard messages
    refresh_scoreboards(ctx, guild_id, data).await;

    crate::bot::utils::alerting::alert_owner(
        &ctx.http,
        data.config.owner_id,
        "Bot deployed successfully.",
    )
    .await;

    Ok(())
}

async fn warm_submission_messages(ctx: &serenity::Context, data: &Data) {
    let cutoff = Utc::now() - chrono::Duration::days(2);

    for &channel_id in &data.config.submission_channel_ids {
        let ch_id = serenity::ChannelId::new(channel_id);
        let mut before: Option<serenity::MessageId> = None;
        let mut cached = 0usize;

        loop {
            let mut builder = serenity::GetMessages::new().limit(100);
            if let Some(b) = before {
                builder = builder.before(b);
            }

            match ch_id.messages(&ctx.http, builder).await {
                Err(e) => {
                    warn!(channel = channel_id, "Failed to warm message cache: {e}");
                    break;
                }
                Ok(messages) if messages.is_empty() => break,
                Ok(messages) => {
                    cached += messages.len();
                    let oldest = messages.last().unwrap();
                    let oldest_ts = oldest.timestamp.unix_timestamp();
                    let should_continue =
                        oldest_ts >= cutoff.timestamp() && messages.len() == 100;
                    before = Some(oldest.id);
                    if !should_continue {
                        break;
                    }
                }
            }
        }

        info!(channel = channel_id, messages = cached, "Submission message cache warmed");
    }
}

async fn scan_and_start_tracking(
    ctx: &serenity::Context,
    guild_id: GuildId,
    data: &Data,
) -> anyhow::Result<()> {
    // Step 1: Get all open DB sessions
    let open_sessions = crate::db::get_open_voice_sessions(&data.pool, None).await?;

    // Group by discord_id
    let mut sessions_by_user: HashMap<String, Vec<crate::models::OpenVoiceSession>> =
        HashMap::new();
    for s in open_sessions {
        sessions_by_user
            .entry(s.discord_id.clone())
            .or_default()
            .push(s);
    }

    // Step 2: Snapshot guild voice states from cache (synchronous, releases lock)
    struct VoiceEntry {
        user_id: UserId,
        channel_id: serenity::ChannelId,
        channel_name: String,
    }

    let voice_entries: Vec<VoiceEntry> = {
        let guild_ref = match ctx.cache.guild(guild_id) {
            Some(g) => g,
            None => {
                warn!("Guild not found in cache during startup scan");
                return Ok(());
            }
        };

        guild_ref
            .voice_states
            .iter()
            .filter_map(|(user_id, vs)| {
                let channel_id = vs.channel_id?;
                if data.config.exclude_voice_channel_ids.contains(&channel_id.get()) {
                    return None;
                }
                let channel = guild_ref.channels.get(&channel_id)?;
                if channel.kind == ChannelType::Stage {
                    return None;
                }
                Some(VoiceEntry {
                    user_id: *user_id,
                    channel_id,
                    channel_name: channel.name.clone(),
                })
            })
            .collect()
    };
    // Guild lock dropped here

    let now = Utc::now();
    let mut users_in_voice: HashSet<String> = HashSet::new();
    let mut tracking_started = 0usize;
    let mut sessions_resumed = 0usize;
    let mut stale_closed = 0usize;
    let mut errors = 0usize;

    for entry in &voice_entries {
        let discord_id = entry.user_id.get().to_string();
        users_in_voice.insert(discord_id.clone());

        let member = ctx.cache.guild(guild_id).and_then(|g| g.members.get(&entry.user_id).cloned());
        if member.as_ref().map(|m| m.user.bot).unwrap_or(false) {
            continue;
        }

        let username = member
            .as_ref()
            .map(|m| m.user.name.clone())
            .unwrap_or_else(|| discord_id.clone());
        let house = member
            .as_ref()
            .and_then(|m| get_house_from_member(m, &data.config));

        if let Err(e) =
            crate::db::ensure_user_exists(&data.pool, &discord_id, &username, house.as_deref())
                .await
        {
            warn!(user = discord_id, "ensure_user_exists failed: {e}");
            errors += 1;
            continue;
        }

        let existing = sessions_by_user
            .get(&discord_id)
            .cloned()
            .unwrap_or_default();

        // Sort sessions by join time, newest first
        let mut sorted = existing;
        sorted.sort_by(|a, b| b.joined_at.cmp(&a.joined_at));

        // Find newest valid session (< MAX_SESSION_AGE_SECS)
        let valid_idx = sorted
            .iter()
            .position(|s| (now.naive_utc() - s.joined_at).num_seconds() <= MAX_SESSION_AGE_SECS);

        // Close all sessions except the valid one
        for (i, sess) in sorted.iter().enumerate() {
            if Some(i) == valid_idx {
                continue;
            }
            let age_secs = (now.naive_utc() - sess.joined_at).num_seconds();
            let input = VoiceSessionInput {
                discord_id: discord_id.clone(),
                username: username.clone(),
                channel_id: Some(sess.channel_id.clone()),
                channel_name: Some(sess.channel_name.clone()),
            };
            if age_secs > MAX_SESSION_AGE_SECS {
                let _ = close_voice_session_untracked(&data.pool, &input).await;
            } else {
                let _ = end_voice_session(&data.pool, &input).await;
            }
            stale_closed += 1;
        }

        if valid_idx.is_some() {
            sessions_resumed += 1;
            // Valid session found — just add VC emoji/role without starting new session
            if let Some(ref m) = member {
                let _session_input = VoiceSessionInput {
                    discord_id: discord_id.clone(),
                    username: username.clone(),
                    channel_id: Some(entry.channel_id.get().to_string()),
                    channel_name: Some(entry.channel_name.clone()),
                };
                let _ = apply_vc_join_updates(ctx, m, data).await;
            }
            continue;
        }

        // No valid session → start a new one
        let session_input = VoiceSessionInput {
            discord_id: discord_id.clone(),
            username: username.clone(),
            channel_id: Some(entry.channel_id.get().to_string()),
            channel_name: Some(entry.channel_name.clone()),
        };
        if let Err(e) = start_voice_session(&data.pool, &session_input).await {
            warn!(user = discord_id, "Failed to start voice session on scan: {e}");
            errors += 1;
        } else {
            tracking_started += 1;
        }

        if let Some(ref m) = member {
            let _ = apply_vc_join_updates(ctx, m, data).await;
        }
    }

    // Step 3: Close stale sessions for users no longer in voice
    for (discord_id, sessions) in &sessions_by_user {
        if users_in_voice.contains(discord_id) {
            continue;
        }
        for sess in sessions {
            let age_secs = (now.naive_utc() - sess.joined_at).num_seconds();
            let input = VoiceSessionInput {
                discord_id: discord_id.clone(),
                username: sess.username.clone(),
                channel_id: Some(sess.channel_id.clone()),
                channel_name: Some(sess.channel_name.clone()),
            };
            if age_secs > MAX_SESSION_AGE_SECS {
                let _ = close_voice_session_untracked(&data.pool, &input).await;
            } else {
                let _ = end_voice_session(&data.pool, &input).await;
            }
            stale_closed += 1;
        }
    }

    info!(
        tracking_started,
        sessions_resumed,
        stale_closed,
        errors,
        "Voice scan complete"
    );
    Ok(())
}

/// Apply VC emoji and VC role to a member who just joined (or was found in voice on startup).
async fn apply_vc_join_updates(
    ctx: &serenity::Context,
    member: &Member,
    data: &Data,
) -> anyhow::Result<()> {
    let nickname = vc_emoji_needs_adding(&ctx.http, member, &data.config, &data.pool).await?;
    let vc_role = vc_role_needs_adding(member, &data.config);
    apply_member_update(
        &ctx.http,
        member.guild_id,
        member.user.id,
        &member.roles,
        nickname,
        vc_role.into_iter().collect(),
        vec![],
        "User in voice channel",
    )
    .await?;
    Ok(())
}

async fn reset_nickname_streaks(
    ctx: &serenity::Context,
    guild_id: GuildId,
    data: &Data,
) -> anyhow::Result<()> {
    // Load streak map from DB
    let streak_map: HashMap<String, i32> = sqlx::query!(
        r#"SELECT discord_id, message_streak FROM "user" WHERE message_streak > 0"#
    )
    .fetch_all(&data.pool)
    .await?
    .into_iter()
    .map(|r| (r.discord_id, r.message_streak))
    .collect();

    // Snapshot member list from cache
    let members: Vec<(UserId, Option<String>, Option<i32>)> = {
        let guild_ref = match ctx.cache.guild(guild_id) {
            Some(g) => g,
            None => return Ok(()),
        };
        guild_ref
            .members
            .iter()
            .map(|(uid, m)| {
                let streak = streak_map.get(&uid.to_string()).copied();
                let nick = m.nick.clone();
                (*uid, nick, streak)
            })
            .collect()
    };

    let mut reset_count = 0usize;
    let mut update_count = 0usize;

    for (user_id, nick, streak_in_db) in members {
        let member = match ctx.cache.guild(guild_id).and_then(|g| g.members.get(&user_id).cloned()) {
            Some(m) => m,
            None => continue,
        };

        if member.user.bot {
            continue;
        }

        let expected_streak = streak_in_db.unwrap_or(0);
        let nick_str = nick.as_deref().unwrap_or("");
        let has_streak_in_nick = regex::Regex::new(r"⚡\d+")
            .unwrap()
            .is_match(nick_str);

        // No DB streak but has streak in nick → remove it
        if expected_streak == 0 && has_streak_in_nick {
            if let Err(e) = update_message_streak_in_nickname(
                &ctx.http,
                &member,
                &data.config,
                0,
            )
            .await
            {
                debug!("Failed to reset streak nick for {}: {e}", user_id);
            } else {
                reset_count += 1;
            }
        }
        // Has DB streak and nick doesn't match → update it
        else if expected_streak > 0 {
            let expected_suffix = format!("⚡{expected_streak}");
            if !nick_str.ends_with(&expected_suffix) {
                if let Err(e) = update_message_streak_in_nickname(
                    &ctx.http,
                    &member,
                    &data.config,
                    expected_streak,
                )
                .await
                {
                    debug!("Failed to update streak nick for {}: {e}", user_id);
                } else {
                    update_count += 1;
                }
            }
        }
    }

    info!(reset = reset_count, updated = update_count, "Nickname streaks synced");
    Ok(())
}

async fn reset_vc_emojis_and_roles(
    ctx: &serenity::Context,
    guild_id: GuildId,
    data: &Data,
) -> anyhow::Result<()> {
    let emoji = crate::db::get_vc_emoji(&data.pool).await?;

    // Get members not in any voice channel
    let members_not_in_vc: Vec<(UserId, Vec<serenity::RoleId>, Option<String>)> = {
        let guild_ref = match ctx.cache.guild(guild_id) {
            Some(g) => g,
            None => return Ok(()),
        };
        guild_ref
            .members
            .iter()
            .filter(|(uid, _)| {
                !guild_ref
                    .voice_states
                    .get(*uid)
                    .map(|vs| vs.channel_id.is_some())
                    .unwrap_or(false)
            })
            .map(|(uid, m)| (*uid, m.roles.clone(), m.nick.clone()))
            .collect()
    };

    for (user_id, roles, _nick) in members_not_in_vc {
        let member = match ctx.cache.guild(guild_id).and_then(|g| g.members.get(&user_id).cloned()) {
            Some(m) => m,
            None => continue,
        };
        if member.user.bot {
            continue;
        }

        let nick_update = vc_emoji_needs_removal_sync(&member, &data.config, &emoji);
        let role_to_remove = vc_role_needs_removal(&member, &data.config);

        if nick_update.is_none() && role_to_remove.is_none() {
            continue;
        }

        if let Err(e) = apply_member_update(
            &ctx.http,
            guild_id,
            user_id,
            &roles,
            nick_update,
            vec![],
            role_to_remove.into_iter().collect(),
            "Reset VC emoji/role on startup",
        )
        .await
        {
            debug!("Failed to reset VC state for {}: {e}", user_id);
        }
    }

    info!("VC emoji/role reset complete");
    Ok(())
}

async fn log_user_retention(
    ctx: &serenity::Context,
    guild_id: GuildId,
    data: &Data,
) -> anyhow::Result<(Vec<String>, usize)> {
    let one_month_ago = Utc::now() - chrono::Duration::days(30);

    let db_users = sqlx::query!(
        r#"SELECT discord_id, updated_at FROM "user""#
    )
    .fetch_all(&data.pool)
    .await?;

    // Snapshot guild member IDs
    let member_ids: HashSet<String> = {
        let guild_ref = match ctx.cache.guild(guild_id) {
            Some(g) => g,
            None => return Ok((vec![], db_users.len())),
        };
        guild_ref
            .members
            .keys()
            .map(|id| id.to_string())
            .collect()
    };

    let found = db_users
        .iter()
        .filter(|u| member_ids.contains(&u.discord_id))
        .count();
    let total = db_users.len();
    let pct = if total > 0 {
        (found as f64 / total as f64 * 100.0) as u32
    } else {
        0
    };

    info!(found, total, pct = %format!("{pct}%"), "DB user retention");

    if found < MIN_USERS_FOR_SAFE_DELETION {
        crate::bot::utils::alerting::alert_owner(
            &ctx.http,
            data.config.owner_id,
            &format!(
                "Aborting stale user deletion: only {found}/{total} ({pct}%) users found in guild cache."
            ),
        )
        .await;
        return Ok((vec![], total));
    }

    let stale: Vec<String> = db_users
        .iter()
        .filter(|u| {
            !member_ids.contains(&u.discord_id) && u.updated_at < one_month_ago.naive_utc()
        })
        .map(|u| u.discord_id.clone())
        .collect();

    Ok((stale, total))
}

async fn delete_stale_users(
    pool: &sqlx::PgPool,
    stale_ids: &[String],
    total: usize,
    http: &serenity::http::Http,
    config: &crate::config::Config,
) -> anyhow::Result<()> {
    if stale_ids.is_empty() {
        return Ok(());
    }

    if total > 0 && stale_ids.len() * 2 > total {
        warn!(
            stale = stale_ids.len(),
            total,
            "Skipping stale user deletion (>50% stale)"
        );
        crate::bot::utils::alerting::alert_owner(
            http,
            config.owner_id,
            &format!(
                "Skipped stale user deletion: {}/{} users stale (>50%)",
                stale_ids.len(),
                total
            ),
        )
        .await;
        return Ok(());
    }

    sqlx::query!(
        r#"DELETE FROM "user" WHERE discord_id = ANY($1)"#,
        stale_ids
    )
    .execute(pool)
    .await?;

    info!(count = stale_ids.len(), "Deleted stale users");
    Ok(())
}

async fn refresh_scoreboards(ctx: &serenity::Context, guild_id: GuildId, data: &Data) {
    let broken_ids = match crate::bot::utils::scoreboard::update_scoreboard_messages(
        &data.pool,
        &ctx.http,
        &ctx.cache,
        guild_id,
        &data.config,
    )
    .await
    {
        Ok(ids) => ids,
        Err(e) => {
            warn!("Failed to refresh scoreboards: {e}");
            return;
        }
    };

    if !broken_ids.is_empty() {
        if let Err(e) = crate::db::delete_scoreboards(&data.pool, &broken_ids).await {
            warn!("Failed to delete broken scoreboard entries: {e}");
        }
        crate::bot::utils::alerting::alert_owner(
            &ctx.http,
            data.config.owner_id,
            &format!("Removed {} broken scoreboard entries on startup.", broken_ids.len()),
        )
        .await;
    }

    info!(
        refreshed = broken_ids.len(),
        "Scoreboards refreshed on startup"
    );
}

// ─── Voice state update ────────────────────────────────────────────────────

async fn on_voice_state_update(
    ctx: &serenity::Context,
    old: Option<&serenity::VoiceState>,
    new: &serenity::VoiceState,
    data: &Data,
) -> anyhow::Result<()> {
    let guild_id = match new.guild_id.or_else(|| old.and_then(|o| o.guild_id)) {
        Some(id) => id,
        None => return Ok(()),
    };

    let user_id = new.user_id;

    // Get member
    let member = match new
        .member
        .clone()
        .or_else(|| ctx.cache.guild(guild_id).and_then(|g| g.members.get(&user_id).cloned()))
    {
        Some(m) => m,
        None => return Ok(()),
    };

    if member.user.bot {
        return Ok(());
    }

    let discord_id = user_id.get().to_string();
    let username = member.user.name.clone();

    // Ensure user exists in DB
    let house = get_house_from_member(&member, &data.config);
    crate::db::ensure_user_exists(&data.pool, &discord_id, &username, house.as_deref()).await?;

    // Snapshot channel info from cache
    let channel_info: HashMap<serenity::ChannelId, (String, ChannelType)> = {
        ctx.cache
            .guild(guild_id)
            .map(|g| {
                g.channels
                    .iter()
                    .map(|(id, ch)| (*id, (ch.name.clone(), ch.kind)))
                    .collect()
            })
            .unwrap_or_default()
    };

    let is_excluded = |channel_id: Option<serenity::ChannelId>| -> bool {
        match channel_id {
            None => true,
            Some(cid) => {
                if data.config.exclude_voice_channel_ids.contains(&cid.get()) {
                    return true;
                }
                channel_info
                    .get(&cid)
                    .map(|(_, kind)| *kind == ChannelType::Stage)
                    .unwrap_or(false)
            }
        }
    };

    let old_channel_id = old.and_then(|o| o.channel_id);
    let new_channel_id = new.channel_id;

    let old_excluded = is_excluded(old_channel_id);
    let new_excluded = is_excluded(new_channel_id);

    if old_excluded && new_excluded {
        debug!(user = username, "Ignoring excluded channel voice update");
        return Ok(());
    }

    let make_session = |ch_id: Option<serenity::ChannelId>| VoiceSessionInput {
        discord_id: discord_id.clone(),
        username: username.clone(),
        channel_id: ch_id.map(|id| id.get().to_string()),
        channel_name: ch_id.and_then(|id| channel_info.get(&id).map(|(n, _)| n.clone())),
    };

    if old_excluded && !new_excluded {
        // JOIN
        info!(user = username, channel = ?new_channel_id, "Voice join");
        let session = make_session(new_channel_id);
        start_voice_session(&data.pool, &session).await?;
        apply_vc_join_updates(ctx, &member, data).await?;
    } else if !old_excluded && new_excluded {
        // LEAVE
        info!(user = username, channel = ?old_channel_id, "Voice leave");
        let session = make_session(old_channel_id);
        let user_info = end_voice_session(&data.pool, &session).await?;
        let nickname = vc_emoji_needs_removal(&ctx.http, &member, &data.config, &data.pool).await?;
        let vc_role_remove = vc_role_needs_removal(&member, &data.config);

        let mut roles_to_add = vec![];
        let mut roles_to_remove: Vec<serenity::RoleId> = vc_role_remove.into_iter().collect();

        if let Some(ref info) = user_info {
            if let Some((to_add, to_remove)) = calculate_year_roles(&member, info, &data.config) {
                roles_to_add = to_add;
                roles_to_remove.extend(to_remove);
            }
            announce_year_promotion(&ctx.http, &member, info, &data.config).await;
            let year = get_year_from_monthly_voice_time(info.monthly_voice_time);
            if let Some(y) = year {
                if info.announced_year < y as i32 {
                    update_announced_year(&data.pool, &discord_id, y as i32).await?;
                }
            }
        }

        apply_member_update(
            &ctx.http,
            guild_id,
            user_id,
            &member.roles,
            nickname,
            roles_to_add,
            roles_to_remove,
            "User left voice channel",
        )
        .await?;
    } else if !old_excluded && !new_excluded && old_channel_id != new_channel_id {
        // SWITCH
        info!(user = username, from = ?old_channel_id, to = ?new_channel_id, "Voice switch");
        let old_session = make_session(old_channel_id);
        let new_session = make_session(new_channel_id);

        let user_info = end_voice_session(&data.pool, &old_session).await?;
        start_voice_session(&data.pool, &new_session).await?;

        if let Some(ref info) = user_info {
            let year_roles = calculate_year_roles(&member, info, &data.config);
            if let Some((to_add, to_remove)) = year_roles {
                if !to_add.is_empty() || !to_remove.is_empty() {
                    apply_member_update(
                        &ctx.http,
                        guild_id,
                        user_id,
                        &member.roles,
                        None,
                        to_add,
                        to_remove,
                        "User switched voice channel",
                    )
                    .await?;
                }
            }
            announce_year_promotion(&ctx.http, &member, info, &data.config).await;
            let year = get_year_from_monthly_voice_time(info.monthly_voice_time);
            if let Some(y) = year {
                if info.announced_year < y as i32 {
                    update_announced_year(&data.pool, &discord_id, y as i32).await?;
                }
            }
        }
    }

    Ok(())
}

// ─── Message ───────────────────────────────────────────────────────────────

async fn on_message(
    ctx: &serenity::Context,
    msg: &serenity::Message,
    data: &Data,
) -> anyhow::Result<()> {
    if msg.author.bot || !msg.guild_id.is_some() || msg.kind != serenity::all::MessageType::Regular {
        return Ok(());
    }

    let discord_id = msg.author.id.get().to_string();
    let username = msg.author.name.clone();

    // Ensure user exists
    let member = msg.guild_id.and_then(|gid| {
        ctx.cache.guild(gid).and_then(|g| g.members.get(&msg.author.id).cloned())
    });
    let house = member
        .as_ref()
        .and_then(|m| get_house_from_member(m, &data.config));
    crate::db::ensure_user_exists(&data.pool, &discord_id, &username, house.as_deref()).await?;

    // Increment daily message count and get current streak
    let row = sqlx::query!(
        r#"
        UPDATE "user"
        SET daily_messages = daily_messages + 1, updated_at = NOW()
        WHERE discord_id = $1
        RETURNING message_streak
        "#,
        discord_id,
    )
    .fetch_optional(&data.pool)
    .await?;

    if let Some(row) = row {
        if let Some(ref m) = member {
            let _ = update_message_streak_in_nickname(
                &ctx.http,
                m,
                &data.config,
                row.message_streak,
            )
            .await;
        }
    }

    // Counting channel
    if let Some(counting_cid) = data.config.counting_channel_id {
        if msg.channel_id.get() == counting_cid {
            handle_counting(ctx, msg, &discord_id, data).await?;
        }
    }

    Ok(())
}

async fn handle_counting(
    ctx: &serenity::Context,
    msg: &serenity::Message,
    discord_id: &str,
    data: &Data,
) -> anyhow::Result<()> {
    let content = msg.content.trim();
    let Ok(count) = content.parse::<i32>() else {
        return Ok(());
    };
    if content != count.to_string() {
        return Ok(());
    }

    // Use transaction for atomic check-and-update
    let mut tx = data.pool.begin().await?;
    let state = crate::db::get_counting_state_tx(&mut tx).await?;

    let accepted =
        state.discord_id.as_deref() != Some(discord_id) && count == state.count + 1;

    if accepted {
        let new_state = CountingState {
            count,
            discord_id: Some(discord_id.to_string()),
        };
        crate::db::set_counting_state_tx(&mut tx, &new_state).await?;
        tx.commit().await?;
        let _ = msg.react(ctx, ReactionType::Unicode("✅".to_string())).await;
    } else {
        tx.rollback().await?;
    }

    Ok(())
}

// ─── Reaction add ──────────────────────────────────────────────────────────

async fn on_reaction_add(
    ctx: &serenity::Context,
    reaction: &Reaction,
    data: &Data,
) -> anyhow::Result<()> {
    // Only handle the ⬅️ emoji
    let emoji_name = match &reaction.emoji {
        ReactionType::Unicode(s) => s.as_str(),
        _ => return Ok(()),
    };
    if emoji_name != "⬅️" {
        return Ok(());
    }

    let guild_id = match reaction.guild_id {
        Some(id) => id,
        None => return Ok(()),
    };

    let user_id = match reaction.user_id {
        Some(id) => id,
        None => return Ok(()),
    };

    // Check if the reactor is a bot
    let member = match ctx.cache.guild(guild_id).and_then(|g| g.members.get(&user_id).cloned()) {
        Some(m) => m,
        None => return Ok(()),
    };
    if member.user.bot {
        return Ok(());
    }

    // Check if the member has PREFECT role
    if !has_any_role(&member, &data.config, ROLE_PREFECT) {
        return Ok(());
    }

    let message_id_str = reaction.message_id.get().to_string();
    let submission =
        match crate::db::get_submission_by_message_id(&data.pool, &message_id_str).await? {
            Some(s) => s,
            None => return Ok(()),
        };

    if submission.status != "APPROVED" && submission.status != "REJECTED" {
        return Ok(());
    }

    // Reopen the submission in a transaction
    let previous_status = submission.status.clone();
    let sub_id = submission.id;
    let reviewed_at = submission.reviewed_at;
    let points = submission.points;
    let submitter_id = submission.discord_id.clone();

    let reopened = {
        let mut tx = data.pool.begin().await?;

        let updated = sqlx::query_as!(
            crate::models::Submission,
            r#"
            UPDATE submission
            SET status = 'PENDING', reviewed_at = NULL, reviewed_by = NULL
            WHERE id = $1 AND status = $2
            RETURNING *
            "#,
            sub_id,
            previous_status,
        )
        .fetch_optional(&mut *tx)
        .await?;

        if updated.is_none() {
            tx.rollback().await?;
            return Ok(());
        }

        if previous_status == "APPROVED" {
            if let Some(ts) = reviewed_at {
                crate::services::points::reverse_submission_points(
                    &data.pool,
                    &submitter_id,
                    points,
                    ts,
                )
                .await?;
            }
        }

        tx.commit().await?;
        updated.unwrap()
    };

    // Find linked submission for display
    let linked = sqlx::query!(
        r#"
        SELECT channel_id, message_id FROM submission
        WHERE ($1::INT IS NOT NULL AND id = $1)
           OR linked_submission_id = $2
        LIMIT 1
        "#,
        reopened.linked_submission_id,
        reopened.id,
    )
    .fetch_optional(&data.pool)
    .await
    .ok()
    .flatten();

    let user_tz = crate::db::get_user_timezone(&data.pool, &reopened.discord_id).await?;
    let (embeds, components) = crate::bot::commands::submit::build_submission_message(
        &reopened,
        &user_tz,
        None,
        linked
            .as_ref()
            .map(|l| (l.channel_id.as_deref(), l.message_id.as_deref())),
        data.config.guild_id,
    );

    let channel_id = reaction.channel_id;
    let message_id = reaction.message_id;
    channel_id
        .edit_message(
            ctx,
            message_id,
            serenity::EditMessage::new()
                .embeds(embeds)
                .components(components),
        )
        .await?;

    info!(
        submission_id = sub_id,
        user = user_id.get(),
        "Reopened submission via reaction"
    );

    Ok(())
}

// ─── Interaction create ────────────────────────────────────────────────────

async fn on_interaction_create(
    ctx: &serenity::Context,
    interaction: &serenity::Interaction,
    data: &Data,
) -> anyhow::Result<()> {
    match interaction {
        serenity::Interaction::Component(component) => {
            // Route based on custom_id prefix
            let command_name = component.data.custom_id.split('|').next().unwrap_or("");
            match command_name {
                "submit" => {
                    crate::bot::commands::submit::handle_submit_button(ctx, component, data)
                        .await?;
                }
                _ => {
                    debug!(custom_id = %component.data.custom_id, "Unknown button interaction");
                }
            }
        }
        serenity::Interaction::Modal(modal) => {
            let modal_name = modal.data.custom_id.split('|').next().unwrap_or("");
            match modal_name {
                "rejectModal" => {
                    crate::bot::commands::submit::handle_reject_modal(ctx, modal, data).await?;
                }
                _ => {
                    debug!(custom_id = %modal.data.custom_id, "Unknown modal interaction");
                }
            }
        }
        _ => {}
    }
    Ok(())
}
