use chrono::{Duration, Utc};
use chrono_tz::Tz;
use poise::serenity_prelude as serenity;
use serenity::{
    ButtonStyle, ChannelId, ComponentInteraction,
    CreateActionRow, CreateButton, CreateEmbed, CreateInteractionResponse,
    CreateInteractionResponseMessage, CreateMessage, MessageId, ModalInteraction,
    CreateModal, CreateInputText, InputTextStyle,
};

use crate::bot::utils::interaction::{get_house_from_member, member_has_role};
use crate::constants::{
    DEFAULT_SUBMISSION_POINTS, ROLE_OWNER, ROLE_PREFECT, SUBMISSION_COLOR_APPROVED,
    SUBMISSION_COLOR_CANCELED, SUBMISSION_COLOR_PENDING, SUBMISSION_COLOR_REJECTED,
};
use crate::models::Submission;

use super::super::Context;

#[derive(Debug, poise::ChoiceParameter)]
pub enum SubmissionType {
    #[name = "New List"]
    New,
    #[name = "Completed List"]
    Completed,
}

impl SubmissionType {
    pub fn as_db_str(&self) -> &'static str {
        match self {
            SubmissionType::New => "NEW",
            SubmissionType::Completed => "COMPLETED",
        }
    }
}

/// Submit a to-do list screenshot for house points.
#[poise::command(slash_command)]
pub async fn submit(
    ctx: Context<'_>,
    #[description = "New list or completed list"] submission_type: SubmissionType,
    #[description = "Screenshot of your work"] screenshot: serenity::Attachment,
) -> crate::error::Result {
    let data = ctx.data();

    let member = match ctx.author_member().await {
        Some(m) => m,
        None => {
            ctx.say("This command must be used in a server.").await?;
            return Ok(());
        }
    };

    // Channel check (unless owner)
    let is_owner = member_has_role(&member, &data.config, ROLE_OWNER);
    let channel_id_str = ctx.channel_id().get().to_string();
    let allowed_channels: Vec<String> = data
        .config
        .submission_channel_ids
        .iter()
        .map(|id| id.to_string())
        .collect();

    if !is_owner && !allowed_channels.contains(&channel_id_str) {
        let channel_mentions: Vec<String> = allowed_channels
            .iter()
            .map(|id| format!("<#{id}>"))
            .collect();
        ctx.send(
            poise::CreateReply::default().ephemeral(true).embed(
                CreateEmbed::new()
                    .color(crate::constants::BOT_COLOR_ERROR)
                    .title("Invalid Channel")
                    .description(format!(
                        "You can use this command in: {}",
                        channel_mentions.join(", ")
                    )),
            ),
        )
        .await?;
        return Ok(());
    }

    let house = match get_house_from_member(&member, &data.config) {
        Some(h) => h,
        None => {
            ctx.send(
                poise::CreateReply::default().ephemeral(true).content(
                    "You don't have a house role assigned. Please contact staff.",
                ),
            )
            .await?;
            return Ok(());
        }
    };

    let user_tz = crate::db::get_user_timezone(&data.pool, &member.user.id.get().to_string()).await?;
    let tz: Tz = user_tz.parse().unwrap_or(chrono_tz::UTC);
    let now_local = Utc::now().with_timezone(&tz);
    let day_start = now_local
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_utc()
        .with_timezone(&tz);
    let day_end = day_start + Duration::days(1);

    let discord_id = member.user.id.get().to_string();
    let sub_type_str = submission_type.as_db_str();

    // Fetch today's submissions
    let same_day_subs: Vec<Submission> = sqlx::query_as!(
        Submission,
        r#"
        SELECT * FROM submission
        WHERE discord_id = $1
          AND submitted_at >= $2
          AND submitted_at < $3
          AND status IN ('PENDING', 'APPROVED')
          AND submission_type IS NOT NULL
        ORDER BY submitted_at ASC
        "#,
        discord_id,
        day_start.naive_utc(),
        day_end.naive_utc(),
    )
    .fetch_all(&data.pool)
    .await?;

    let existing_new = same_day_subs.iter().find(|s| s.submission_type.as_deref() == Some("NEW"));
    let existing_completed = same_day_subs.iter().find(|s| s.submission_type.as_deref() == Some("COMPLETED"));

    if sub_type_str == "NEW" && existing_new.is_some() {
        let first = &same_day_subs[0];
        let link = first
            .channel_id
            .as_ref()
            .zip(first.message_id.as_ref())
            .map(|(ch, msg)| format!("https://discord.com/channels/{}/{ch}/{msg}", data.config.guild_id));
        let label = match first.submission_type.as_deref() {
            Some("NEW") => "New List",
            Some("COMPLETED") => "Completed List",
            _ => "submission",
        };
        ctx.send(
            poise::CreateReply::default().ephemeral(true).embed(
                CreateEmbed::new()
                    .color(crate::constants::BOT_COLOR_ERROR)
                    .title("New List Already Submitted Today")
                    .description(format!(
                        "You already have a **{label}** with status **{}** today.{}",
                        first.status.to_lowercase(),
                        link.map(|l| format!(" [View it here]({l})")).unwrap_or_default()
                    )),
            ),
        )
        .await?;
        return Ok(());
    }

    if sub_type_str == "COMPLETED" && existing_completed.is_some() {
        let sub = existing_completed.unwrap();
        let link = sub
            .channel_id
            .as_ref()
            .zip(sub.message_id.as_ref())
            .map(|(ch, msg)| format!("https://discord.com/channels/{}/{ch}/{msg}", data.config.guild_id));
        ctx.send(
            poise::CreateReply::default().ephemeral(true).embed(
                CreateEmbed::new()
                    .color(crate::constants::BOT_COLOR_ERROR)
                    .title("Completed List Already Submitted Today")
                    .description(format!(
                        "You already have a **Completed List** with status **{}** today.{}",
                        sub.status.to_lowercase(),
                        link.map(|l| format!(" [View it here]({l})")).unwrap_or_default()
                    )),
            ),
        )
        .await?;
        return Ok(());
    }

    if sub_type_str == "COMPLETED" {
        if let Some(new_sub) = existing_new {
            let retry_time = new_sub.submitted_at + Duration::hours(1);
            if Utc::now().naive_utc() < retry_time {
                let too_late = retry_time >= day_end.naive_utc();
                let wait_msg = if too_late {
                    "It is too late to submit again today.".to_string()
                } else {
                    format!(
                        "Please wait until <t:{}:t> before submitting again.",
                        retry_time.and_utc().timestamp()
                    )
                };
                ctx.send(
                    poise::CreateReply::default().ephemeral(true).embed(
                        CreateEmbed::new()
                            .color(crate::constants::BOT_COLOR_ERROR)
                            .title("Please wait before submitting again")
                            .description(format!(
                                "**There must be at least an hour between your new and completed submissions**.\n{wait_msg}"
                            )),
                    ),
                )
                .await?;
                return Ok(());
            }
        }
    }

    let linked_sub_id: Option<i32> = if sub_type_str == "COMPLETED" {
        existing_new.map(|s| s.id)
    } else {
        None
    };

    let month_start = crate::db::get_month_start_date(&data.pool).await?;

    // Insert submission
    let new_sub: Submission = sqlx::query_as!(
        Submission,
        r#"
        INSERT INTO submission (discord_id, points, screenshot_url, house, submission_type, linked_submission_id, house_id)
        VALUES (
            $1, $2, $3, $4, $5, $6,
            (SELECT COUNT(*) + 1 FROM submission WHERE house = $7 AND submitted_at >= $8)
        )
        RETURNING *
        "#,
        discord_id,
        DEFAULT_SUBMISSION_POINTS,
        screenshot.url,
        house,
        sub_type_str,
        linked_sub_id,
        house,
        month_start,
    )
    .fetch_one(&data.pool)
    .await?;

    let linked_sub_for_display: Option<(Option<String>, Option<String>)> = linked_sub_id
        .and_then(|id| same_day_subs.iter().find(|s| s.id == id))
        .map(|s| (s.channel_id.clone(), s.message_id.clone()));

    let msg_content = build_submission_message(
        &new_sub,
        &user_tz,
        None,
        linked_sub_for_display.as_ref().map(|(ch, msg)| (ch.as_deref(), msg.as_deref())),
        data.config.guild_id,
    );

    // Reply and capture message ID
    let mut reply_builder = poise::CreateReply::default();
    for embed in msg_content.0 {
        reply_builder = reply_builder.embed(embed);
    }
    reply_builder = reply_builder.components(msg_content.1);
    let reply = ctx.send(reply_builder).await?;

    let message = reply.message().await?;

    // Store message ID
    sqlx::query!(
        "UPDATE submission SET message_id = $1, channel_id = $2 WHERE id = $3",
        message.id.get().to_string(),
        message.channel_id.get().to_string(),
        new_sub.id,
    )
    .execute(&data.pool)
    .await?;

    // Update linked submission message with cross-reference
    if let Some((Some(linked_ch), Some(linked_msg))) = linked_sub_for_display {
        if let (Ok(ch_id), Ok(msg_id)) = (linked_ch.parse::<u64>(), linked_msg.parse::<u64>()) {
            let ch = ChannelId::new(ch_id);
            let linked_sub = existing_new.unwrap().clone();
            let new_linked = (
                Some(message.channel_id.get().to_string()),
                Some(message.id.get().to_string()),
            );
            let updated_msg = build_submission_message(
                &linked_sub,
                &user_tz,
                None,
                Some((
                    new_linked.0.as_deref(),
                    new_linked.1.as_deref(),
                )),
                data.config.guild_id,
            );
            let _ = ch
                .edit_message(
                    ctx.http(),
                    MessageId::new(msg_id),
                    serenity::EditMessage::new()
                        .embeds(updated_msg.0)
                        .components(updated_msg.1),
                )
                .await;
        }
    }

    Ok(())
}

