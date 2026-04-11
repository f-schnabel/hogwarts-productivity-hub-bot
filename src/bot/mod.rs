pub mod commands;
pub mod events;
pub mod utils;

use std::sync::Arc;

use poise::serenity_prelude as serenity;
use sqlx::PgPool;
use tracing::info;

use crate::config::Config;
use crate::error::Error;
use crate::metrics::INTERACTION_TIMER;

// ─── Shared bot data ────────────────────────────────────────────────────────

/// Data shared across all poise commands and event handlers.
pub struct Data {
    pub pool: PgPool,
    pub config: Arc<Config>,
}

/// The poise Context type alias used throughout commands.
pub type Context<'a> = poise::Context<'a, Data, Error>;

// ─── Framework setup ────────────────────────────────────────────────────────

pub async fn build_client(
    pool: PgPool,
    config: Arc<Config>,
) -> anyhow::Result<serenity::Client> {
    let data = Data {
        pool,
        config: config.clone(),
    };

    let framework = poise::Framework::builder()
        .options(poise::FrameworkOptions {
            commands: commands::all_commands(),
            on_error: |err| Box::pin(on_error(err)),
            pre_command: |ctx| {
                Box::pin(async move {
                    let cmd = ctx.command().name.as_str();
                    info!(command = cmd, user = %ctx.author().id, "Command invoked");
                })
            },
            post_command: |ctx| {
                Box::pin(async move {
                    let cmd = ctx.command().name.as_str();
                    let sub = ctx.command().qualified_name.as_str();
                    INTERACTION_TIMER
                        .get_metric_with_label_values(&[cmd, sub, ""])
                        .map(|h| h.observe(0.0))
                        .ok();
                })
            },
            event_handler: |ctx, event, framework, data| {
                Box::pin(events::event_handler(ctx, event, framework, data))
            },
            ..Default::default()
        })
        .setup(move |ctx, _ready, framework| {
            Box::pin(async move {
                // Register slash commands globally
                poise::builtins::register_globally(ctx, &framework.options().commands).await?;
                info!("Slash commands registered globally");
                Ok(data)
            })
        })
        .build();

    let intents = serenity::GatewayIntents::GUILDS
        | serenity::GatewayIntents::GUILD_MEMBERS
        | serenity::GatewayIntents::GUILD_VOICE_STATES
        | serenity::GatewayIntents::GUILD_MESSAGES
        | serenity::GatewayIntents::GUILD_MESSAGE_REACTIONS
        | serenity::GatewayIntents::MESSAGE_CONTENT;

    let client = serenity::ClientBuilder::new(&config.discord_token, intents)
        .framework(framework)
        .await?;

    Ok(client)
}

// ─── Error handler ─────────────────────────────────────────────────────────

async fn on_error(err: poise::FrameworkError<'_, Data, Error>) {
    match err {
        poise::FrameworkError::Setup { error, .. } => {
            tracing::error!("Framework setup error: {error:#}");
        }
        poise::FrameworkError::Command { error, ctx, .. } => {
            let cmd = ctx.command().name.as_str();
            let user = ctx.author().id;
            tracing::error!(command = cmd, user = %user, "Command error: {error:#}");

            // Alert owner
            let http = ctx.serenity_context().http.clone();
            let owner_id = ctx.data().config.owner_id;
            utils::alerting::alert_owner(
                &http,
                owner_id,
                &format!("Command /{cmd} failed for user {user}: {error}"),
            )
            .await;

            // Reply with error to user
            let reply = poise::CreateReply::default()
                .ephemeral(true)
                .content("An error occurred. Please try again later.");
            let _ = ctx.send(reply).await;
        }
        poise::FrameworkError::CommandCheckFailed { error, ctx, .. } => {
            if let Some(e) = error {
                tracing::error!(command = ctx.command().name, "Check failed: {e:#}");
            }
        }
        other => {
            tracing::error!("Unhandled poise error: {other}");
        }
    }
}
