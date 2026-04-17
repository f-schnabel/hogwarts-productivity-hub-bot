use serenity::all::UserId;
use tracing::error;

/// DM the bot owner with an alert message.
pub async fn alert_owner(http: &serenity::http::Http, owner_id: u64, message: &str) {
    let result = async {
        let channel = UserId::new(owner_id)
            .create_dm_channel(http)
            .await?;
        channel
            .say(http, message)
            .await?;
        anyhow::Ok(())
    }
    .await;

    if let Err(e) = result {
        error!("Failed to alert owner: {e}");
    }
}
