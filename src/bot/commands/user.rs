use chrono::{Datelike, Duration, Utc};
use chrono_tz::Tz;
use poise::serenity_prelude as serenity;

use crate::bot::utils::interaction::{format_duration, member_has_role};
use crate::bot::utils::year_roles::get_year_from_monthly_voice_time;
use crate::constants::{BOT_COLOR_INFO, ROLE_OWNER, ROLE_PREFECT, YEAR_THRESHOLDS_HOURS};

use super::super::Context;

/// View user information and stats.
#[poise::command(slash_command, subcommands("time", "points", "points_detailed"))]
pub async fn user_cmd(_ctx: Context<'_>) -> crate::error::Result {
    Ok(())
}

/// View a user's current local time.
#[poise::command(slash_command)]
pub async fn time(
    ctx: Context<'_>,
    #[description = "User to check"] user: serenity::User,
) -> crate::error::Result {
    let data = ctx.data();
    let discord_id = user.id.get().to_string();
    let tz_str = crate::db::get_user_timezone(&data.pool, &discord_id).await?;
    let tz: Tz = tz_str.parse().unwrap_or(chrono_tz::UTC);
    let local = Utc::now().with_timezone(&tz);

    ctx.say(format!(
        "{}'s current time is **{}** ({}, UTC{})",
        user.global_name.as_deref().unwrap_or(&user.name),
        local.format("%Y-%m-%d %I:%M:%S %p"),
        tz_str,
        local.format("%:z"),
    ))
    .await?;
    Ok(())
}

