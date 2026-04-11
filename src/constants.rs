pub const HOUSES: [&str; 4] = ["Gryffindor", "Hufflepuff", "Ravenclaw", "Slytherin"];

pub const HOUSE_COLORS: [(&str, u32); 4] = [
    ("Gryffindor", 0xff2000),
    ("Hufflepuff", 0xf8d301),
    ("Ravenclaw", 0x110091),
    ("Slytherin", 0x07ad34),
];

// Analytics-adjusted colors for dark backgrounds
pub const ANALYTICS_HOUSE_COLORS: [(&str, &str); 4] = [
    ("Gryffindor", "#ff2000"),
    ("Hufflepuff", "#f8d301"),
    ("Ravenclaw", "#5b7fc7"), // lightened for dark background
    ("Slytherin", "#07ad34"),
];

pub const BOT_COLOR_SUCCESS: u32 = 0x00c853;
pub const BOT_COLOR_WARNING: u32 = 0xff8f00;
pub const BOT_COLOR_ERROR: u32 = 0xd84315;
pub const BOT_COLOR_INFO: u32 = 0x2196f3;

pub const SUBMISSION_COLOR_PENDING: u32 = 0x979c9f;
pub const SUBMISSION_COLOR_APPROVED: u32 = 0x2ecc70;
pub const SUBMISSION_COLOR_REJECTED: u32 = 0xe74d3c;
pub const SUBMISSION_COLOR_CANCELED: u32 = 0x979c9f;

// Role bitmask flags
pub const ROLE_OWNER: u8 = 1 << 0;
pub const ROLE_PREFECT: u8 = 1 << 1;
pub const ROLE_PROFESSOR: u8 = 1 << 2;

// Points
pub const DEFAULT_SUBMISSION_POINTS: i32 = 5;
pub const MIN_MONTHLY_POINTS_FOR_WEIGHTED: i32 = 15;
pub const MIN_DAILY_MESSAGES_FOR_STREAK: i32 = 3;
pub const FIRST_HOUR_POINTS: i32 = 5;
pub const REST_HOURS_POINTS: i32 = 2;
pub const MAX_HOURS_PER_DAY: i32 = 12;

// Session limits
/// Max age for a session to be resumed on startup (24 hours in milliseconds)
pub const MAX_SESSION_AGE_SECS: i64 = 24 * 60 * 60;

// Safety threshold for user deletion
pub const MIN_USERS_FOR_SAFE_DELETION: usize = 100;

// Year thresholds in hours (index = year - 1)
pub const YEAR_THRESHOLDS_HOURS: [u32; 7] = [1, 10, 20, 40, 80, 100, 120];

pub const YEAR_MESSAGES: [(&str, &str); 4] = [
    ("Gryffindor", "🦁 True courage lies in perseverance. You rise to {ROLE} with **{HOURS}** of steadfast effort."),
    ("Slytherin", "🐍 Ambition well applied brings results. {ROLE} claimed after **{HOURS}** of focused study."),
    ("Hufflepuff", "🌟 Your consistency shines brightest. {ROLE} earned through **{HOURS}** in the study halls."),
    ("Ravenclaw", "✒️ Each hour sharpened your mind — {ROLE} is now yours after **{HOURS}**. Wisdom suits you."),
];

pub const YEAR_COLORS: [(&str, &str); 8] = [
    ("0", "#888888"),
    ("1", "#cd8b62"),
    ("2", "#d3d3d3"),
    ("3", "#ffd700"),
    ("4", "#5f9ea0"),
    ("5", "#ba55d3"),
    ("6", "#39ff14"),
    ("7", "#ff4654"),
];

pub const SETTINGS_KEY_LAST_MONTHLY_RESET: &str = "lastMonthlyReset";
pub const SETTINGS_KEY_VC_EMOJI: &str = "vcEmoji";
pub const SETTINGS_KEY_COUNTING_COUNT: &str = "countingCount";
pub const SETTINGS_KEY_COUNTING_DISCORD_ID: &str = "countingDiscordId";

pub fn get_house_color(house: &str) -> u32 {
    HOUSE_COLORS
        .iter()
        .find(|(h, _)| *h == house)
        .map(|(_, c)| *c)
        .unwrap_or(0x888888)
}

pub fn get_analytics_house_color(house: Option<&str>) -> &'static str {
    match house {
        Some(h) => ANALYTICS_HOUSE_COLORS
            .iter()
            .find(|(name, _)| *name == h)
            .map(|(_, c)| *c)
            .unwrap_or("#888888"),
        None => "#888888",
    }
}

pub fn get_year_color(year: u8) -> &'static str {
    YEAR_COLORS
        .iter()
        .find(|(y, _)| *y == year.to_string().as_str())
        .map(|(_, c)| *c)
        .unwrap_or("#888888")
}