pub fn build_submission_message(
    sub: &Submission,
    user_tz: &str,
    reason: Option<&str>,
    linked: Option<(Option<&str>, Option<&str>)>,
    guild_id: u64,
) -> (Vec<CreateEmbed>, Vec<CreateActionRow>) {
    let color = match sub.status.as_str() {
        "APPROVED" => SUBMISSION_COLOR_APPROVED,
        "REJECTED" => SUBMISSION_COLOR_REJECTED,
        "CANCELED" => SUBMISSION_COLOR_CANCELED,
        _ => SUBMISSION_COLOR_PENDING,
    };

    let tz: Tz = user_tz.parse().unwrap_or(chrono_tz::UTC);
    let submitted_local = sub.submitted_at.and_utc().with_timezone(&tz);
    let formatted_time = submitted_local.format("%-I:%M %p on %b %-d (%Z)").to_string();

    let type_label = match sub.submission_type.as_deref() {
        Some("NEW") => "New List",
        Some("COMPLETED") => "Completed List",
        _ => "Unknown",
    };

    let mut embed = CreateEmbed::new()
        .color(color)
        .title(sub.house.to_uppercase())
        .field("Submission ID", sub.house_id.to_string(), false)
        .field("List Type", type_label, true)
        .field("Score", sub.points.to_string(), true)
        .field(
            "Submitted by",
            format!("<@{}> at {}", sub.discord_id, formatted_time),
            false,
        )
        .image(&sub.screenshot_url);

    if let Some((ch, msg)) = linked {
        if let (Some(ch), Some(msg)) = (ch, msg) {
            embed = embed.field(
                "Linked Submission",
                format!(
                    "[View linked submission](https://discord.com/channels/{guild_id}/{ch}/{msg})"
                ),
                false,
            );
        }
    }

    match sub.status.as_str() {
        "APPROVED" => {
            if let Some(reviewer) = &sub.reviewed_by {
                if let Some(reviewed_at) = sub.reviewed_at {
                    embed = embed.field(
                        "Approved by",
                        format!("<@{reviewer}> at <t:{}>", reviewed_at.and_utc().timestamp()),
                        false,
                    );
                }
            }
        }
        "REJECTED" => {
            if let Some(reviewer) = &sub.reviewed_by {
                if let Some(reviewed_at) = sub.reviewed_at {
                    embed = embed.field(
                        "Rejected by",
                        format!("<@{reviewer}> at <t:{}>", reviewed_at.and_utc().timestamp()),
                        false,
                    );
                }
            }
            if let Some(reason) = reason {
                embed = embed.field("Reason", reason, false);
            }
        }
        "CANCELED" => {
            embed = embed.field("Cancelled", "This submission was cancelled by the user.", false);
        }
        _ => {}
    }

    let components = if sub.status == "PENDING" {
        vec![CreateActionRow::Buttons(vec![
            CreateButton::new(format!("submit|approve|{}", sub.id))
                .label(format!("Approve {} points", sub.points))
                .style(ButtonStyle::Success),
            CreateButton::new(format!("submit|reject|{}", sub.id))
                .label("Reject")
                .style(ButtonStyle::Secondary),
            CreateButton::new(format!("submit|cancel|{}", sub.id))
                .label("Cancel")
                .style(ButtonStyle::Secondary),
        ])]
    } else {
        vec![]
    };

    (vec![embed], components)
}

