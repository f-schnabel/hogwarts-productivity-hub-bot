import client from "prom-client";
import express from "express";
import { createLogger } from "./logger.ts";

const log = createLogger("Monitoring");

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

// Servers are started lazily to avoid starting them on import

export function startMonitoringServer() {
  // Metrics server (internal)
  const metricsApp = express();
  metricsApp.get("/metrics", async (_req, res) => {
    res.setHeader("Content-Type", register.contentType);
    res.send(await register.metrics());
  });
  const server = metricsApp.listen(8080, "127.0.0.1", () => {
    log.info("Metrics server started", { opId: "monitor", url: "http://localhost:8080/metrics" });
  });

  return { server };
}
