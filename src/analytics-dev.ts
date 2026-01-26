/**
 * Dev server for analytics website - runs independently of Discord bot
 * Usage: pnpm run analytics:dev
 */
import "dotenv/config";

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault("UTC");

import express from "express";
import Twig from "twig";
import path from "path";

// Mock the Discord client before importing analytics
import { client } from "./client.ts";

// Create a fake guild that returns usernames from DB as display names
const mockGuild = {
  members: {
    // eslint-disable-next-line @typescript-eslint/require-await
    fetch: async () => new Map(),
  },
};
client.guilds = {
  cache: {
    get: () => mockGuild,
  },
} as unknown as typeof client.guilds;

// Now import analytics (will use mocked client)
const { analyticsRouter } = await import("./analytics.ts");

const app = express();
app.set("view engine", "twig");
app.set("views", path.join(import.meta.dirname, "..", "views"));
app.set("twig options", { allowAsync: true, strict_variables: false });
Twig.cache(false); // Disable cache for dev - instant template reloads
app.use(express.static(path.join(import.meta.dirname, "..", "public")));
app.use(analyticsRouter);

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`Analytics dev server: http://localhost:${PORT}`);
});