/// View a user's monthly points breakdown.
#[poise::command(slash_command)]
pub async fn points(
    ctx: Context<'_>,
    #[description = "User to check"] user: serenity::User,
) -> crate::error::Result {
    let data = ctx.data();
    ctx.defer().await?;

    let discord_id = user.id.get().to_string();

    let user_row = match crate::db::get_user(&data.pool, &discord_id).await? {
        Some(u) => u,
        None => {
            ctx.send(
                poise::CreateReply::default().ephemeral(true).embed(
                    serenity::CreateEmbed::new()
                        .color(crate::constants::BOT_COLOR_ERROR)
                        .title("User Not Found")
                        .description(format!("{} is not registered.", user.name)),
                ),
            )
            .await?;
            return Ok(());
        }
    };

    let month_start = crate::db::get_month_start_date(&data.pool).await?;
    let tz: Tz = user_row.timezone.parse().unwrap_or(chrono_tz::UTC);

    // Approved submissions this month
    let submissions = sqlx::query!(
        r#"SELECT points, submitted_at FROM submission
           WHERE discord_id = $1 AND status = 'APPROVED' AND submitted_at >= $2"#,
        discord_id,
        month_start,
    )
    .fetch_all(&data.pool)
    .await?;

    // Tracked voice sessions this month
    let voice_sessions = sqlx::query!(
        r#"SELECT duration, channel_name, joined_at, left_at, points
           FROM voice_session
           WHERE discord_id = $1 AND is_tracked = true AND left_at >= $2
           ORDER BY joined_at ASC"#,
        discord_id,
        month_start,
    )
    .fetch_all(&data.pool)
    .await?;

    // Active (open) voice session
    let active_session = sqlx::query!(
        r#"SELECT channel_name, joined_at FROM voice_session
           WHERE discord_id = $1 AND is_tracked = false AND left_at IS NULL
           LIMIT 1"#,
        discord_id,
    )
    .fetch_optional(&data.pool)
    .await?;

    let active_duration = active_session.as_ref().map(|s| {
        let secs = (Utc::now().naive_utc() - s.joined_at).num_seconds().max(0) as i32;
        let pts = crate::services::points::calculate_points(user_row.daily_voice_time, user_row.daily_voice_time + secs);
        (secs, pts)
    });

    // Group by day in user timezone
    use std::collections::HashMap;
    let mut daily: HashMap<String, (i32, i32, i32, i32)> = HashMap::new(); // (voice_secs, voice_pts, sub_pts, sub_count)

    for s in &voice_sessions {
        let day = s.joined_at.and_utc().with_timezone(&tz).format("%Y-%m-%d").to_string();
        let e = daily.entry(day).or_default();
        e.0 += s.duration.unwrap_or(0);
        e.1 += s.points.unwrap_or(0);
    }
    for s in &submissions {
        let day = s.submitted_at.and_utc().with_timezone(&tz).format("%Y-%m-%d").to_string();
        let e = daily.entry(day).or_default();
        e.2 += s.points;
        e.3 += 1;
    }
    if let Some((secs, pts)) = active_duration {
        let day = active_session.as_ref().unwrap().joined_at.and_utc().with_timezone(&tz).format("%Y-%m-%d").to_string();
        let e = daily.entry(day).or_default();
        e.0 += secs;
        e.1 += pts;
    }

    // Build activity lines (weekly aggregates + daily for this week)
    let now = Utc::now().with_timezone(&tz);
    let current_week_start = now - Duration::days(now.weekday().num_days_from_sunday() as i64);
    let current_week_start_str = current_week_start.format("%Y-%m-%d").to_string();

    let mut weekly: HashMap<String, (i32, i32, i32, i32)> = HashMap::new();
    let mut this_week_days: Vec<(String, (i32, i32, i32, i32))> = Vec::new();

    for (day, data) in &daily {
        if day.as_str() >= current_week_start_str.as_str() {
            this_week_days.push((day.clone(), *data));
        } else {
            // Find week start
            let d = chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d").unwrap();
            let week_start = d - Duration::days(d.weekday().num_days_from_sunday() as i64);
            let key = if week_start.format("%Y-%m-%d").to_string() < month_start.format("%Y-%m-%d").to_string() {
                month_start.format("%Y-%m-%d").to_string()
            } else {
                week_start.format("%Y-%m-%d").to_string()
            };
            let e = weekly.entry(key).or_default();
            e.0 += data.0;
            e.1 += data.1;
            e.2 += data.2;
            e.3 += data.3;
        }
    }

    let format_line = |label: &str, (vs, vp, sp, sc): (i32, i32, i32, i32)| {
        let total = vp + sp;
        let mut parts = vec![];
        if vs > 0 {
            parts.push(format!("{} ({vp} pt)", format_duration(vs)));
        }
        if sp > 0 {
            let todo_label = if sc == 1 { "To-Do List" } else { "To-Do Lists" };
            parts.push(format!("{todo_label} ({sp} pt)"));
        }
        format!("• {label}: **{total} pt** = {}", parts.join(" + "))
    };

    let mut sorted_weekly: Vec<_> = weekly.into_iter().collect();
    sorted_weekly.sort_by(|a, b| a.0.cmp(&b.0));

    let weekly_lines: Vec<String> = sorted_weekly
        .iter()
        .map(|(ws, data)| {
            let start = chrono::NaiveDate::parse_from_str(ws, "%Y-%m-%d").unwrap();
            let end = start + Duration::days(6);
            let label = if start.month() != end.month() {
                format!("{} - {}", start.format("%b %-d"), end.format("%b %-d"))
            } else {
                format!("{} - {}", start.format("%b %-d"), end.format("%-d"))
            };
            format_line(&label, *data)
        })
        .collect();

    this_week_days.sort_by(|a, b| a.0.cmp(&b.0));
    let daily_lines: Vec<String> = this_week_days
        .iter()
        .map(|(day, data)| {
            let d = chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d").unwrap();
            format_line(&d.format("%b %-d").to_string(), *data)
        })
        .collect();

    let mut all_lines = weekly_lines;
    all_lines.extend(daily_lines);
    let activity_str = if all_lines.is_empty() { "None".to_string() } else { all_lines.join("\n") };

    // Year progress
    let current_year = get_year_from_monthly_voice_time(user_row.monthly_voice_time);
    let current_hours = user_row.monthly_voice_time as f64 / 3600.0;
    let width = 20usize;

    let year_progress = match current_year {
        None => {
            let next = YEAR_THRESHOLDS_HOURS[0] as f64;
            let filled = ((current_hours / next) * width as f64).min(width as f64).round() as usize;
            format!(
                "**Year 0** (0h - {}h)\n{}{} {:.0}/{next}h\nNext rank: **Year 1**",
                next as u32,
                "▓".repeat(filled),
                "░".repeat(width - filled),
                current_hours,
            )
        }
        Some(7) => {
            format!(
                "**Year 7** ({}h+)\n{} ({:.0}h)\nMaximum rank achieved",
                YEAR_THRESHOLDS_HOURS[6],
                "▓".repeat(width),
                current_hours,
            )
        }
        Some(y) => {
            let prev = YEAR_THRESHOLDS_HOURS[(y - 1) as usize] as f64;
            let next = YEAR_THRESHOLDS_HOURS[y as usize] as f64;
            let pct = (current_hours - prev) / (next - prev);
            let filled = (pct * width as f64).min(width as f64).round() as usize;
            let next_range = YEAR_THRESHOLDS_HOURS.get(y as usize + 1)
                .map(|&n| format!("{}h - {n}h", next as u32))
                .unwrap_or_else(|| format!("{}h+", next as u32));
            format!(
                "**Year {y}** ({prev:.0}h - {next:.0}h)\n{}{} {:.0}/{next:.0}h\nNext rank: **Year {}** ({next_range})",
                "▓".repeat(filled),
                "░".repeat(width - filled),
                current_hours,
                y + 1,
            )
        }
    };

    let total_voice_secs: i32 = voice_sessions.iter().map(|s| s.duration.unwrap_or(0)).sum();
    let total_sub_pts: i32 = submissions.iter().map(|s| s.points).sum();
    let (active_dur_str, active_pts_str) = if let Some((secs, pts)) = active_duration {
        (format!(" (+{} pending)", format_duration(secs)), format!(" (+{pts} pending)"))
    } else {
        (String::new(), String::new())
    };

    let tz_abbr = Utc::now().with_timezone(&tz).format("%Z").to_string();

    ctx.send(
        poise::CreateReply::default().embed(
            serenity::CreateEmbed::new()
                .color(BOT_COLOR_INFO)
                .title("Monthly Points Breakdown")
                .description(format!("Viewing monthly points for <@{discord_id}>"))
                .thumbnail(user.face())
                .field(format!("Activity ({tz_abbr})"), activity_str, false)
                .field(
                    "Monthly Totals",
                    format!(
                        "Study: {}{}\nSubmissions: {total_sub_pts} pts\n**Total: {} pts**{}",
                        format_duration(total_voice_secs),
                        active_dur_str,
                        user_row.monthly_points,
                        active_pts_str,
                    ),
                    false,
                )
                .field("Year Progress", year_progress, false)
                .footer(serenity::CreateEmbedFooter::new(format!(
                    "Month: {}",
                    Utc::now().format("%B %Y")
                ))),
        ),
    )
    .await?;
    Ok(())
}

