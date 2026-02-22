import { Router } from "express";
import registerIndexRoute from "./routes/index.ts";
import registerLeaderboardRoute from "./routes/leaderboard.ts";
import registerUserIdRoute from "./routes/user_id.ts";
import express from "express";
import Twig from "twig";
import path from "path";
import { rateLimit } from "express-rate-limit";
import { createLogger } from "@/common/logger.ts";

const log = createLogger("Analytics");

export const analyticsRouter: Router = Router();
registerIndexRoute(analyticsRouter);
registerLeaderboardRoute(analyticsRouter);
registerUserIdRoute(analyticsRouter);
// Rate limiter for public analytics server
const analyticsLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 60, // 60 requests per minute per IP
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

export function startAnalyticsServer() {
  // Analytics server (public)
  const analyticsApp = express();
  analyticsApp.set("trust proxy", 1);
  analyticsApp.use(analyticsLimiter);
  analyticsApp.set("view engine", "twig");
  analyticsApp.set("views", path.join(import.meta.dirname, "..", "..", "views"));
  analyticsApp.set("twig options", { allowAsync: true, strict_variables: false });
  Twig.cache(process.env.NODE_ENV === "production");
  analyticsApp.use(express.static(path.join(import.meta.dirname, "..", "..", "public")));
  analyticsApp.use(analyticsRouter);
  const analyticsServer = analyticsApp.listen(3001, "0.0.0.0", () => {
    log.info("Analytics server started", { opId: "monitor", url: "http://localhost:3001" });
  });
  return { analyticsServer };
}
