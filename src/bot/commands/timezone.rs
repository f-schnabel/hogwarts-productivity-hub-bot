use chrono::Utc;
use chrono_tz::TZ_VARIANTS;
use poise::serenity_prelude as serenity;

use crate::bot::utils::interaction::{error_message, member_has_role};
use crate::constants::{BOT_COLOR_SUCCESS, BOT_COLOR_WARNING, ROLE_OWNER, ROLE_PREFECT, ROLE_PROFESSOR};

use super::super::Context;

// ─── Autocomplete ──────────────────────────────────────────────────────────

async fn timezone_autocomplete<'a>(
    _ctx: Context<'a>,
    partial: &'a str,
) -> Vec<poise::AutocompleteChoice<String>> {
    let query = partial.to_lowercase();
    let words: Vec<&str> = query.split_whitespace().collect();

    let mut scored: Vec<(i32, String, String)> = TZ_VARIANTS
        .iter()
        .filter_map(|tz| {
            let name = tz.name();
            let name_lower = name.to_lowercase();
            let score = score_timezone(name, &name_lower, &words);
            if score > 0 || words.is_empty() {
                let now = Utc::now().with_timezone(tz);
                let display = format!("{name} ({})", now.format("%H:%M"));
                Some((score, display, name.to_string()))
            } else {
                None
            }
        })
        .collect();

    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.2.cmp(&b.2)));

    scored
        .into_iter()
        .take(25)
        .map(|(_, display, value)| poise::AutocompleteChoice::new(display, value))
        .collect()
}

fn score_timezone(name: &str, name_lower: &str, words: &[&str]) -> i32 {
    if words.is_empty() {
        return 1;
    }
    let mut total = 0;
    for word in words {
        if name_lower == *word {
            total += 10;
        } else if name_lower.contains(word) {
            total += 4;
        } else if is_offset_query(word) {
            // offset matching is handled above
        } else {
            // Check continent/city parts
            let parts: Vec<&str> = name.split('/').collect();
            for part in &parts {
                if part.to_lowercase().contains(word) {
                    total += 3;
                }
            }
        }
    }
    total
}

fn is_offset_query(s: &str) -> bool {
    s.chars().all(|c| c.is_ascii_digit() || c == '+' || c == '-' || c == ':')
}

// ─── Command ───────────────────────────────────────────────────────────────

/// Manage your timezone for accurate daily/monthly resets.
#[poise::command(slash_command, ephemeral)]
pub async fn timezone(
    ctx: Context<'_>,
    #[description = "Your timezone (e.g. America/New_York). Leave blank to view current."]
    #[autocomplete = "timezone_autocomplete"]
    timezone_name: Option<String>,
    #[description = "User to manage timezone for (Prefects/Professors only)"]
    user: Option<serenity::User>,
) -> crate::error::Result {
    let data = ctx.data();

    let mut discord_id = ctx.author().id.get().to_string();
    let mut whose = "Your".to_string();

    if let Some(ref target_user) = user {
        if target_user.id != ctx.author().id {
            // Require Prefect/Professor/Owner role
            let member = ctx.author_member().await;
            let allowed = member
                .as_ref()
                .map(|m| member_has_role(m, &data.config, ROLE_PREFECT | ROLE_PROFESSOR | ROLE_OWNER))
                .unwrap_or(false);

            if !allowed {
                ctx.send(poise::CreateReply::default().reply(true).content(
                    "You don't have permission to manage other users' timezones.",
                ))
                .await?;
                return Ok(());
            }
            discord_id = target_user.id.get().to_string();
            whose = format!(
                "{}'s",
                target_user.global_name.as_deref().unwrap_or(&target_user.name)
            );
        }
    }

    if let Some(ref tz_str) = timezone_name {
        set_timezone(ctx, &data.pool, &discord_id, &whose, tz_str).await
    } else {
        view_timezone(ctx, &data.pool, &discord_id, &whose).await
    }
}

async fn view_timezone(
    ctx: Context<'_>,
    pool: &sqlx::PgPool,
    discord_id: &str,
    whose: &str,
) -> crate::error::Result {
    let tz_str = crate::db::get_user_timezone(pool, discord_id).await?;
    let tz: chrono_tz::Tz = tz_str.parse().unwrap_or(chrono_tz::UTC);
    let local_time = Utc::now().with_timezone(&tz);

    ctx.send(
        poise::CreateReply::default().embed(
            serenity::CreateEmbed::new()
                .color(BOT_COLOR_SUCCESS)
                .description(format!(
                    "{whose} timezone is currently set to `{tz_str}` (Currently {})",
                    local_time.format("%H:%M")
                )),
        ),
    )
    .await?;
    Ok(())
}

async fn set_timezone(
    ctx: Context<'_>,
    pool: &sqlx::PgPool,
    discord_id: &str,
    whose: &str,
    tz_str: &str,
) -> crate::error::Result {
    // Validate
    let tz: chrono_tz::Tz = match tz_str.parse() {
        Ok(tz) => tz,
        Err(_) => {
            ctx.send(
                poise::CreateReply::default().reply(true).components(vec![]).embed(
                    serenity::CreateEmbed::new()
                        .color(crate::constants::BOT_COLOR_ERROR)
                        .title("Invalid Timezone")
                        .description(format!(
                            "The timezone `{tz_str}` is not valid.\nCheck the [IANA timezone list](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)"
                        )),
                ),
            )
            .await?;
            return Ok(());
        }
    };

    let old_tz = crate::db::get_user_timezone(pool, discord_id).await?;
    if old_tz == tz_str {
        ctx.send(
            poise::CreateReply::default().embed(
                serenity::CreateEmbed::new()
                    .color(BOT_COLOR_WARNING)
                    .title("No Change Needed")
                    .description(format!(
                        "{whose} timezone is already set to `{tz_str}`."
                    )),
            ),
        )
        .await?;
        return Ok(());
    }

    let rows_affected = crate::db::update_user_timezone(pool, discord_id, tz_str).await?;
    if rows_affected == 0 {
        ctx.send(
            poise::CreateReply::default().reply(true).embed(
                serenity::CreateEmbed::new()
                    .color(crate::constants::BOT_COLOR_ERROR)
                    .title("Timezone Update Failed")
                    .description(format!(
                        "Failed to update {}'s timezone. Are they registered?",
                        whose.to_lowercase()
                    )),
            ),
        )
        .await?;
        return Ok(());
    }

    let local_time = Utc::now().with_timezone(&tz);

    ctx.send(
        poise::CreateReply::default().embed(
            serenity::CreateEmbed::new()
                .color(BOT_COLOR_SUCCESS)
                .title("Timezone Updated Successfully")
                .field(
                    format!("{whose} New Local Time"),
                    local_time.format("%A, %B %-d, %Y at %-I:%M %p").to_string(),
                    true,
                ),
        ),
    )
    .await?;
    Ok(())
}
