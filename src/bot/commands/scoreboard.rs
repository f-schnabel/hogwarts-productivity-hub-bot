use poise::serenity_prelude as serenity;

use crate::bot::utils::interaction::member_has_role;
use crate::bot::utils::scoreboard::build_scoreboard_embed;
use crate::constants::{ROLE_OWNER, ROLE_PROFESSOR};

use super::super::Context;

#[derive(Debug, poise::ChoiceParameter)]
pub enum House {
    Gryffindor,
    Hufflepuff,
    Ravenclaw,
    Slytherin,
}

impl House {
    pub fn as_str(&self) -> &'static str {
        match self {
            House::Gryffindor => "Gryffindor",
            House::Hufflepuff => "Hufflepuff",
            House::Ravenclaw => "Ravenclaw",
            House::Slytherin => "Slytherin",
        }
    }
}

/// Display and register a live house points scoreboard.
#[poise::command(slash_command)]
pub async fn scoreboard(
    ctx: Context<'_>,
    #[description = "Choose a house to display"] house: House,
) -> crate::error::Result {
    let data = ctx.data();

    // Require Professor or Owner role
    let member = ctx.author_member().await;
    let allowed = member
        .as_ref()
        .map(|m| member_has_role(m, &data.config, ROLE_PROFESSOR | ROLE_OWNER))
        .unwrap_or(false);

    if !allowed {
        ctx.send(
            poise::CreateReply::default()
                .reply(true)
                .ephemeral(true)
                .content("You don't have permission to use this command."),
        )
        .await?;
        return Ok(());
    }

    ctx.defer().await?;

    let guild_id = match ctx.guild_id() {
        Some(id) => id,
        None => {
            ctx.say("This command must be used in a server.").await?;
            return Ok(());
        }
    };

    let house_str = house.as_str();
    let crest_emoji_id = match house_str {
        "Gryffindor" => data.config.gryffindor_crest_emoji_id.as_deref(),
        "Slytherin" => data.config.slytherin_crest_emoji_id.as_deref(),
        "Hufflepuff" => data.config.hufflepuff_crest_emoji_id.as_deref(),
        "Ravenclaw" => data.config.ravenclaw_crest_emoji_id.as_deref(),
        _ => None,
    };

    let embed = build_scoreboard_embed(
        &data.pool,
        ctx.http(),
        ctx.cache().unwrap(),
        guild_id,
        house_str,
        crest_emoji_id,
    )
    .await?;

    // Send and register the scoreboard message
    let reply = ctx
        .send(poise::CreateReply::default().embed(embed))
        .await?;

    let message = reply.message().await?;

    sqlx::query!(
        "INSERT INTO house_scoreboard (house, channel_id, message_id) VALUES ($1, $2, $3)",
        house_str,
        message.channel_id.get().to_string(),
        message.id.get().to_string(),
    )
    .execute(&data.pool)
    .await?;

    Ok(())
}