/// View detailed individual voice sessions this month (Prefects/Owner only).
#[poise::command(slash_command, rename = "points-detailed")]
pub async fn points_detailed(
    ctx: Context<'_>,
    #[description = "User to check"] user: serenity::User,
) -> crate::error::Result {
    let data = ctx.data();

    let member = ctx.author_member().await;
    let allowed = member
        .as_ref()
        .map(|m| member_has_role(m, &data.config, ROLE_OWNER | ROLE_PREFECT))
        .unwrap_or(false);

    if !allowed {
        ctx.send(
            poise::CreateReply::default()
                .ephemeral(true)
                .content("This command is only available to Prefects and Owners."),
        )
        .await?;
        return Ok(());
    }

    ctx.defer().await?;

    let discord_id = user.id.get().to_string();

    let user_row = match crate::db::get_user(&data.pool, &discord_id).await? {
        Some(u) => u,
        None => {
            ctx.say(format!("{} is not registered.", user.name)).await?;
            return Ok(());
        }
    };

    let month_start = crate::db::get_month_start_date(&data.pool).await?;
    let tz: Tz = user_row.timezone.parse().unwrap_or(chrono_tz::UTC);

    let sessions = sqlx::query!(
        r#"SELECT duration, channel_name, joined_at, left_at
           FROM voice_session
           WHERE discord_id = $1 AND is_tracked = true AND left_at >= $2
           ORDER BY joined_at ASC"#,
        discord_id,
        month_start,
    )
    .fetch_all(&data.pool)
    .await?;

    // Merge consecutive same-channel sessions within 2 seconds
    struct Merged {
        channel: String,
        joined_at: chrono::NaiveDateTime,
        left_at: Option<chrono::NaiveDateTime>,
        duration: i32,
    }

    let mut merged: Vec<Merged> = vec![];
    for s in &sessions {
        let should_merge = if let Some(last) = merged.last_mut() {
            let same_channel = last.channel == s.channel_name;
            let consecutive = last.left_at.map(|la| {
                let diff = (s.joined_at - la).num_milliseconds().abs();
                diff < 2000
                    && la.and_utc().with_timezone(&tz).date_naive() == s.joined_at.and_utc().with_timezone(&tz).date_naive()
            }).unwrap_or(false);
            same_channel && consecutive
        } else {
            false
        };

        if should_merge {
            let last = merged.last_mut().unwrap();
            last.left_at = s.left_at;
            last.duration += s.duration.unwrap_or(0);
        } else {
            merged.push(Merged {
                channel: s.channel_name.clone(),
                joined_at: s.joined_at,
                left_at: s.left_at,
                duration: s.duration.unwrap_or(0),
            });
        }
    }

    let lines: Vec<String> = merged
        .iter()
        .map(|s| {
            let join_str = s.joined_at.and_utc().with_timezone(&tz).format("%-d %H:%M").to_string();
            let left_str = s
                .left_at
                .map(|l| l.and_utc().with_timezone(&tz).format("%H:%M").to_string())
                .unwrap_or_else(|| "ongoing".to_string());
            let channel = &s.channel
                .chars()
                .take(3)
                .collect::<String>();
            format!(
                "• {join_str}-{left_str} **{channel}** ({})",
                format_duration(s.duration)
            )
        })
        .collect();

    let description = if lines.is_empty() {
        "No sessions".to_string()
    } else {
        lines.join("\n")
    };

    ctx.send(
        poise::CreateReply::default().embed(
            serenity::CreateEmbed::new()
                .color(BOT_COLOR_INFO)
                .title(format!(
                    "{}'s Detailed Sessions",
                    user.global_name.as_deref().unwrap_or(&user.name)
                ))
                .description(description)
                .footer(serenity::CreateEmbedFooter::new(format!(
                    "Month: {} | TZ: {}",
                    Utc::now().format("%B %Y"),
                    tz
                ))),
        ),
    )
    .await?;
    Ok(())
}
