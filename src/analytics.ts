import { Router, type Router as RouterType } from "express";
import { db, getMonthStartDate } from "./db/db.ts";
import { userTable, voiceSessionTable, submissionTable } from "./db/schema.ts";
import { desc, eq, sql, and, gte } from "drizzle-orm";
import type { House } from "./types.ts";
import { client } from "./client.ts";
import dayjs from "dayjs";

export const analyticsRouter: RouterType = Router();

const HOUSE_HEX: Record<House, string> = {
  Gryffindor: "#ae0001",
  Hufflepuff: "#ecb939",
  Ravenclaw: "#222f5b",
  Slytherin: "#2a623d",
};

const layout = (title: string, content: string, script?: string) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} - Hogwarts Productivity</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Georgia', serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: #e8d5b7;
      min-height: 100vh;
      padding: 2rem;
    }
    .container { max-width: 900px; margin: 0 auto; }
    h1 {
      text-align: center;
      font-size: 2.5rem;
      margin-bottom: 2rem;
      text-shadow: 2px 2px 4px rgba(0,0,0,0.5);
    }
    nav {
      text-align: center;
      margin-bottom: 2rem;
      padding: 1rem;
      background: rgba(0,0,0,0.3);
      border-radius: 8px;
    }
    nav a {
      color: #ffd700;
      margin: 0 1rem;
      text-decoration: none;
      font-size: 1.1rem;
    }
    nav a:hover { text-decoration: underline; }
    .house-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1.5rem;
      margin: 2rem 0;
    }
    .house-card {
      background: rgba(0,0,0,0.4);
      border-radius: 12px;
      padding: 1.5rem;
      text-align: center;
      border: 3px solid;
    }
    .house-card h2 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .house-card .points { font-size: 2rem; font-weight: bold; }
    .house-card .members { font-size: 0.9rem; opacity: 0.8; }
    table {
      width: 100%;
      border-collapse: collapse;
      background: rgba(0,0,0,0.3);
      border-radius: 8px;
      overflow: hidden;
    }
    th, td { padding: 1rem; text-align: left; }
    th { background: rgba(0,0,0,0.5); color: #ffd700; }
    tr:nth-child(even) { background: rgba(255,255,255,0.05); }
    tr:hover { background: rgba(255,255,255,0.1); }
    .rank { font-weight: bold; color: #ffd700; }
    .user-header {
      background: rgba(0,0,0,0.4);
      padding: 2rem;
      border-radius: 12px;
      margin-bottom: 2rem;
      text-align: center;
    }
    .stat-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 1rem;
      margin: 1rem 0;
    }
    .stat {
      background: rgba(0,0,0,0.3);
      padding: 1rem;
      border-radius: 8px;
      text-align: center;
    }
    .stat-value { font-size: 1.5rem; font-weight: bold; color: #ffd700; }
    .stat-label { font-size: 0.9rem; opacity: 0.8; }
    .sessions { margin-top: 2rem; }
    .session {
      background: rgba(0,0,0,0.3);
      padding: 0.75rem 1rem;
      margin: 0.5rem 0;
      border-radius: 6px;
      display: flex;
      justify-content: space-between;
    }
  </style>
</head>
<body>
  <div class="container">
    <nav>
      <a href="/">🏠 Houses</a>
      <a href="/leaderboard">🏆 Leaderboard</a>
    </nav>
    ${content}
  </div>
  ${script ? `<script>${script}</script>` : ""}
</body>
</html>
`;

// Home - House scoreboard
analyticsRouter.get("/", async (_req, res) => {
  const houses = await db
    .select({
      house: userTable.house,
      totalPoints: sql<number>`sum(${userTable.monthlyPoints})`.as("total_points"),
      memberCount: sql<number>`count(*)`.as("member_count"),
    })
    .from(userTable)
    .where(sql`${userTable.house} IS NOT NULL`)
    .groupBy(userTable.house)
    .orderBy(desc(sql`total_points`));

  const houseCards = houses
    .filter((h): h is typeof h & { house: House } => h.house !== null)
    .map((h) => {
      return `
      <div class="house-card" style="border-color: ${HOUSE_HEX[h.house]}">
        <h2 style="color: ${HOUSE_HEX[h.house]}">${h.house}</h2>
        <div class="points">${h.totalPoints.toLocaleString()}</div>
        <div class="members">${h.memberCount} members</div>
      </div>
    `;
    })
    .join("");

  res.send(
    layout(
      "House Standings",
      `
    <h1>⚡ House Cup Standings</h1>
    <div class="house-grid">${houseCards}</div>
    <p style="text-align:center;opacity:0.6;margin-top:2rem">Monthly points - resets each month</p>
  `,
    ),
  );
});

// Leaderboard
analyticsRouter.get("/leaderboard", async (_req, res) => {
  const users = await db
    .select({
      username: userTable.username,
      discordId: userTable.discordId,
      house: userTable.house,
      monthlyPoints: userTable.monthlyPoints,
      monthlyVoiceTime: userTable.monthlyVoiceTime,
      messageStreak: userTable.messageStreak,
    })
    .from(userTable)
    .orderBy(desc(userTable.monthlyPoints))
    .limit(50);

  // Fetch display names from Discord
  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  const displayNames = new Map<string, string>();
  if (guild) {
    const members = await guild.members.fetch({ user: users.map((u) => u.discordId) });
    for (const [id, member] of members) {
      displayNames.set(id, member.displayName);
    }
  }

  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };

  const rows = users
    .map(
      (u, i) => `
    <tr>
      <td class="rank">#${i + 1}</td>
      <td><a href="/user/${u.discordId}" style="color:#e8d5b7;text-decoration:none">${displayNames.get(u.discordId) ?? u.username}</a></td>
      <td style="color:${u.house ? HOUSE_HEX[u.house] : "#888"}">${u.house ?? "-"}</td>
      <td>${u.monthlyPoints}</td>
      <td>${formatTime(u.monthlyVoiceTime)}</td>
      <td>🔥 ${u.messageStreak}</td>
    </tr>
  `,
    )
    .join("");

  res.send(
    layout(
      "Leaderboard",
      `
    <h1>🏆 Monthly Leaderboard</h1>
    <table>
      <thead>
        <tr>
          <th>Rank</th>
          <th>User</th>
          <th>House</th>
          <th>Points</th>
          <th>Study Time</th>
          <th>Streak</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `,
    ),
  );
});

// User detail
analyticsRouter.get("/user/:id", async (req, res) => {
  const { id } = req.params;

  const [user] = await db.select().from(userTable).where(eq(userTable.discordId, id));

  if (!user) {
    res.status(404).send(layout("Not Found", "<h1>User not found</h1>"));
    return;
  }

  // Fetch display name from Discord
  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  const member = guild ? await guild.members.fetch(id).catch(() => null) : null;
  const displayName = member?.displayName ?? user.username;

  const monthStart = await getMonthStartDate();
  const sessions = await db
    .select({
      joinedAt: voiceSessionTable.joinedAt,
      duration: voiceSessionTable.duration,
    })
    .from(voiceSessionTable)
    .where(
      and(
        eq(voiceSessionTable.discordId, id),
        eq(voiceSessionTable.isTracked, true),
        gte(voiceSessionTable.joinedAt, monthStart),
      ),
    )
    .orderBy(voiceSessionTable.joinedAt);

  const submissions = await db
    .select({
      submittedAt: submissionTable.submittedAt,
      points: submissionTable.points,
    })
    .from(submissionTable)
    .where(
      and(
        eq(submissionTable.discordId, id),
        eq(submissionTable.status, "APPROVED"),
        gte(submissionTable.submittedAt, monthStart),
      ),
    );

  // Aggregate sessions by day
  const dailyHours = new Map<string, number>();
  for (const s of sessions) {
    const day = dayjs(s.joinedAt).format("YYYY-MM-DD");
    dailyHours.set(day, (dailyHours.get(day) ?? 0) + (s.duration ?? 0) / 3600);
  }

  // Aggregate submissions by day
  const dailyTodoPoints = new Map<string, number>();
  for (const s of submissions) {
    const day = dayjs(s.submittedAt).format("YYYY-MM-DD");
    dailyTodoPoints.set(day, (dailyTodoPoints.get(day) ?? 0) + s.points);
  }

  // Build data from month start to today
  const labels: string[] = [];
  const cumulativeHours: number[] = [];
  const todoPoints: number[] = [];
  let cumulative = 0;
  const daysInPeriod = dayjs().diff(dayjs(monthStart), "day") + 1;
  for (let i = daysInPeriod - 1; i >= 0; i--) {
    const day = dayjs().subtract(i, "day").format("YYYY-MM-DD");
    const label = dayjs().subtract(i, "day").format("MMM D");
    cumulative += dailyHours.get(day) ?? 0;
    labels.push(label);
    cumulativeHours.push(Math.round(cumulative * 10) / 10);
    todoPoints.push(dailyTodoPoints.get(day) ?? 0);
  }

  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };

  const houseColor = user.house ? HOUSE_HEX[user.house] : "#888";

  res.send(
    layout(
      displayName,
      `
    <div class="user-header">
      <h1>${displayName}</h1>
      <p style="color:${houseColor};font-size:1.2rem">${user.house ?? "No House"}</p>
    </div>

    <div class="stat-grid">
      <div class="stat">
        <div class="stat-value">${user.monthlyPoints}</div>
        <div class="stat-label">Monthly Points</div>
      </div>
      <div class="stat">
        <div class="stat-value">${formatTime(user.monthlyVoiceTime)}</div>
        <div class="stat-label">Monthly Study</div>
      </div>
      <div class="stat">
        <div class="stat-value">🔥 ${user.messageStreak}</div>
        <div class="stat-label">Message Streak</div>
      </div>
      <div class="stat">
        <div class="stat-value">${user.totalPoints}</div>
        <div class="stat-label">All-Time Points</div>
      </div>
      <div class="stat">
        <div class="stat-value">${formatTime(user.totalVoiceTime)}</div>
        <div class="stat-label">All-Time Study</div>
      </div>
    </div>

    <div class="sessions">
      <h2 style="margin-bottom:1rem">Activity This Month</h2>
      <div style="background:rgba(0,0,0,0.3);border-radius:8px;padding:1rem">
        <canvas id="studyChart"></canvas>
      </div>
    </div>
  `,
      `
      new Chart(document.getElementById('studyChart'), {
        data: {
          labels: ${JSON.stringify(labels)},
          datasets: [{
            type: 'line',
            label: 'Study Hours',
            data: ${JSON.stringify(cumulativeHours)},
            borderColor: '${houseColor}',
            backgroundColor: '${houseColor}33',
            fill: true,
            tension: 0.3,
            yAxisID: 'y'
          }, {
            type: 'bar',
            label: 'To-Do Points',
            data: ${JSON.stringify(todoPoints)},
            backgroundColor: '#ffd70088',
            borderColor: '#ffd700',
            borderWidth: 1,
            yAxisID: 'y1'
          }]
        },
        options: {
          responsive: true,
          plugins: {
            legend: {
              display: true,
              labels: { color: '#e8d5b7' }
            }
          },
          scales: {
            x: {
              ticks: { color: '#e8d5b7', maxRotation: 45 },
              grid: { color: 'rgba(255,255,255,0.1)' }
            },
            y: {
              type: 'linear',
              position: 'left',
              title: { display: true, text: 'Hours', color: '#e8d5b7' },
              ticks: { color: '#e8d5b7' },
              grid: { color: 'rgba(255,255,255,0.1)' },
              beginAtZero: true
            },
            y1: {
              type: 'linear',
              position: 'right',
              title: { display: true, text: 'To-Do Pts', color: '#e8d5b7' },
              ticks: { color: '#e8d5b7', stepSize: 5 },
              grid: { drawOnChartArea: false },
              beginAtZero: true,
              max: 15
            }
          }
        }
      });
      `,
    ),
  );
});
