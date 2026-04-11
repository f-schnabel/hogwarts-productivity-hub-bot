use chrono::Utc;
use poise::serenity_prelude as serenity;

use crate::bot::utils::interaction::member_has_role;
use crate::constants::{HOUSES, ROLE_OWNER, ROLE_PROFESSOR};

use super::super::Context;

/// Admin management commands.
#[poise::command(
    slash_command,
    subcommands(
        "adjust_points",
        "reset_monthly_points",
        "refresh_ranks",
        "vc_emoji",
        "check_integrity",
        "fix_integrity",
        "journal_set",
        "journal_delete",
        "journal_list",
        "journal_export",
        "journal_import",
        "journal_show",
        "counting_set"
    )
)]
pub async fn admin(_ctx: Context<'_>) -> crate::error::Result {
    Ok(())
}

fn require_admin(ctx: &Context<'_>) -> Option<()> {
    // Checked inline in each subcommand to get correct error handling
    Some(())
}

/// Add or remove points from a user.
#[poise::command(slash_command, rename = "adjust-points")]
pub async fn adjust_points(
    ctx: Context<'_>,
    #[description = "Amount of points to adjust (positive or negative)"] amount: i64,
    #[description = "User to adjust"] user: serenity::User,
    #[description = "Reason for adjustment"] reason: Option<String>,
) -> crate::error::Result {
    let data = ctx.data();
    let member = ctx.author_member().await;
    if !member.as_ref().map(|m| member_has_role(m, &data.config, ROLE_PROFESSOR | ROLE_OWNER)).unwrap_or(false) {
        ctx.say("You don't have permission to use this command.").await?;
        return Ok(());
    }
    ctx.defer().await?;

    let discord_id = user.id.get().to_string();
    crate::services::points::award_points(&data.pool, &discord_id, amount as i32).await?;

    sqlx::query!(
        "INSERT INTO point_adjustment (discord_id, adjusted_by, amount, reason) VALUES ($1, $2, $3, $4)",
        discord_id,
        ctx.author().id.get().to_string(),
        amount as i32,
        reason.as_deref(),
    )
    .execute(&data.pool)
    .await?;

    tracing::info!(user = %discord_id, amount, ?reason, "Points adjusted");
    ctx.say(format!(
        "Adjusted {} points for {}.{}",
        amount,
        user.name,
        reason.map(|r| format!(" Reason: {r}")).unwrap_or_default()
    ))
    .await?;
    Ok(())
}

