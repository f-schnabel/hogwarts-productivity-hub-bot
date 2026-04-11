pub mod admin;
pub mod scoreboard;
pub mod submit;
pub mod timezone;
pub mod user;

use crate::bot::Context;

pub fn all_commands() -> Vec<poise::Command<crate::bot::Data, crate::error::Error>> {
    vec![
        admin::admin_cmd(),
        scoreboard::scoreboard(),
        submit::submit(),
        timezone::timezone(),
        user::user_cmd(),
    ]
}