// ─── Button handler ────────────────────────────────────────────────────────

pub async fn handle_submit_button(
    ctx: &serenity::Context,
    component: &ComponentInteraction,
    data: &crate::bot::Data,
) -> anyhow::Result<()> {
    let parts: Vec<&str> = component.data.custom_id.splitn(3, '|').collect();
    if parts.len() < 3 {
        return Ok(());
    }
    let event = parts[1];
    let sub_id: i32 = parts[2].parse().unwrap_or(0);

    let member = match &component.member {
        Some(m) => m.clone(),
        None => return Ok(()),
    };

    match event {
        "cancel" => handle_cancel(ctx, component, &data.pool, &member, sub_id, data.config.guild_id).await,
        "approve" => handle_approve(ctx, component, &data.pool, &member, sub_id, data).await,
        "reject" => handle_reject(ctx, component, &data.pool, &member, sub_id, data).await,
        _ => Ok(()),
    }
}

async fn handle_cancel(
    ctx: &serenity::Context,
    component: &ComponentInteraction,
    pool: &sqlx::PgPool,
    member: &serenity::Member,
    sub_id: i32,
    guild_id: u64,
) -> anyhow::Result<()> {
    component
        .create_response(ctx, CreateInteractionResponse::Acknowledge)
        .await?;

    let discord_id = member.user.id.get().to_string();

    let canceled: Option<Submission> = sqlx::query_as!(
        Submission,
        r#"
        UPDATE submission
        SET status = 'CANCELED', reviewed_at = NOW(), reviewed_by = $1
        WHERE id = $2 AND status = 'PENDING' AND discord_id = $3
        RETURNING *
        "#,
        discord_id,
        sub_id,
        discord_id,
    )
    .fetch_optional(pool)
    .await?;

    let msg = match canceled {
        None => {
            component
                .create_followup(
                    ctx,
                    serenity::CreateInteractionResponseFollowup::new()
                        .ephemeral(true)
                        .content("This submission has already been reviewed or belongs to another user."),
                )
                .await?;
            return Ok(());
        }
        Some(s) => s,
    };

    let user_tz = crate::db::get_user_timezone(pool, &discord_id).await?;
    let (embeds, components) = build_submission_message(&msg, &user_tz, None, None, guild_id);
    let mut edit_builder = serenity::EditInteractionResponse::new();
    for embed in embeds {
        edit_builder = edit_builder.embed(embed);
    }
    edit_builder = edit_builder.components(components);
    component.edit_response(ctx, edit_builder).await?;
    Ok(())
}

