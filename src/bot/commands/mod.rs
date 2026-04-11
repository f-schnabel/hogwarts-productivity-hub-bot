pub mod admin;
pub mod scoreboard;
pub mod submit;
pub mod timezone;
pub mod user;

pub fn all_commands() -> Vec<poise::Command<crate::bot::Data, crate::error::Error>> {
    vec![
        admin::admin(),
        scoreboard::scoreboard(),
        submit::submit(),
        timezone::timezone(),
        user::user_cmd(),
    ]
}
