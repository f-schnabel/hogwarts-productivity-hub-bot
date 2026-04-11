-- Initial schema migration

CREATE TABLE IF NOT EXISTS "user" (
    discord_id      VARCHAR(255)    PRIMARY KEY NOT NULL,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    username        VARCHAR(255)    NOT NULL,
    house           VARCHAR(50),
    timezone        VARCHAR(50)     NOT NULL DEFAULT 'UTC',
    last_daily_reset TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    daily_points    INTEGER         NOT NULL DEFAULT 0,
    monthly_points  INTEGER         NOT NULL DEFAULT 0,
    total_points    INTEGER         NOT NULL DEFAULT 0,
    daily_voice_time  INTEGER       NOT NULL DEFAULT 0,
    monthly_voice_time INTEGER      NOT NULL DEFAULT 0,
    total_voice_time  INTEGER       NOT NULL DEFAULT 0,
    daily_messages  INTEGER         NOT NULL DEFAULT 0,
    message_streak  INTEGER         NOT NULL DEFAULT 0,
    announced_year  INTEGER         NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS user_house_monthly_points_idx
    ON "user" (house, monthly_points DESC);

CREATE TABLE IF NOT EXISTS voice_session (
    id              SERIAL          PRIMARY KEY,
    discord_id      VARCHAR(255)    NOT NULL REFERENCES "user"(discord_id) ON DELETE CASCADE,
    joined_at       TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    left_at         TIMESTAMPTZ,
    channel_id      VARCHAR(255)    NOT NULL,
    channel_name    VARCHAR(255)    NOT NULL,
    is_tracked      BOOLEAN         NOT NULL DEFAULT FALSE,
    points          INTEGER,
    duration        INTEGER GENERATED ALWAYS AS (
        EXTRACT(EPOCH FROM (left_at - joined_at))::INTEGER
    ) STORED
);

CREATE INDEX IF NOT EXISTS voice_session_discord_id_left_at_idx
    ON voice_session (discord_id, left_at);

CREATE TABLE IF NOT EXISTS submission (
    id                  SERIAL          PRIMARY KEY,
    discord_id          VARCHAR(255)    NOT NULL REFERENCES "user"(discord_id) ON DELETE CASCADE,
    submitted_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    reviewed_at         TIMESTAMPTZ,
    reviewed_by         VARCHAR(255),
    message_id          VARCHAR(255)    UNIQUE,
    channel_id          VARCHAR(255),
    house               VARCHAR(50)     NOT NULL,
    house_id            INTEGER         NOT NULL,
    screenshot_url      VARCHAR(1000)   NOT NULL,
    points              INTEGER         NOT NULL,
    submission_type     VARCHAR(50),     -- 'NEW' | 'COMPLETED'
    status              VARCHAR(50)     NOT NULL DEFAULT 'PENDING',
    linked_submission_id INTEGER        REFERENCES submission(id)
);

CREATE INDEX IF NOT EXISTS submission_discord_id_status_submitted_at_idx
    ON submission (discord_id, status, submitted_at);

CREATE INDEX IF NOT EXISTS submission_house_submitted_at_idx
    ON submission (house, submitted_at);

CREATE TABLE IF NOT EXISTS house_scoreboard (
    id          SERIAL          PRIMARY KEY,
    house       VARCHAR(50)     NOT NULL,
    channel_id  TEXT            NOT NULL,
    message_id  TEXT            NOT NULL,
    updated_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings (
    key     VARCHAR(255)    PRIMARY KEY NOT NULL,
    value   TEXT            NOT NULL
);

CREATE TABLE IF NOT EXISTS house_cup_month (
    id          SERIAL          PRIMARY KEY,
    month       VARCHAR(7)      NOT NULL UNIQUE,   -- 'YYYY-MM'
    winner      VARCHAR(50)     NOT NULL,
    created_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS house_cup_entry (
    id                  SERIAL          PRIMARY KEY,
    month_id            INTEGER         NOT NULL REFERENCES house_cup_month(id) ON DELETE CASCADE,
    house               VARCHAR(50)     NOT NULL,
    weighted_points     INTEGER         NOT NULL,
    raw_points          INTEGER         NOT NULL,
    member_count        INTEGER         NOT NULL,
    qualifying_count    INTEGER         NOT NULL,
    champion            VARCHAR(255)    REFERENCES "user"(discord_id)
);

CREATE INDEX IF NOT EXISTS house_cup_entry_month_id_idx
    ON house_cup_entry (month_id);

CREATE TABLE IF NOT EXISTS point_adjustment (
    id              SERIAL          PRIMARY KEY,
    discord_id      VARCHAR(255)    NOT NULL REFERENCES "user"(discord_id) ON DELETE CASCADE,
    adjusted_by     VARCHAR(255)    NOT NULL,
    amount          INTEGER         NOT NULL,
    reason          TEXT,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS point_adjustment_discord_id_created_at_idx
    ON point_adjustment (discord_id);

CREATE TABLE IF NOT EXISTS journal_entry (
    id          SERIAL          PRIMARY KEY,
    date        DATE            NOT NULL UNIQUE,
    prompt      TEXT            NOT NULL,
    message_id  TEXT,
    created_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS journal_entry_date_idx
    ON journal_entry (date);