async fn handle_approve(
    ctx: &serenity::Context,
    component: &ComponentInteraction,
    pool: &sqlx::PgPool,
    member: &serenity::Member,
    sub_id: i32,
    data: &crate::bot::Data,
) -> anyhow::Result<()> {
    if !member_has_role(member, &data.config, ROLE_PREFECT | ROLE_OWNER) {
        component
            .create_response(
                ctx,
                CreateInteractionResponse::Message(
                    CreateInteractionResponseMessage::new()
                        .ephemeral(true)
                        .content("You don't have permission to approve submissions."),
                ),
            )
            .await?;
        return Ok(());
    }

    component
        .create_response(ctx, CreateInteractionResponse::Acknowledge)
        .await?;

    let reviewer_id = member.user.id.get().to_string();

    let approved: Option<Submission> = sqlx::query_as!(
        Submission,
        r#"
        UPDATE submission
        SET status = 'APPROVED', reviewed_at = NOW(), reviewed_by = $1
        WHERE id = $2 AND status = 'PENDING'
        RETURNING *
        "#,
        reviewer_id,
        sub_id,
    )
    .fetch_optional(pool)
    .await?;

    let sub = match approved {
        None => {
            component
                .create_followup(
                    ctx,
                    serenity::CreateInteractionResponseFollowup::new()
                        .ephemeral(true)
                        .content("This submission has already been reviewed."),
                )
                .await?;
            return Ok(());
        }
        Some(s) => s,
    };

    crate::services::points::award_points(pool, &sub.discord_id, sub.points).await?;

    let linked = fetch_linked_submission(pool, &sub).await;
    let user_tz = crate::db::get_user_timezone(pool, &sub.discord_id).await?;
    let (embeds, components) = build_submission_message(
        &sub,
        &user_tz,
        None,
        linked.as_ref().map(|(ch, msg)| (ch.as_deref(), msg.as_deref())),
        data.config.guild_id,
    );
    let mut edit_builder = serenity::EditInteractionResponse::new();
    for embed in embeds {
        edit_builder = edit_builder.embed(embed);
    }
    edit_builder = edit_builder.components(components);
    component.edit_response(ctx, edit_builder).await?;
    Ok(())
}

