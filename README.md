# Hogwarts Productivity Hub Bot

## Quick Start

**Step 1:** [Create a Discord Bot](https://discord.com/developers/applications)
**Step 2:** Download & Configure
**Step 3:** Start the Bot

<details>
<summary><b>Detailed Setup Guide (Click to expand)</b></summary>

### **Prerequisites**

```bash
# You'll need these installed:
- Node.js (v16 or higher)
- PostgreSQL (v12 or higher)
- Git
```

### **Quick Install**

```bash
# 1. Clone the repository
git clone https://github.com/Shadow-Devil/hogwarts-productivity-hub-bot.git
cd hogwarts-productivity-hub-bot

# 2. Install dependencies
pnpm install

# 3. Setup environment
cp .env.example .env
# Edit .env with your Discord bot token and database URL

# 4. Setup database
npx drizzle-kit migrate

# 5. Register commands and start
pnpm run register
pnpm start
```

</details>

### Verify It's Working

In your Discord server, try:

- `/tasks add Learn something new` - Add your first task
- `/stats` - Check your progress
- `/timer 25 5` - Start a focus session

**🎉 That's it! Your productivity bot is ready to transform your community.**
