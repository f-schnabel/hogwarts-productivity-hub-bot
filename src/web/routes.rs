use std::collections::HashMap;

use askama::Template;
use axum::extract::{Path, Query, State};
use axum::http::{StatusCode, header};
use axum::response::{Html, IntoResponse, Response};
use chrono::{Datelike, Utc};
use regex::Regex;
use serenity::all::GuildId;

use crate::constants::{HOUSES, YEAR_THRESHOLDS_HOURS};

use super::WebState;

// ─── Template types ────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize)]
pub struct HouseData {
    pub name: String,
    pub color: String,
    pub raw_points: i64,
    pub points: i64,
    pub member_count: i64,
    pub unweighted_points: i64,
    pub total_member_count: i64,
    pub rank: u32,
}

#[derive(Debug, Clone)]
pub struct LeaderboardUser {
    pub rank: u32,
    pub discord_id: String,
    pub display_name: String,
    pub house: String,
    pub house_color: String,
    pub monthly_points: i32,
    pub voice_points: i32,
    pub todo_points: i32,
    pub study_time: String,
    pub voice_time_seconds: i32,
    pub year_rank: u8,
    pub message_streak: String,
}

#[derive(Debug, Clone)]
pub struct YearProgress {
    pub badge: String,
    pub badge_color: String,
    pub percent: f64,
    pub bar_start: String,
    pub bar_end: String,
    pub bar_glow: String,
    pub text: String,
    pub left_label: String,
    pub right_label: String,
    pub is_max: bool,
}

#[derive(Debug, Clone)]
pub struct UserProfileData {
    pub display_name: String,
    pub house: String,
    pub house_color: String,
    pub monthly_points: i32,
    pub monthly_study: String,
    pub message_streak: String,
    pub total_points: i32,
    pub total_study: String,
    pub year_progress: YearProgress,
    pub chart_labels_json: String,
    pub chart_hours_json: String,
    pub chart_todo_points_json: String,
    pub chart_y_max: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct TimelineEntry {
    pub month: String,
    pub winner: String,
    pub winner_color: String,
    pub houses: Vec<TimelineHouse>,
}

#[derive(Debug, Clone)]
pub struct TimelineHouse {
    pub house: String,
    pub weighted_points: i32,
    pub is_winner: bool,
}

#[derive(Debug, Clone)]
pub struct HallOfFameStudent {
    pub rank: u32,
    pub discord_id: String,
    pub display_name: String,
    pub house: String,
    pub house_color: String,
    pub total_points: i32,
}

#[derive(Debug, Clone)]
pub struct CupWinCard {
    pub name: String,
    pub color: String,
    pub wins: i64,
}

#[derive(Debug, Clone)]
pub struct AllTimeHouse {
    pub name: String,
    pub color: String,
    pub total_points: i64,
}

// ─── Askama templates ──────────────────────────────────────────────────────

#[derive(Template)]
#[template(path = "houses.html")]
struct HousesTemplate {
    title: String,
    subtitle: Option<String>,
    include_chart_js: bool,
    houses: Vec<HouseData>,
    mystery_mode: bool,
}

#[derive(Template)]
#[template(path = "leaderboard.html")]
struct LeaderboardTemplate {
    title: String,
    include_chart_js: bool,
    users: Vec<LeaderboardUser>,
    gryffindor_color: String,
    hufflepuff_color: String,
    ravenclaw_color: String,
    slytherin_color: String,
}

#[derive(Template)]
#[template(path = "user.html")]
struct UserTemplate {
    title: String,
    include_chart_js: bool,
    user: UserProfileData,
}

#[derive(Template)]
#[template(path = "hall_of_fame.html")]
struct HallOfFameTemplate {
    title: String,
    include_chart_js: bool,
    cup_win_cards: Vec<CupWinCard>,
    timeline: Vec<TimelineEntry>,
    students: Vec<HallOfFameStudent>,
    all_time_houses: Vec<AllTimeHouse>,
    gryffindor_color: String,
    hufflepuff_color: String,
    ravenclaw_color: String,
    slytherin_color: String,
}

#[derive(Template)]
#[template(path = "error.html")]
struct ErrorTemplate {
    title: String,
    include_chart_js: bool,
    message: String,
}

// ─── Error helper ──────────────────────────────────────────────────────────

pub enum AppError {
    NotFound(String),
    Internal(anyhow::Error),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        match self {
            AppError::NotFound(msg) => {
                let tmpl = ErrorTemplate {
                    title: "Not Found".into(),
                    include_chart_js: false,
                    message: msg,
                };
                match tmpl.render() {
                    Ok(html) => (StatusCode::NOT_FOUND, Html(html)).into_response(),
                    Err(_) => (StatusCode::NOT_FOUND, "Not Found").into_response(),
                }
            }
            AppError::Internal(err) => {
                tracing::error!("Web error: {err:#}");
                let tmpl = ErrorTemplate {
                    title: "Internal Error".into(),
                    include_chart_js: false,
                    message: "An internal error occurred.".into(),
                };
                match tmpl.render() {
                    Ok(html) => (StatusCode::INTERNAL_SERVER_ERROR, Html(html)).into_response(),
                    Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "Internal Error").into_response(),
                }
            }
        }
    }
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        AppError::Internal(e)
    }
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        AppError::Internal(e.into())
    }
}

