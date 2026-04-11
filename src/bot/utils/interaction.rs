use serenity::all::{
    CreateEmbed, CreateInteractionResponse, CreateInteractionResponseMessage, Interaction,
    Member,
};

use crate::config::Config;
use crate::constants::{BOT_COLOR_ERROR, ROLE_OWNER, ROLE_PREFECT, ROLE_PROFESSOR};

use super::roles::has_any_role;

/// Format a duration in seconds as "Xh Ymin Zsec".
pub fn format_duration(secs: i32) -> String {
    let h = secs / 3600;
    let m = (secs % 3600) / 60;
    let s = secs % 60;
    match (h, m, s) {
        (0, 0, s) => format!("{s}sec"),
        (0, m, 0) => format!("{m}min"),
        (0, m, s) => format!("{m}min {s}sec"),
        (h, 0, 0) => format!("{h}h"),
        (h, m, 0) => format!("{h}h {m}min"),
        (h, m, s) => format!("{h}h {m}min {s}sec"),
    }
}

/// Build a standardised error embed response message.
pub fn error_message(title: &str, description: &str) -> CreateInteractionResponseMessage {
    CreateInteractionResponseMessage::new()
        .ephemeral(true)
        .embed(
            CreateEmbed::new()
                .color(BOT_COLOR_ERROR)
                .title(title)
                .description(description),
        )
}

/// Check that the invoking member has at least one of the roles in `role_mask`.
/// Returns `true` if they do, replies with an error and returns `false` otherwise.
pub fn member_has_role(
    member: &Member,
    config: &Config,
    role_mask: u8,
) -> bool {
    has_any_role(member, config, role_mask)
}

/// Return the house name for a member based on their house roles, or None.
pub fn get_house_from_member(member: &Member, config: &Config) -> Option<String> {
    let houses = [
        (config.gryffindor_role_id, "Gryffindor"),
        (config.slytherin_role_id, "Slytherin"),
        (config.hufflepuff_role_id, "Hufflepuff"),
        (config.ravenclaw_role_id, "Ravenclaw"),
    ];

    for (role_id, house) in houses {
        if member
            .roles
            .contains(&serenity::all::RoleId::new(role_id))
        {
            return Some(house.to_string());
        }
    }
    None
}