/// Reset all users' monthly points and snapshot house cup results.
#[poise::command(slash_command, rename = "reset-monthly-points")]
pub async fn reset_monthly_points(ctx: Context<'_>) -> crate::error::Result {
    let data = ctx.data();
    let member = ctx.author_member().await;
    if !member.as_ref().map(|m| member_has_role(m, &data.config, ROLE_PROFESSOR | ROLE_OWNER)).unwrap_or(false) {
        ctx.say("You don't have permission to use this command.").await?;
        return Ok(());
    }
    ctx.defer().await?;

    let mut tx = data.pool.begin().await?;

    // Snapshot house cup
    let weighted = crate::db::get_weighted_house_points_tx(&mut tx).await?;
    let unweighted = crate::db::get_unweighted_house_points_tx(&mut tx).await?;

    let weighted_map: std::collections::HashMap<&str, i64> = weighted
        .iter()
        .filter_map(|h| h.house.as_deref().zip(h.total_points))
        .collect();
    let unweighted_map: std::collections::HashMap<&str, (i64, i64)> = unweighted
        .iter()
        .filter_map(|h| h.house.as_deref().map(|name| (name, (h.total_points.unwrap_or(0), h.member_count))))
        .collect();

    // Weighted member counts
    let w_member_counts: std::collections::HashMap<&str, i64> = weighted
        .iter()
        .filter_map(|h| h.house.as_deref().map(|name| (name, h.member_count)))
        .collect();

    let winner = weighted.first().and_then(|h| h.house.as_deref()).unwrap_or("Gryffindor");
    let month = Utc::now().format("%Y-%m").to_string();

    let cup_month_id: i32 = sqlx::query_scalar!(
        "INSERT INTO house_cup_month (month, winner) VALUES ($1, $2) RETURNING id",
        month,
        winner,
    )
    .fetch_one(&mut *tx)
    .await?;

    // Champions (top scorer per house)
    let champions: Vec<(String, String)> = sqlx::query!(
        r#"
        SELECT DISTINCT ON (house) house, discord_id
        FROM "user"
        WHERE house IS NOT NULL
        ORDER BY house, monthly_points DESC
        "#
    )
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .filter_map(|r| r.house.map(|h| (h, r.discord_id)))
    .collect();
    let champion_map: std::collections::HashMap<&str, &str> =
        champions.iter().map(|(h, id)| (h.as_str(), id.as_str())).collect();

    for house in &HOUSES {
        let weighted_pts = *weighted_map.get(house).unwrap_or(&0) as i32;
        let (raw_pts, total_members) = unweighted_map.get(house).copied().unwrap_or((0, 0));
        let qualifying = *w_member_counts.get(house).unwrap_or(&0) as i32;

        sqlx::query!(
            r#"
            INSERT INTO house_cup_entry (month_id, house, weighted_points, raw_points, member_count, qualifying_count, champion)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            "#,
            cup_month_id,
            *house,
            weighted_pts,
            raw_pts as i32,
            total_members as i32,
            qualifying,
            champion_map.get(house).copied(),
        )
        .execute(&mut *tx)
        .await?;
    }

    // Reset monthly points and voice time
    let result = sqlx::query!(
        r#"UPDATE "user" SET monthly_points = 0, monthly_voice_time = 0, announced_year = 0, updated_at = NOW()"#
    )
    .execute(&mut *tx)
    .await?;

    crate::db::set_month_start_date_tx(&mut tx, Utc::now()).await?;
    tx.commit().await?;

    tracing::info!(winner, month, users_reset = result.rows_affected(), "Monthly reset complete");

    // Refresh scoreboards in background
    if let Some(guild_id) = ctx.guild_id() {
        let pool = data.pool.clone();
        let http = ctx.http().clone();
        let cache_arc = ctx.cache().map(|c| c.clone());
        let config = data.config.clone();
        tokio::spawn(async move {
            if let Some(cache) = cache_arc {
                if let Err(e) = crate::bot::utils::scoreboard::update_scoreboard_messages(&pool, &http, &cache, guild_id, &config).await {
                    tracing::warn!("Scoreboard refresh failed after monthly reset: {e}");
                }
            }
        });

        // Refresh year roles (removes all since monthly_voice_time is now 0)
        let pool = data.pool.clone();
        let http = ctx.http().clone();
        let cache_arc = ctx.cache().map(|c| c.clone());
        let config = data.config.clone();
        tokio::spawn(async move {
            if let Some(cache) = cache_arc {
                match crate::bot::utils::year_roles::refresh_all_year_roles(&pool, &http, &cache, guild_id, &config).await {
                    Ok(n) => tracing::info!(n, "Year roles refreshed after monthly reset"),
                    Err(e) => tracing::warn!("Year role refresh failed: {e}"),
                }
            }
        });
    }

    ctx.say("Monthly points have been reset for all users.").await?;
    Ok(())
}

/// Recalculate year roles for all users.
#[poise::command(slash_command, rename = "refresh-ranks")]
pub async fn refresh_ranks(ctx: Context<'_>) -> crate::error::Result {
    let data = ctx.data();
    let member = ctx.author_member().await;
    if !member.as_ref().map(|m| member_has_role(m, &data.config, ROLE_PROFESSOR | ROLE_OWNER)).unwrap_or(false) {
        ctx.say("You don't have permission to use this command.").await?;
        return Ok(());
    }
    ctx.defer().await?;

    let guild_id = match ctx.guild_id() {
        Some(id) => id,
        None => {
            ctx.say("Must be used in a server.").await?;
            return Ok(());
        }
    };

    let cache = ctx.cache().ok_or_else(|| anyhow::anyhow!("Cache not available"))?;
    let count = crate::bot::utils::year_roles::refresh_all_year_roles(
        &data.pool,
        ctx.http(),
        cache,
        guild_id,
        &data.config,
    )
    .await?;

    ctx.say(format!("Year ranks refreshed for {count} users.")).await?;
    Ok(())
}