// ─── Utility functions ─────────────────────────────────────────────────────

fn analytics_house_color(house: Option<&str>) -> String {
    crate::constants::get_analytics_house_color(house).to_string()
}

fn format_time(secs: i32) -> String {
    let h = secs / 3600;
    let m = (secs % 3600) / 60;
    if h > 0 {
        format!("{h}h {m}m")
    } else {
        format!("{m}m")
    }
}

fn clean_display_name(name: &str, vc_emoji: &str) -> String {
    let streak_re = Regex::new(r"⚡\d+").unwrap();
    let cleaned = streak_re.replace_all(name, "").to_string();
    let cleaned = cleaned.replace(&format!(" {vc_emoji}"), "");
    let cleaned = cleaned.replace(vc_emoji, "");
    cleaned.trim().to_string()
}

struct MemberInfo {
    display_name: String,
    is_professor: bool,
}

fn fetch_member_info(
    cache: &serenity::cache::Cache,
    guild_id: GuildId,
    config: &crate::config::Config,
    discord_ids: &[String],
) -> HashMap<String, MemberInfo> {
    let mut info = HashMap::new();
    for id_str in discord_ids {
        if let Ok(uid) = id_str.parse::<u64>() {
            if let Some(member) = cache.guild(guild_id)
                .and_then(|g| g.members.get(&serenity::all::UserId::new(uid)).cloned())
            {
                let display_name = member.display_name().to_string();
                let is_professor = member
                    .roles
                    .contains(&serenity::all::RoleId::new(config.professor_role_id));
                info.insert(
                    id_str.clone(),
                    MemberInfo {
                        display_name,
                        is_professor,
                    },
                );
            }
        }
    }
    info
}

async fn is_mystery_mode(
    pool: &sqlx::PgPool,
    secret: Option<&str>,
    config_secret: Option<&str>,
    force_mystery: bool,
) -> bool {
    if config_secret.is_some() && secret == config_secret {
        return false;
    }
    if force_mystery {
        return true;
    }

    let now = Utc::now();
    let days_in_month = days_in_month(now.year(), now.month());
    let is_last_three_days = now.day() > days_in_month.saturating_sub(3);
    if !is_last_three_days {
        return false;
    }

    // Check days since last monthly reset
    if let Ok(month_start) = crate::db::get_month_start_date(pool).await {
        let days_since_reset = (now.naive_utc() - month_start).num_days();
        if days_since_reset <= 1 {
            return false;
        }
    }

    true
}

fn days_in_month(year: i32, month: u32) -> u32 {
    let next_month = if month == 12 {
        chrono::NaiveDate::from_ymd_opt(year + 1, 1, 1)
    } else {
        chrono::NaiveDate::from_ymd_opt(year, month + 1, 1)
    };
    match next_month {
        Some(d) => {
            (d - chrono::NaiveDate::from_ymd_opt(year, month, 1).unwrap())
                .num_days() as u32
        }
        None => 30,
    }
}

