import { describe, expect, it } from "vitest";
import { formatDeploymentMessage } from "@/common/deployment.ts";

describe("formatDeploymentMessage", () => {
  it("falls back when git info is unavailable", () => {
    expect(formatDeploymentMessage(null)).toBe("Bot deployed successfully.");
  });

  it("reports a restart without new commits", () => {
    expect(formatDeploymentMessage({ head: "abc", commits: [] })).toBe("Bot restarted (no new commits).");
  });

  it("lists new commit summaries", () => {
    expect(formatDeploymentMessage({ head: "abc", commits: ["abc1234 Fix thing", "def5678 Add thing"] })).toBe(
      "Bot deployed successfully (2 new commits):\n- abc1234 Fix thing\n- def5678 Add thing",
    );
  });

  it("truncates to fit a Discord message", () => {
    const commits = Array.from({ length: 100 }, (_, i) => `${String(i).padStart(7, "0")} ${"x".repeat(50)}`);
    const message = formatDeploymentMessage({ head: "abc", commits });

    expect(message.length).toBeLessThanOrEqual(2000);
    expect(message).toMatch(/\.\.\.and \d+ more$/);
  });
});