/// Get or set the voice channel emoji.
#[poise::command(slash_command, rename = "vc-emoji")]
pub async fn vc_emoji(
    ctx: Context<'_>,
    #[description = "New emoji to set (leave blank to view current)"] emoji: Option<String>,
) -> crate::error::Result {
    let data = ctx.data();
    let member = ctx.author_member().await;
    if !member.as_ref().map(|m| member_has_role(m, &data.config, ROLE_PROFESSOR | ROLE_OWNER)).unwrap_or(false) {
        ctx.say("You don't have permission to use this command.").await?;
        return Ok(());
    }
    ctx.defer().await?;

    if let Some(new_emoji) = emoji {
        let old_emoji = crate::db::get_vc_emoji(&data.pool).await?;
        crate::db::set_vc_emoji(&data.pool, &new_emoji).await?;

        // Update nicknames of members currently in VC
        if old_emoji != new_emoji {
            if let Some(guild_id) = ctx.guild_id() {
                if let Some(cache) = ctx.cache() {
                    let members_in_vc: Vec<_> = cache
                        .guild(guild_id)
                        .map(|g| {
                            g.members
                                .values()
                                .filter(|m| m.voice.channel_id.is_some())
                                .filter(|m| {
                                    m.nick
                                        .as_deref()
                                        .map(|n| n.contains(&format!(" {old_emoji}")))
                                        .unwrap_or(false)
                                })
                                .map(|m| (m.user.id, m.nick.clone()))
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();

                    for (uid, nick) in members_in_vc {
                        if let Some(nick) = nick {
                            let new_nick = nick.replace(&format!(" {old_emoji}"), &format!(" {new_emoji}")).trim().to_string();
                            if new_nick.len() <= 32 && new_nick != nick {
                                let _ = guild_id.edit_member(ctx.http(), uid, serenity::EditMember::new().nickname(new_nick)).await;
                            }
                        }
                    }
                }
            }
        }

        ctx.say(format!("Voice channel emoji set to: {new_emoji}")).await?;
    } else {
        let current = crate::db::get_vc_emoji(&data.pool).await?;
        ctx.say(format!("Current voice channel emoji: {current}")).await?;
    }
    Ok(())
}

/// Check point integrity against transaction tables.
#[poise::command(slash_command, rename = "check-integrity")]
pub async fn check_integrity(ctx: Context<'_>) -> crate::error::Result {
    let data = ctx.data();
    let member = ctx.author_member().await;
    if !member.as_ref().map(|m| member_has_role(m, &data.config, ROLE_PROFESSOR | ROLE_OWNER)).unwrap_or(false) {
        ctx.say("You don't have permission.").await?;
        return Ok(());
    }
    ctx.defer().await?;

    let (discrepancies, _) = compute_integrity(&data.pool).await?;

    if discrepancies.is_empty() {
        ctx.say("✅ No discrepancies found.").await?;
    } else {
        let displayed: Vec<&String> = discrepancies.iter().take(20).collect();
        let extra = discrepancies.len().saturating_sub(20);
        let mut msg = format!("⚠️ Found {} discrepancies:\n{}", discrepancies.len(), displayed.iter().map(|s| s.as_str()).collect::<Vec<_>>().join("\n"));
        if extra > 0 {
            msg.push_str(&format!("\n...and {extra} more"));
        }
        ctx.say(msg).await?;
    }
    Ok(())
}

/// Overwrite stored points/voice time with recalculated values.
#[poise::command(slash_command, rename = "fix-integrity")]
pub async fn fix_integrity(ctx: Context<'_>) -> crate::error::Result {
    let data = ctx.data();
    let member = ctx.author_member().await;
    if !member.as_ref().map(|m| member_has_role(m, &data.config, ROLE_PROFESSOR | ROLE_OWNER)).unwrap_or(false) {
        ctx.say("You don't have permission.").await?;
        return Ok(());
    }
    ctx.defer().await?;

    let (_, expected) = compute_integrity(&data.pool).await?;
    let mut fixed = 0usize;

    for (discord_id, exp) in &expected {
        sqlx::query!(
            r#"
            UPDATE "user"
            SET total_points   = $1, monthly_points   = $2, daily_points   = $3,
                total_voice_time = $4, monthly_voice_time = $5, daily_voice_time = $6,
                updated_at = NOW()
            WHERE discord_id = $7
            "#,
            exp.total_points,
            exp.monthly_points,
            exp.daily_points,
            exp.total_voice_time,
            exp.monthly_voice_time,
            exp.daily_voice_time,
            discord_id,
        )
        .execute(&data.pool)
        .await?;
        fixed += 1;
    }

    ctx.say(if fixed == 0 {
        "No discrepancies found.".to_string()
    } else {
        format!("Fixed {fixed} user(s).")
    })
    .await?;
    Ok(())
}

struct ExpectedValues {
    total_points: i32,
    monthly_points: i32,
    daily_points: i32,
    total_voice_time: i32,
    monthly_voice_time: i32,
    daily_voice_time: i32,
}

async fn compute_integrity(
    pool: &sqlx::PgPool,
) -> anyhow::Result<(Vec<String>, std::collections::HashMap<String, ExpectedValues>)> {
    let month_start = crate::db::get_month_start_date(pool).await?;

    let users = crate::db::get_all_users(pool).await?;

    let voice_sessions = sqlx::query!(
        "SELECT discord_id, points, duration, left_at FROM voice_session WHERE is_tracked = true"
    )
    .fetch_all(pool)
    .await?;

    let submissions = sqlx::query!(
        "SELECT discord_id, points, reviewed_at FROM submission WHERE status = 'APPROVED'"
    )
    .fetch_all(pool)
    .await?;

    let adjustments = sqlx::query!(
        "SELECT discord_id, amount, created_at FROM point_adjustment"
    )
    .fetch_all(pool)
    .await?;

    let user_reset_map: std::collections::HashMap<&str, chrono::DateTime<Utc>> =
        users.iter().map(|u| (u.discord_id.as_str(), u.last_daily_reset)).collect();

    let mut vp_map: std::collections::HashMap<String, crate::models::Sums> = users
        .iter()
        .map(|u| (u.discord_id.clone(), crate::models::Sums::default()))
        .collect();
    let mut vt_map = vp_map.clone();
    let mut sub_map = vp_map.clone();
    let mut adj_map = vp_map.clone();

    for vs in &voice_sessions {
        let reset = user_reset_map.get(vs.discord_id.as_str()).copied();
        if let Some(pts) = vs.points {
            let sums = vp_map.entry(vs.discord_id.clone()).or_default();
            sums.total += pts;
            if let Some(la) = vs.left_at { if la >= month_start { sums.monthly += pts; } }
            if let Some(la) = vs.left_at { if let Some(r) = reset { if la >= r { sums.daily += pts; } } }
        }
        if let Some(dur) = vs.duration {
            let sums = vt_map.entry(vs.discord_id.clone()).or_default();
            sums.total += dur;
            if let Some(la) = vs.left_at { if la >= month_start { sums.monthly += dur; } }
            if let Some(la) = vs.left_at { if let Some(r) = reset { if la >= r { sums.daily += dur; } } }
        }
    }

    for sub in &submissions {
        let sums = sub_map.entry(sub.discord_id.clone()).or_default();
        sums.total += sub.points;
        if let Some(ra) = sub.reviewed_at { if ra >= month_start { sums.monthly += sub.points; } }
        let reset = user_reset_map.get(sub.discord_id.as_str()).copied();
        if let Some(ra) = sub.reviewed_at { if let Some(r) = reset { if ra >= r { sums.daily += sub.points; } } }
    }

    for adj in &adjustments {
        let sums = adj_map.entry(adj.discord_id.clone()).or_default();
        sums.total += adj.amount;
        if adj.created_at >= month_start { sums.monthly += adj.amount; }
        let reset = user_reset_map.get(adj.discord_id.as_str()).copied();
        if let Some(r) = reset { if adj.created_at >= r { sums.daily += adj.amount; } }
    }

    let zero = crate::models::Sums::default();
    let mut expected_map: std::collections::HashMap<String, ExpectedValues> = std::collections::HashMap::new();
    let mut discrepancies = vec![];

    for user in &users {
        let vcp = vp_map.get(&user.discord_id).unwrap_or(&zero);
        let vct = vt_map.get(&user.discord_id).unwrap_or(&zero);
        let sub = sub_map.get(&user.discord_id).unwrap_or(&zero);
        let adj = adj_map.get(&user.discord_id).unwrap_or(&zero);

        let exp = ExpectedValues {
            total_points: vcp.total + sub.total + adj.total,
            monthly_points: vcp.monthly + sub.monthly + adj.monthly,
            daily_points: vcp.daily + sub.daily + adj.daily,
            total_voice_time: vct.total,
            monthly_voice_time: vct.monthly,
            daily_voice_time: vct.daily,
        };

        if user.total_points != exp.total_points { discrepancies.push(format!("**{}** totalPts: stored={}, expected={}", user.username, user.total_points, exp.total_points)); }
        if user.monthly_points != exp.monthly_points { discrepancies.push(format!("**{}** monthlyPts: stored={}, expected={}", user.username, user.monthly_points, exp.monthly_points)); }
        if user.daily_points != exp.daily_points { discrepancies.push(format!("**{}** dailyPts: stored={}, expected={}", user.username, user.daily_points, exp.daily_points)); }
        if user.total_voice_time != exp.total_voice_time { discrepancies.push(format!("**{}** totalVcTime: stored={}, expected={}", user.username, user.total_voice_time, exp.total_voice_time)); }
        if user.monthly_voice_time != exp.monthly_voice_time { discrepancies.push(format!("**{}** monthlyVcTime: stored={}, expected={}", user.username, user.monthly_voice_time, exp.monthly_voice_time)); }

        expected_map.insert(user.discord_id.clone(), exp);
    }

    Ok((discrepancies, expected_map))
}

// ─── Journal subcommands ───────────────────────────────────────────────────

/// Create or update a journal entry.
#[poise::command(slash_command, rename = "journal-set")]
pub async fn journal_set(
    ctx: Context<'_>,
    #[description = "Date in YYYY-MM-DD format"] date: String,
    #[description = "Journal prompt text"] prompt: String,
) -> crate::error::Result {
    let data = ctx.data();
    let member = ctx.author_member().await;
    if !member.as_ref().map(|m| member_has_role(m, &data.config, ROLE_PROFESSOR | ROLE_OWNER)).unwrap_or(false) {
        ctx.say("No permission.").await?;
        return Ok(());
    }
    ctx.defer().await?;

    sqlx::query!(
        r#"INSERT INTO journal_entry (date, prompt) VALUES ($1::date, $2)
           ON CONFLICT (date) DO UPDATE SET prompt = $2, updated_at = NOW()"#,
        date,
        prompt,
    )
    .execute(&data.pool)
    .await?;

    ctx.say(format!("Journal entry set for {date}.")).await?;
    Ok(())
}

/// Delete a journal entry.
#[poise::command(slash_command, rename = "journal-delete")]
pub async fn journal_delete(
    ctx: Context<'_>,
    #[description = "Date in YYYY-MM-DD format"] date: String,
) -> crate::error::Result {
    let data = ctx.data();
    let member = ctx.author_member().await;
    if !member.as_ref().map(|m| member_has_role(m, &data.config, ROLE_PROFESSOR | ROLE_OWNER)).unwrap_or(false) {
        ctx.say("No permission.").await?;
        return Ok(());
    }
    ctx.defer().await?;

    let result = sqlx::query!("DELETE FROM journal_entry WHERE date = $1::date", date)
        .execute(&data.pool)
        .await?;

    if result.rows_affected() == 0 {
        ctx.say(format!("No journal entry found for {date}.")).await?;
    } else {
        ctx.say(format!("Journal entry deleted for {date}.")).await?;
    }
    Ok(())
}

/// List upcoming journal entries.
#[poise::command(slash_command, rename = "journal-list")]
pub async fn journal_list(ctx: Context<'_>) -> crate::error::Result {
    let data = ctx.data();
    let member = ctx.author_member().await;
    if !member.as_ref().map(|m| member_has_role(m, &data.config, ROLE_PROFESSOR | ROLE_OWNER)).unwrap_or(false) {
        ctx.say("No permission.").await?;
        return Ok(());
    }
    ctx.defer().await?;

    let today = Utc::now().format("%Y-%m-%d").to_string();
    let entries = sqlx::query!(
        "SELECT date, prompt FROM journal_entry WHERE date >= $1::date ORDER BY date ASC LIMIT 20",
        today,
    )
    .fetch_all(&data.pool)
    .await?;

    if entries.is_empty() {
        ctx.say("No upcoming journal entries.").await?;
        return Ok(());
    }

    let lines: Vec<String> = entries
        .iter()
        .map(|e| format!("• **{}**: {}", e.date, e.prompt.chars().take(60).collect::<String>()))
        .collect();

    ctx.say(lines.join("\n")).await?;
    Ok(())
}

/// Export all journal entries as CSV.
#[poise::command(slash_command, rename = "journal-export")]
pub async fn journal_export(ctx: Context<'_>) -> crate::error::Result {
    let data = ctx.data();
    let member = ctx.author_member().await;
    if !member.as_ref().map(|m| member_has_role(m, &data.config, ROLE_PROFESSOR | ROLE_OWNER)).unwrap_or(false) {
        ctx.say("No permission.").await?;
        return Ok(());
    }
    ctx.defer().await?;

    let entries = sqlx::query!("SELECT date, prompt FROM journal_entry ORDER BY date ASC")
        .fetch_all(&data.pool)
        .await?;

    let mut csv = "date,prompt\n".to_string();
    for e in &entries {
        let escaped_prompt = e.prompt.replace('"', "\"\"");
        csv.push_str(&format!("{},\"{}\"\n", e.date, escaped_prompt));
    }

    ctx.send(
        poise::CreateReply::default()
            .content(format!("Exported {} entries.", entries.len()))
            .attachment(serenity::CreateAttachment::bytes(csv.into_bytes(), "journal_entries.csv")),
    )
    .await?;
    Ok(())
}

/// Import journal entries from a CSV file.
#[poise::command(slash_command, rename = "journal-import")]
pub async fn journal_import(
    ctx: Context<'_>,
    #[description = "CSV file with date,prompt columns"] file: serenity::Attachment,
) -> crate::error::Result {
    let data = ctx.data();
    let member = ctx.author_member().await;
    if !member.as_ref().map(|m| member_has_role(m, &data.config, ROLE_PROFESSOR | ROLE_OWNER)).unwrap_or(false) {
        ctx.say("No permission.").await?;
        return Ok(());
    }
    ctx.defer().await?;

    let content = reqwest::get(&file.url).await?.text().await?;
    let mut lines = content.lines();
    lines.next(); // skip header

    let mut imported = 0usize;
    let mut errors = 0usize;

    for line in lines {
        let line = line.trim();
        if line.is_empty() { continue; }

        // Simple CSV parse: date,prompt (prompt may be quoted)
        let (date, prompt) = if let Some(comma) = line.find(',') {
            let date = &line[..comma];
            let prompt_raw = &line[comma + 1..];
            let prompt = prompt_raw.trim_matches('"').replace("\"\"", "\"");
            (date.to_string(), prompt)
        } else {
            errors += 1;
            continue;
        };

        let result = sqlx::query!(
            r#"INSERT INTO journal_entry (date, prompt) VALUES ($1::date, $2)
               ON CONFLICT (date) DO UPDATE SET prompt = $2, updated_at = NOW()"#,
            date,
            prompt,
        )
        .execute(&data.pool)
        .await;

        match result {
            Ok(_) => imported += 1,
            Err(_) => errors += 1,
        }
    }

    ctx.say(format!("Imported {imported} entries.{}", if errors > 0 { format!(" {errors} errors.") } else { String::new() })).await?;
    Ok(())
}

/// Preview a journal message without sending it.
#[poise::command(slash_command, rename = "journal-show")]
pub async fn journal_show(
    ctx: Context<'_>,
    #[description = "Date in YYYY-MM-DD format (defaults to today)"] date: Option<String>,
) -> crate::error::Result {
    let data = ctx.data();
    let member = ctx.author_member().await;
    if !member.as_ref().map(|m| member_has_role(m, &data.config, ROLE_PROFESSOR | ROLE_OWNER)).unwrap_or(false) {
        ctx.say("No permission.").await?;
        return Ok(());
    }
    ctx.defer().await?;

    let date_str = date.unwrap_or_else(|| Utc::now().format("%Y-%m-%d").to_string());

    let entry = sqlx::query!(
        "SELECT prompt FROM journal_entry WHERE date = $1::date LIMIT 1",
        date_str,
    )
    .fetch_optional(&data.pool)
    .await?;

    match entry {
        None => ctx.say(format!("No journal entry for {date_str}.")).await?,
        Some(e) => ctx.say(crate::services::journal::build_journal_message(&e.prompt)).await?,
    };
    Ok(())
}

/// Set the current counting channel number.
#[poise::command(slash_command, rename = "counting-set")]
pub async fn counting_set(
    ctx: Context<'_>,
    #[description = "The current count number"] number: i64,
) -> crate::error::Result {
    let data = ctx.data();
    let member = ctx.author_member().await;
    if !member.as_ref().map(|m| member_has_role(m, &data.config, ROLE_PROFESSOR | ROLE_OWNER)).unwrap_or(false) {
        ctx.say("No permission.").await?;
        return Ok(());
    }
    ctx.defer().await?;

    let state = crate::models::CountingState {
        count: number as i32,
        discord_id: None,
    };
    crate::db::set_counting_state(&data.pool, &state).await?;

    ctx.say(format!("Current counting value set to {number}.")).await?;
    Ok(())
}
