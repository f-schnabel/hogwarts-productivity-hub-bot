use std::env;

#[derive(Debug, Clone)]
pub struct Config {
    pub discord_token: String,
    pub client_id: u64,
    pub guild_id: u64,
    pub database_url: String,
    pub owner_id: u64,

    // House roles
    pub gryffindor_role_id: u64,
    pub slytherin_role_id: u64,
    pub hufflepuff_role_id: u64,
    pub ravenclaw_role_id: u64,

    // House crest emoji IDs (optional)
    pub gryffindor_crest_emoji_id: Option<String>,
    pub slytherin_crest_emoji_id: Option<String>,
    pub hufflepuff_crest_emoji_id: Option<String>,
    pub ravenclaw_crest_emoji_id: Option<String>,

    // Staff roles
    pub prefect_role_id: u64,
    pub professor_role_id: u64,

    // VC role
    pub vc_role_id: u64,

    // Year roles (7 roles, comma-separated)
    pub year_role_ids: Vec<u64>,
    pub year_announcement_channel_id: u64,

    // Channels
    pub exclude_voice_channel_ids: Vec<u64>,
    pub submission_channel_ids: Vec<u64>,
    pub journal_channel_id: Option<u64>,
    pub counting_channel_id: Option<u64>,

    // Analytics
    pub mystery_secret: Option<String>,
}

fn require_env(key: &str) -> anyhow::Result<String> {
    env::var(key).map_err(|_| anyhow::anyhow!("Missing required env var: {key}"))
}

fn require_env_u64(key: &str) -> anyhow::Result<u64> {
    require_env(key)?
        .parse::<u64>()
        .map_err(|e| anyhow::anyhow!("Invalid u64 for {key}: {e}"))
}

fn parse_comma_u64(val: &str) -> Vec<u64> {
    val.split(',')
        .filter_map(|s| s.trim().parse::<u64>().ok())
        .collect()
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let db_host = env::var("DB_HOST").unwrap_or_else(|_| "localhost".into());
        let db_name = require_env("DB_NAME")?;
        let db_user = require_env("DB_USER")?;
        let db_pass = require_env("DB_PASSWORD")?;
        let database_url = format!("postgres://{db_user}:{db_pass}@{db_host}/{db_name}");

        let year_role_ids_str =
            env::var("YEAR_ROLE_IDS").unwrap_or_default();
        let exclude_vc_str =
            env::var("EXCLUDE_VOICE_CHANNEL_IDS").unwrap_or_default();
        let submission_ch_str = require_env("SUBMISSION_CHANNEL_IDS")?;

        Ok(Self {
            discord_token: require_env("DISCORD_TOKEN")?,
            client_id: require_env_u64("CLIENT_ID")?,
            guild_id: require_env_u64("GUILD_ID")?,
            database_url,
            owner_id: require_env_u64("OWNER_ID")?,

            gryffindor_role_id: require_env_u64("GRYFFINDOR_ROLE_ID")?,
            slytherin_role_id: require_env_u64("SLYTHERIN_ROLE_ID")?,
            hufflepuff_role_id: require_env_u64("HUFFLEPUFF_ROLE_ID")?,
            ravenclaw_role_id: require_env_u64("RAVENCLAW_ROLE_ID")?,

            gryffindor_crest_emoji_id: env::var("GRYFFINDOR_CREST_EMOJI_ID").ok(),
            slytherin_crest_emoji_id: env::var("SLYTHERIN_CREST_EMOJI_ID").ok(),
            hufflepuff_crest_emoji_id: env::var("HUFFLEPUFF_CREST_EMOJI_ID").ok(),
            ravenclaw_crest_emoji_id: env::var("RAVENCLAW_CREST_EMOJI_ID").ok(),

            prefect_role_id: require_env_u64("PREFECT_ROLE_ID")?,
            professor_role_id: require_env_u64("PROFESSOR_ROLE_ID")?,
            vc_role_id: require_env_u64("VC_ROLE_ID")?,

            year_role_ids: parse_comma_u64(&year_role_ids_str),
            year_announcement_channel_id: env::var("YEAR_ANNOUNCEMENT_CHANNEL_ID")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(0),

            exclude_voice_channel_ids: parse_comma_u64(&exclude_vc_str),
            submission_channel_ids: parse_comma_u64(&submission_ch_str),
            journal_channel_id: env::var("JOURNAL_CHANNEL_ID")
                .ok()
                .and_then(|s| s.parse().ok()),
            counting_channel_id: env::var("COUNTING_CHANNEL_ID")
                .ok()
                .and_then(|s| s.parse().ok()),

            mystery_secret: env::var("MYSTERY_SECRET").ok(),
        })
    }
}
