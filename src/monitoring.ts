import client from "prom-client";
import express from "express";
import { createLogger } from "./utils/logger.ts";
import { analyticsRouter } from "./analytics.ts";

const log = createLogger("Monitoring");
const app = express();

// Analytics server on separate port (public)
const analyticsApp = express();
analyticsApp.use(analyticsRouter);
export const analyticsServer = analyticsApp.listen(3001, "0.0.0.0", () => {
  log.info("Analytics server started", { opId: "monitor", url: "http://localhost:3001" });
});

const register = new client.Registry();
export const interactionExecutionTimer = new client.Histogram({
  name: "discord_interaction_execution_duration_seconds",
  help: "Duration of Discord interactions in seconds",
  labelNames: ["command", "subcommand", "is_autocomplete"],
  buckets: [0.1, 0.3, 0.5, 0.7, 1, 3, 5, 7, 10], // 0.1 to 10 seconds
});

export const voiceSessionExecutionTimer = new client.Histogram({
  name: "discord_voice_session_execution_duration_seconds",
  help: "Duration of Discord voice session execution in seconds",
  labelNames: ["event"],
  buckets: [0.1, 0.3, 0.5, 0.7, 1, 3, 5, 7, 10], // 0.1 to 10 seconds
});
export const resetExecutionTimer = new client.Histogram({
  name: "discord_reset_execution_duration_seconds",
  help: "Duration of Discord reset execution in seconds",
  labelNames: ["action"],
  buckets: [0.1, 0.3, 0.5, 0.7, 1, 3, 5, 7, 10], // 0.1 to 10 seconds
});

register.registerMetric(interactionExecutionTimer);
register.registerMetric(voiceSessionExecutionTimer);
register.registerMetric(resetExecutionTimer);

client.collectDefaultMetrics({ register });

app.get("/metrics", async (_req, res) => {
  res.setHeader("Content-Type", register.contentType);
  res.send(await register.metrics());
});

export const server = app.listen(8080, "127.0.0.1", () => {
  log.info("Metrics server started", { opId: "monitor", url: "http://localhost:8080/metrics" });
});