fn calculate_year_progress(monthly_voice_time: i32) -> YearProgress {
    use crate::bot::utils::year_roles::get_year_from_monthly_voice_time;

    let bar_colors: Vec<(&str, &str, &str)> = vec![
        ("#4a4a4a", "#6a6a6a", "#555"),
        ("#8b4513", "#a0522d", "#8b4513"),
        ("#cd7f32", "#daa520", "#cd7f32"),
        ("#c0c0c0", "#d3d3d3", "#c0c0c0"),
        ("#ffd700", "#ffec8b", "#ffd700"),
        ("#00ced1", "#40e0d0", "#00ced1"),
        ("#9370db", "#ba55d3", "#9370db"),
        ("#ffd700", "#ffec8b", "#ffd700"),
    ];

    let year = get_year_from_monthly_voice_time(monthly_voice_time).unwrap_or(0) as usize;
    let current_hours = monthly_voice_time as f64 / 3600.0;
    let (bar_start, bar_end, bar_glow) = bar_colors.get(year).copied().unwrap_or(bar_colors[0]);

    if year == 0 {
        let next = YEAR_THRESHOLDS_HOURS[0] as f64;
        return YearProgress {
            badge: "Year 0".into(),
            badge_color: "#888".into(),
            percent: (current_hours / next * 100.0).min(100.0),
            bar_start: bar_start.into(),
            bar_end: bar_end.into(),
            bar_glow: bar_glow.into(),
            text: format!("{:.1}h / {next}h", current_hours),
            left_label: "0h".into(),
            right_label: format!("Next: Year 1 ({next}h)"),
            is_max: false,
        };
    }

    if year == 7 {
        return YearProgress {
            badge: "Year 7".into(),
            badge_color: "#ffd700".into(),
            percent: 100.0,
            bar_start: bar_start.into(),
            bar_end: bar_end.into(),
            bar_glow: bar_glow.into(),
            text: format!("{:.1}h - Maximum Rank!", current_hours),
            left_label: format!("{}h", YEAR_THRESHOLDS_HOURS[6]),
            right_label: "Maximum rank achieved".into(),
            is_max: true,
        };
    }

    let prev = YEAR_THRESHOLDS_HOURS[year - 1] as f64;
    let next = YEAR_THRESHOLDS_HOURS[year] as f64;
    let pct = if next > prev {
        ((current_hours - prev) / (next - prev) * 100.0).clamp(0.0, 100.0)
    } else {
        100.0
    };

    YearProgress {
        badge: format!("Year {year}"),
        badge_color: bar_start.into(),
        percent: pct,
        bar_start: bar_start.into(),
        bar_end: bar_end.into(),
        bar_glow: bar_glow.into(),
        text: format!("{:.1}h / {next}h", current_hours),
        left_label: format!("{prev:.0}h"),
        right_label: format!("Next: Year {} ({next}h)", year + 1),
        is_max: false,
    }
}

// ─── Route handlers ────────────────────────────────────────────────────────

#[derive(serde::Deserialize, Default)]
pub struct IndexQuery {
    pub secret: Option<String>,
    pub mystery: Option<String>,
}

pub async fn index(
    State(state): State<WebState>,
    Query(params): Query<IndexQuery>,
) -> Result<impl IntoResponse, AppError> {
    let [weighted, unweighted] = tokio::try_join!(
        crate::db::get_weighted_house_points(&state.pool),
        crate::db::get_unweighted_house_points(&state.pool),
    )
    .map(|(w, u)| [w, u])?;

    let weighted_map: HashMap<String, (i64, i64)> = weighted
        .iter()
        .filter_map(|h| {
            Some((
                h.house.clone()?,
                (h.total_points.unwrap_or(0), h.member_count),
            ))
        })
        .collect();

    let unweighted_map: HashMap<String, (i64, i64)> = unweighted
        .iter()
        .filter_map(|h| {
            Some((
                h.house.clone()?,
                (h.total_points.unwrap_or(0), h.member_count),
            ))
        })
        .collect();

    let mut houses: Vec<HouseData> = HOUSES
        .iter()
        .map(|&name| {
            let (wpts, wmembers) = weighted_map.get(name).copied().unwrap_or((0, 0));
            let (upts, umerbers) = unweighted_map.get(name).copied().unwrap_or((0, 0));
            HouseData {
                name: name.to_string(),
                color: analytics_house_color(Some(name)),
                raw_points: wpts,
                points: wpts,
                member_count: wmembers,
                unweighted_points: upts,
                total_member_count: umerbers,
                rank: 1,
            }
        })
        .collect();

    houses.sort_by(|a, b| b.raw_points.cmp(&a.raw_points));

    // Assign ranks with ties
    let mut prev_pts = i64::MAX;
    let mut prev_rank = 1u32;
    for (i, h) in houses.iter_mut().enumerate() {
        h.rank = if h.raw_points == prev_pts {
            prev_rank
        } else {
            prev_rank = (i + 1) as u32;
            prev_rank
        };
        prev_pts = h.raw_points;
    }

    let force_mystery = params.mystery.as_deref() == Some("1");
    let mystery_mode = is_mystery_mode(
        &state.pool,
        params.secret.as_deref(),
        state.config.mystery_secret.as_deref(),
        force_mystery,
    )
    .await;

    if mystery_mode {
        use rand::seq::SliceRandom;
        houses.shuffle(&mut rand::thread_rng());
    }

    Ok(HousesTemplate {
        title: "House Standings".into(),
        subtitle: None,
        include_chart_js: false,
        houses,
        mystery_mode,
    }
    .render()
    .map(Html)
    .map_err(|e| AppError::Internal(e.into()))?)
}