async fn handle_reject(
    ctx: &serenity::Context,
    component: &ComponentInteraction,
    _pool: &sqlx::PgPool,
    member: &serenity::Member,
    sub_id: i32,
    data: &crate::bot::Data,
) -> anyhow::Result<()> {
    if !member_has_role(member, &data.config, ROLE_PREFECT | ROLE_OWNER) {
        component
            .create_response(
                ctx,
                CreateInteractionResponse::Message(
                    CreateInteractionResponseMessage::new()
                        .ephemeral(true)
                        .content("You don't have permission to reject submissions."),
                ),
            )
            .await?;
        return Ok(());
    }

    // Show modal for rejection reason
    let modal_id = format!("rejectModal|{sub_id}");
    component
        .create_response(
            ctx,
            CreateInteractionResponse::Modal(
                CreateModal::new(&modal_id, "Reject Submission").components(vec![
                    CreateActionRow::InputText(
                        CreateInputText::new(
                            InputTextStyle::Short,
                            "Please provide a reason for rejection:",
                            "reasonInput",
                        )
                        .required(true),
                    ),
                ]),
            ),
        )
        .await?;
    Ok(())
}

pub async fn handle_reject_modal(
    ctx: &serenity::Context,
    modal: &ModalInteraction,
    data: &crate::bot::Data,
) -> anyhow::Result<()> {
    let parts: Vec<&str> = modal.data.custom_id.splitn(2, '|').collect();
    if parts.len() < 2 {
        return Ok(());
    }
    let sub_id: i32 = parts[1].parse().unwrap_or(0);

    // Extract reason from modal
    let reason = modal
        .data
        .components
        .iter()
        .flat_map(|row| row.components.iter())
        .find_map(|c| {
            if let serenity::ActionRowComponent::InputText(input) = c {
                if input.custom_id == "reasonInput" {
                    return input.value.clone();
                }
            }
            None
        })
        .unwrap_or_default();

    modal
        .create_response(ctx, CreateInteractionResponse::Acknowledge)
        .await?;

    let member = match &modal.member {
        Some(m) => m.clone(),
        None => return Ok(()),
    };
    let reviewer_id = member.user.id.get().to_string();

    let pool = &data.pool;

    let rejected: Option<Submission> = sqlx::query_as!(
        Submission,
        r#"
        UPDATE submission
        SET status = 'REJECTED', reviewed_at = NOW(), reviewed_by = $1
        WHERE id = $2 AND status = 'PENDING'
        RETURNING *
        "#,
        reviewer_id,
        sub_id,
    )
    .fetch_optional(pool)
    .await?;

    let sub = match rejected {
        None => {
            modal
                .create_followup(
                    ctx,
                    serenity::CreateInteractionResponseFollowup::new()
                        .ephemeral(true)
                        .content("This submission has already been reviewed."),
                )
                .await?;
            return Ok(());
        }
        Some(s) => s,
    };

    let linked = fetch_linked_submission(pool, &sub).await;
    let user_tz = crate::db::get_user_timezone(pool, &sub.discord_id).await?;
    let (embeds, components) = build_submission_message(
        &sub,
        &user_tz,
        Some(&reason),
        linked.as_ref().map(|(ch, msg)| (ch.as_deref(), msg.as_deref())),
        data.config.guild_id,
    );
    modal
        .edit_response(
            ctx,
            serenity::EditInteractionResponse::new()
                .embeds(embeds)
                .components(components),
        )
        .await?;

    // Notify submitter
    let channel_id = modal.channel_id;
    let msg_link = format!(
        "https://discord.com/channels/{}/{}/{}",
        data.config.guild_id,
        channel_id,
        modal.message.as_ref().map(|m| m.id.get().to_string()).unwrap_or_default()
    );
    let _ = channel_id
        .send_message(
            ctx,
            CreateMessage::new().content(format!(
                "<@{}> Your [submission]({msg_link}) was rejected. Reason: {reason}",
                sub.discord_id
            )),
        )
        .await;

    Ok(())
}

async fn fetch_linked_submission(
    pool: &sqlx::PgPool,
    sub: &Submission,
) -> Option<(Option<String>, Option<String>)> {
    // Find linked submission (either we link to it, or it links to us)
    let result = sqlx::query!(
        r#"
        SELECT channel_id, message_id FROM submission
        WHERE ($1::INT IS NOT NULL AND id = $1)
           OR linked_submission_id = $2
        LIMIT 1
        "#,
        sub.linked_submission_id,
        sub.id,
    )
    .fetch_optional(pool)
    .await
    .ok()??;

    Some((result.channel_id, result.message_id))
}
