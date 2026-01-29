import { Router } from "express";
import registerIndexRoute from "./routes/index.ts";
import registerLeaderboardRoute from "./routes/leaderboard.ts";
import registerUserIdRoute from "./routes/user_id.ts";

export const analyticsRouter = Router();
registerIndexRoute(analyticsRouter);
registerLeaderboardRoute(analyticsRouter);
registerUserIdRoute(analyticsRouter);
