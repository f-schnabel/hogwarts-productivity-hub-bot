# Hogwarts Productivity Hub Bot

Discord bot for a Hogwarts-themed productivity community. Track voice time, earn points for your house, and progress through years.

## Features

- **House System** - Users join Gryffindor, Hufflepuff, Ravenclaw, or Slytherin
- **Voice Tracking** - Earn points for time spent in voice channels (5 pts first hour, 2 pts/hr after)
- **Year Progression** - Advance Year 1-7 based on monthly voice time
- **Message Streaks** - Maintain daily message streaks shown in nickname
- **Submissions** - Submit screenshots for bonus points, reviewed by staff
- **Scoreboards** - House and user leaderboards
- **Analytics Dashboard** - Web dashboard for stats

## Quick Start

<details>
<summary><b>Setup Guide (Click to expand)</b></summary>

### Prerequisites

- Node.js v18+
- PostgreSQL v12+
- pnpm

### Install

```bash
git clone https://github.com/Shadow-Devil/hogwarts-productivity-hub-bot.git
cd hogwarts-productivity-hub-bot
pnpm install

cp .env.example .env
# Edit .env with your config

npx drizzle-kit migrate
pnpm run register
pnpm start
```

</details>

## Commands

| Command | Description |
|---------|-------------|
| `/user` | View your profile and stats |
| `/timezone` | Set your timezone for daily resets |
| `/submit` | Submit screenshot for points |
| `/scoreboard` | View house/user leaderboards |
| `/admin` | Admin commands (staff only) |

## Environment Variables

See `.env.example` for all required variables:

- Discord: `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID`
- Database: `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`
- Roles: House roles, staff roles, year roles
- Channels: Submission channels, announcement channel

## Development

```bash
pnpm start           # Run bot
pnpm analytics:dev   # Run analytics dashboard
pnpm test            # Run tests
pnpm validate        # Lint + typecheck
```
