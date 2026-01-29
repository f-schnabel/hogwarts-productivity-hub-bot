# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Maintenance**: If you discover outdated or incorrect information in this file while working in the codebase, automatically update it to reflect current reality.

## Development Commands

```bash
# Start the bot
pnpm start

# Analytics dev server (quick prototyping)
pnpm analytics:dev

# Register Discord slash commands (run after adding/modifying commands)
pnpm run register

# Testing
pnpm test              # Run tests once
pnpm test:watch        # Run tests in watch mode
pnpm test:coverage     # Run tests with coverage

# Linting & Type Checking
pnpm lint              # Check linting issues
pnpm lint:fix          # Auto-fix linting issues
pnpm typecheck         # Run TypeScript type checking
pnpm validate          # Run both lint and typecheck

# Database Migrations
npx drizzle-kit migrate    # Apply migrations to database
npx drizzle-kit generate   # Generate new migration from schema changes
```

## Architecture Overview

### Core Structure

**Discord Bot**: Built with discord.js v14, uses slash commands and event-driven architecture.

**Database**: PostgreSQL via Drizzle ORM. Schema in `src/db/schema.ts`, connection/queries in `src/db/db.ts`. Drizzle config uses snake_case for DB columns.

**Entry Point**: `src/index.ts` initializes bot, registers events, starts scheduler, handles graceful shutdown.

**Events**: Located in `src/discord/events/`:

- `clientReady.ts` - Bot startup
- `interactionCreate.ts` - Slash commands & button interactions
- `messageCreate.ts` - Message tracking for streaks
- `voiceStateUpdate.ts` - Voice channel join/leave/switch

**Commands**: Located in `src/discord/commands/`, registered in `src/discord/commands.ts`:

- `admin.ts` - Admin commands (adjust-points, reset-monthly-points, reset-total-points, refresh-ranks, vc-emoji)
- `scoreboard.ts` - House/user scoreboards
- `submit.ts` - Point submissions
- `timezone.ts` - User timezone settings
- `user.ts` - User profile/stats

Each command exports:

- `data` - Discord command definition
- `execute()` - Main command handler
- `autocomplete()` - (optional) Autocomplete handler
- `buttonHandler()` - (optional) Button interaction handler

**Services** (in `src/services/`):

- `pointsService.ts` - Points awarding logic
- `centralResetService.ts` - Timezone-based daily resets

**Discord Utils** (in `src/discord/utils/`):

- `scoreboardService.ts` - Scoreboard management
- `voiceStateScanner.ts` - Voice state scanning on startup
- `voiceUtils.ts` - Voice session tracking
- `yearRoleUtils.ts` - Year role progression
- `alerting.ts` - Error alerting to bot owner

**Common** (in `src/common/`):

- `logger.ts` - Structured logging
- `console.ts` - Syslog-style console output
- `monitoring.ts` - Prometheus metrics
- `constants.ts` - Shared constants

### Database Schema

**Tables** (defined in `src/db/schema.ts`):

- `userTable` - Discord users with house, timezone, points (daily/monthly/total), voice time, message streaks, announcedYear
- `voiceSessionTable` - Tracks voice channel sessions with duration calculation
- `submissionTable` - Pending/approved/rejected submissions for points
- `houseScoreboardTable` - Stores message IDs for persistent scoreboards
- `settingsTable` - Global settings (VC emoji, month start date)
- `pointAdjustmentTable` - Tracks manual point adjustments by admins

### Key Systems

**Points System**:

- First hour in VC: 5 points
- Subsequent hours: 2 points each
- Max 12 hours tracked per day
- Points also awarded via submissions

**Year Roles** (`src/discord/utils/yearRoleUtils.ts`):

- Users progress Year 1-7 based on monthly voice time
- Thresholds: 1, 10, 20, 40, 80, 100, 120 hours
- Announcements sent to configured channel on promotion

**Timezone-Based Daily Resets** (`src/services/centralResetService.ts`):

- Runs hourly cron job to check users needing reset
- Per-user timezone handling (users reset at their local midnight)
- Closes voice sessions before reset, reopens after
- Resets dailyPoints, dailyVoiceTime, dailyMessages
- Handles message streaks (resets to 0 if user didn't meet min messages)
- Server boosters get automatic daily streak credit

**Voice Session Tracking** (`src/discord/utils/voiceUtils.ts`):

- Sessions tracked in DB with join/leave timestamps
- Points awarded on session end (only if >= 1 min and user in DB)
- Sessions auto-closed during daily reset

**Message Streaks**:

- Users must send MIN_DAILY_MESSAGES_FOR_STREAK (3) messages/day
- Streak shown in nickname with fire emoji
- Streak increments once per day on threshold hit
- Boosters automatically maintain streak

**Analytics Dashboard** (`src/web/analytics.ts`):

- Web dashboard with Twig templates (in `views/`)
- Routes: house scoreboard, leaderboard, user profiles
- Templates: houses.twig, leaderboard.twig, user.twig

**Monitoring** (`src/common/monitoring.ts`):

- Prometheus metrics exposed on http://localhost:8080/metrics
- Tracks interaction execution time, voice session duration, reset duration
- Express server for metrics endpoint

**Logging** (`src/common/logger.ts`):

- Structured logging with operation IDs for tracing
- Format: `[Scope] [opId] key=value message`
- OpId prefixes: cmd, vc, rst, msg, vcscan, start, shtdwn
- Logs sent to stdout with syslog priority levels (via `src/common/console.ts`)
- Use `createLogger(scope)` to create scoped loggers with debug/info/warn/error methods

**Error Handling**:

- `src/discord/utils/alerting.ts` - Alert bot owner on critical errors
- Uncaught exceptions/rejections sent to owner via DM
- Graceful shutdown closes voice sessions before exit

### Environment Variables

Required in `.env` (see `.env.example`):

- `DISCORD_TOKEN` - Bot token
- `CLIENT_ID` - Application ID
- `GUILD_ID` - Discord server ID
- `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_HOST` - PostgreSQL credentials
- `OWNER_ID` - Discord user ID for error alerts
- `GRYFFINDOR_ROLE_ID`, `SLYTHERIN_ROLE_ID`, `HUFFLEPUFF_ROLE_ID`, `RAVENCLAW_ROLE_ID` - House roles
- `PREFECT_ROLE_ID`, `PROFESSOR_ROLE_ID` - Staff roles
- `VC_ROLE_ID` - Voice channel role
- `YEAR_ROLE_IDS` - Comma-separated Year 1-7 role IDs
- `YEAR_ANNOUNCEMENT_CHANNEL_ID` - Channel for year promotions
- `EXCLUDE_VOICE_CHANNEL_IDS` - Voice channels to exclude from tracking
- `SUBMISSION_CHANNEL_IDS` - Channels for submissions
- `MYSTERY_SECRET` - (optional) Secret to bypass mystery mode in analytics

### Command Pattern

Commands follow this structure:

```typescript
export default {
  data: new SlashCommandBuilder().setName("command").setDescription("Description"),
  async execute(interaction, { opId }) {
    // Command logic
  },
  async autocomplete(interaction) {
    /* optional */
  },
  async buttonHandler(interaction, event, data) {
    /* optional */
  },
};
```

### Testing

Uses Vitest. Test files should be colocated with source or in `__tests__` directories.

### Code Style

- Prettier config in package.json: 120 char width, 2 space tabs, semicolons, double quotes
- ESLint with TypeScript rules
- snake_case for DB columns (via Drizzle config), camelCase for TypeScript