pub async fn leaderboard(
    State(state): State<WebState>,
) -> Result<impl IntoResponse, AppError> {
    let month_start = crate::db::get_month_start_date(&state.pool).await?;
    let vc_emoji = crate::db::get_vc_emoji(&state.pool).await?;

    let users_data = sqlx::query!(
        r#"
        SELECT discord_id, username, house, monthly_points, monthly_voice_time, message_streak
        FROM "user"
        WHERE monthly_points > 0
        ORDER BY monthly_points DESC
        "#
    )
    .fetch_all(&*state.pool)
    .await?;

    let todo_pts_data = sqlx::query!(
        r#"
        SELECT discord_id, COALESCE(SUM(points), 0)::INT AS todo_points
        FROM submission
        WHERE submitted_at >= $1 AND status = 'APPROVED'
        GROUP BY discord_id
        "#,
        month_start,
    )
    .fetch_all(&*state.pool)
    .await?;

    let todo_map: HashMap<String, i32> = todo_pts_data
        .iter()
        .map(|r| (r.discord_id.clone(), r.todo_points.unwrap_or(0)))
        .collect();

    let ids: Vec<String> = users_data.iter().map(|u| u.discord_id.clone()).collect();
    let member_info = fetch_member_info(&state.cache, state.guild_id, &state.config, &ids);

    let users: Vec<LeaderboardUser> = users_data
        .iter()
        .enumerate()
        .map(|(i, u)| {
            let info = member_info.get(&u.discord_id);
            let display_name = clean_display_name(
                info.map(|m| m.display_name.as_str())
                    .unwrap_or(&u.username),
                &vc_emoji,
            );
            let todo_points = todo_map.get(&u.discord_id).copied().unwrap_or(0);
            let voice_points = (u.monthly_points - todo_points).max(0);
            let year_rank = crate::bot::utils::year_roles::get_year_from_monthly_voice_time(
                u.monthly_voice_time,
            )
            .unwrap_or(0);
            let message_streak = if info.map(|m| m.is_professor).unwrap_or(false) {
                "-".to_string()
            } else {
                u.message_streak.to_string()
            };

            LeaderboardUser {
                rank: (i + 1) as u32,
                discord_id: u.discord_id.clone(),
                display_name,
                house: u.house.clone().unwrap_or_default(),
                house_color: analytics_house_color(u.house.as_deref()),
                monthly_points: u.monthly_points,
                voice_points,
                todo_points,
                study_time: format_time(u.monthly_voice_time),
                voice_time_seconds: u.monthly_voice_time,
                year_rank,
                message_streak,
            }
        })
        .collect();

    Ok(LeaderboardTemplate {
        title: "Leaderboard".into(),
        include_chart_js: true,
        users,
        gryffindor_color: analytics_house_color(Some("Gryffindor")),
        hufflepuff_color: analytics_house_color(Some("Hufflepuff")),
        ravenclaw_color: analytics_house_color(Some("Ravenclaw")),
        slytherin_color: analytics_house_color(Some("Slytherin")),
    }
    .render()
    .map(Html)
    .map_err(|e| AppError::Internal(e.into()))?)
}

