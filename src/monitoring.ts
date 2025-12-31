import client from "prom-client";
import express from "express";

const app = express();

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
  console.log("Server is running on http://localhost:8080, metrics are exposed on http://localhost:8080/metrics");
});
