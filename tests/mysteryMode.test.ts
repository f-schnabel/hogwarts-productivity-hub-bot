import { describe, expect, it } from "vitest";
import dayjs from "dayjs";
import { isHouseStandingsMysteryMode } from "@/common/mysteryMode.ts";

describe("Mystery mode", () => {
  it("starts during the last three days of the month", () => {
    expect(isHouseStandingsMysteryMode(new Date("2026-05-01T00:00:00Z"), dayjs("2026-05-29T00:00:00Z"))).toBe(true);
  });

  it("does not start before the last three days", () => {
    expect(isHouseStandingsMysteryMode(new Date("2026-05-01T00:00:00Z"), dayjs("2026-05-28T00:00:00Z"))).toBe(false);
  });

  it("does not start within two days of reset", () => {
    expect(isHouseStandingsMysteryMode(new Date("2026-05-28T00:00:00Z"), dayjs("2026-05-29T00:00:00Z"))).toBe(false);
  });
});