pub async fn user_profile(
    State(state): State<WebState>,
    Path(user_id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let user = sqlx::query!(
        r#"SELECT * FROM "user" WHERE discord_id = $1"#,
        user_id
    )
    .fetch_optional(&*state.pool)
    .await?;

    let user = match user {
        Some(u) => u,
        None => return Err(AppError::NotFound("User not found".into())),
    };

    let (month_start, vc_emoji) = tokio::try_join!(
        crate::db::get_month_start_date(&state.pool),
        crate::db::get_vc_emoji(&state.pool),
    )?;

    let member_info = fetch_member_info(&state.cache, state.guild_id, &state.config, &[user_id.clone()]);
    let info = member_info.get(&user_id);
    let display_name = clean_display_name(
        info.map(|m| m.display_name.as_str())
            .unwrap_or(&user.username),
        &vc_emoji,
    );

    let sessions = sqlx::query!(
        r#"
        SELECT joined_at, duration FROM voice_session
        WHERE discord_id = $1 AND is_tracked = true AND joined_at >= $2
        ORDER BY joined_at ASC
        "#,
        user_id,
        month_start,
    )
    .fetch_all(&*state.pool)
    .await?;

    let submissions = sqlx::query!(
        r#"
        SELECT submitted_at, points FROM submission
        WHERE discord_id = $1 AND status = 'APPROVED' AND submitted_at >= $2
        "#,
        user_id,
        month_start,
    )
    .fetch_all(&*state.pool)
    .await?;

    use chrono_tz::Tz;
    let tz: Tz = user.timezone.parse().unwrap_or(chrono_tz::UTC);
    let now_local = Utc::now().with_timezone(&tz);
    let month_start_local = month_start.and_utc().with_timezone(&tz);

    let mut daily_hours: HashMap<String, f64> = HashMap::new();
    let mut daily_todo_pts: HashMap<String, i32> = HashMap::new();

    for s in &sessions {
        let day = s.joined_at.and_utc().with_timezone(&tz).format("%Y-%m-%d").to_string();
        *daily_hours.entry(day).or_default() +=
            s.duration.unwrap_or(0) as f64 / 3600.0;
    }
    for s in &submissions {
        let day = s.submitted_at.and_utc().with_timezone(&tz).format("%Y-%m-%d").to_string();
        *daily_todo_pts.entry(day).or_default() += s.points;
    }

    let days_in_period = (now_local.date_naive() - month_start_local.date_naive()).num_days() + 1;
    let mut chart_labels = Vec::new();
    let mut chart_hours = Vec::new();
    let mut chart_todo_pts = Vec::new();
    let mut cumulative = 0.0f64;

    for i in (0..days_in_period).rev() {
        let day_date = now_local.date_naive() - chrono::Duration::days(i);
        let day_str = day_date.format("%Y-%m-%d").to_string();
        cumulative += daily_hours.get(&day_str).copied().unwrap_or(0.0);
        let day = day_date.format("%b %-d").to_string();
        chart_labels.push(day);
        chart_hours.push((cumulative * 10.0).round() / 10.0);
        chart_todo_pts.push(daily_todo_pts.get(&day_str).copied().unwrap_or(0));
    }

    let year_progress = calculate_year_progress(user.monthly_voice_time);
    let current_year =
        crate::bot::utils::year_roles::get_year_from_monthly_voice_time(user.monthly_voice_time)
            .unwrap_or(0) as usize;
    let chart_y_max = if current_year < 7 {
        YEAR_THRESHOLDS_HOURS.get(current_year).map(|&h| h as f64 + 5.0)
    } else {
        None
    };

    let message_streak = if info.map(|m| m.is_professor).unwrap_or(false) {
        "-".to_string()
    } else {
        user.message_streak.to_string()
    };

    Ok(UserTemplate {
        title: display_name.clone(),
        include_chart_js: true,
        user: UserProfileData {
            display_name,
            house: user.house.clone().unwrap_or_default(),
            house_color: analytics_house_color(user.house.as_deref()),
            monthly_points: user.monthly_points,
            monthly_study: format_time(user.monthly_voice_time),
            message_streak,
            total_points: user.total_points,
            total_study: format_time(user.total_voice_time),
            year_progress,
            chart_labels_json: serde_json::to_string(&chart_labels).unwrap_or_default(),
            chart_hours_json: serde_json::to_string(&chart_hours).unwrap_or_default(),
            chart_todo_points_json: serde_json::to_string(&chart_todo_pts).unwrap_or_default(),
            chart_y_max,
        },
    }
    .render()
    .map(Html)
    .map_err(|e| AppError::Internal(e.into()))?)
}

pub async fn hall_of_fame(
    State(state): State<WebState>,
) -> Result<impl IntoResponse, AppError> {
    let cup_months = sqlx::query_as!(
        crate::models::HouseCupMonth,
        "SELECT * FROM house_cup_month ORDER BY created_at DESC"
    )
    .fetch_all(&*state.pool)
    .await
    .unwrap_or_default();

    let top_students = sqlx::query!(
        r#"
        SELECT discord_id, username, house, total_points
        FROM "user"
        WHERE total_points > 0
        ORDER BY total_points DESC
        LIMIT 25
        "#
    )
    .fetch_all(&*state.pool)
    .await?;

    let all_time_house_data = sqlx::query!(
        r#"
        SELECT house, SUM(total_points)::BIGINT AS total_points
        FROM "user"
        WHERE house IS NOT NULL
        GROUP BY house
        ORDER BY total_points DESC
        "#
    )
    .fetch_all(&*state.pool)
    .await?;

    // Cup entries
    let month_ids: Vec<i32> = cup_months.iter().map(|m| m.id).collect();
    let cup_entries: Vec<crate::models::HouseCupEntry> = if !month_ids.is_empty() {
        sqlx::query_as!(
            crate::models::HouseCupEntry,
            "SELECT * FROM house_cup_entry WHERE month_id = ANY($1)",
            &month_ids
        )
        .fetch_all(&*state.pool)
        .await?
    } else {
        vec![]
    };

    let mut entries_by_month: HashMap<i32, Vec<&crate::models::HouseCupEntry>> = HashMap::new();
    for entry in &cup_entries {
        entries_by_month
            .entry(entry.month_id)
            .or_default()
            .push(entry);
    }

    // Cup wins per house
    let mut cup_wins: HashMap<String, i64> = HashMap::new();
    for month in &cup_months {
        *cup_wins.entry(month.winner.clone()).or_default() += 1;
    }

    let mut cup_win_cards: Vec<CupWinCard> = HOUSES
        .iter()
        .map(|&name| CupWinCard {
            name: name.to_string(),
            color: analytics_house_color(Some(name)),
            wins: *cup_wins.get(name).unwrap_or(&0),
        })
        .collect();
    cup_win_cards.sort_by(|a, b| b.wins.cmp(&a.wins));

    let timeline: Vec<TimelineEntry> = cup_months
        .iter()
        .map(|cup| {
            let by_house: HashMap<&str, &crate::models::HouseCupEntry> = entries_by_month
                .get(&cup.id)
                .map(|es| {
                    es.iter()
                        .map(|e| (e.house.as_str(), *e))
                        .collect()
                })
                .unwrap_or_default();

            TimelineEntry {
                month: cup.month.clone(),
                winner: cup.winner.clone(),
                winner_color: analytics_house_color(Some(&cup.winner)),
                houses: HOUSES
                    .iter()
                    .map(|&h| TimelineHouse {
                        house: h.to_string(),
                        weighted_points: by_house
                            .get(h)
                            .map(|e| e.weighted_points)
                            .unwrap_or(0),
                        is_winner: h == cup.winner,
                    })
                    .collect(),
            }
        })
        .collect();

    let vc_emoji = crate::db::get_vc_emoji(&state.pool).await?;
    let student_ids: Vec<String> = top_students.iter().map(|u| u.discord_id.clone()).collect();
    let member_info = fetch_member_info(&state.cache, state.guild_id, &state.config, &student_ids);

    let students: Vec<HallOfFameStudent> = top_students
        .iter()
        .enumerate()
        .map(|(i, u)| {
            let info = member_info.get(&u.discord_id);
            let display_name = clean_display_name(
                info.map(|m| m.display_name.as_str())
                    .unwrap_or(&u.username),
                &vc_emoji,
            );
            HallOfFameStudent {
                rank: (i + 1) as u32,
                discord_id: u.discord_id.clone(),
                display_name,
                house: u.house.clone().unwrap_or_default(),
                house_color: analytics_house_color(u.house.as_deref()),
                total_points: u.total_points,
            }
        })
        .collect();

    let mut all_time_houses: Vec<AllTimeHouse> = HOUSES
        .iter()
        .map(|&name| {
            let pts = all_time_house_data
                .iter()
                .find(|h| h.house.as_deref() == Some(name))
                .and_then(|h| h.total_points)
                .unwrap_or(0);
            AllTimeHouse {
                name: name.to_string(),
                color: analytics_house_color(Some(name)),
                total_points: pts,
            }
        })
        .collect();
    all_time_houses.sort_by(|a, b| b.total_points.cmp(&a.total_points));

    Ok(HallOfFameTemplate {
        title: "Hall of Fame".into(),
        include_chart_js: true,
        cup_win_cards,
        timeline,
        students,
        all_time_houses,
        gryffindor_color: analytics_house_color(Some("Gryffindor")),
        hufflepuff_color: analytics_house_color(Some("Hufflepuff")),
        ravenclaw_color: analytics_house_color(Some("Ravenclaw")),
        slytherin_color: analytics_house_color(Some("Slytherin")),
    }
    .render()
    .map(Html)
    .map_err(|e| AppError::Internal(e.into()))?)
}

pub async fn cup_detail(
    State(state): State<WebState>,
    Path(month): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let cup_month = sqlx::query_as!(
        crate::models::HouseCupMonth,
        "SELECT * FROM house_cup_month WHERE month = $1",
        month
    )
    .fetch_optional(&*state.pool)
    .await?;

    let cup_month = match cup_month {
        Some(m) => m,
        None => return Err(AppError::NotFound(format!("Cup month '{month}' not found"))),
    };

    let entries = sqlx::query_as!(
        crate::models::HouseCupEntry,
        "SELECT * FROM house_cup_entry WHERE month_id = $1",
        cup_month.id
    )
    .fetch_all(&*state.pool)
    .await?;

    let by_house: HashMap<&str, &crate::models::HouseCupEntry> =
        entries.iter().map(|e| (e.house.as_str(), e)).collect();

    let mut houses: Vec<HouseData> = HOUSES
        .iter()
        .map(|&name| {
            let entry = by_house.get(name);
            HouseData {
                name: name.to_string(),
                color: analytics_house_color(Some(name)),
                raw_points: entry.map(|e| e.weighted_points as i64).unwrap_or(0),
                points: entry.map(|e| e.weighted_points as i64).unwrap_or(0),
                member_count: entry.map(|e| e.qualifying_count as i64).unwrap_or(0),
                unweighted_points: entry.map(|e| e.raw_points as i64).unwrap_or(0),
                total_member_count: entry.map(|e| e.member_count as i64).unwrap_or(0),
                rank: 1,
            }
        })
        .collect();

    houses.sort_by(|a, b| b.raw_points.cmp(&a.raw_points));
    let mut prev_pts = i64::MAX;
    let mut prev_rank = 1u32;
    for (i, h) in houses.iter_mut().enumerate() {
        h.rank = if h.raw_points == prev_pts {
            prev_rank
        } else {
            prev_rank = (i + 1) as u32;
            prev_rank
        };
        prev_pts = h.raw_points;
    }

    Ok(HousesTemplate {
        title: "House Cup Standings".into(),
        subtitle: Some(month),
        include_chart_js: false,
        houses,
        mystery_mode: false,
    }
    .render()
    .map(Html)
    .map_err(|e| AppError::Internal(e.into()))?)
}

pub async fn prometheus_metrics() -> impl IntoResponse {
    let encoder = prometheus::TextEncoder::new();
    let metric_families = prometheus::gather();
    let mut body = Vec::new();
    match prometheus::Encoder::encode(&encoder, &metric_families, &mut body) {
        Ok(()) => (
            [(header::CONTENT_TYPE, "text/plain; version=0.0.4; charset=utf-8")],
            body,
        )
            .into_response(),
        Err(e) => {
            tracing::error!("Failed to encode Prometheus metrics: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to encode metrics").into_response()
        }
    }
}
