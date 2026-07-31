import { describe, expect, it } from "vitest";
import { splitLinesByLength } from "@/discord/utils/interaction.ts";

describe("splitLinesByLength", () => {
  it("keeps lines together while chunks remain within the limit", () => {
    expect(splitLinesByLength(["alpha", "beta", "gamma"], 10)).toEqual(["alpha\nbeta", "gamma"]);
  });

  it("splits a line that is longer than the limit", () => {
    expect(splitLinesByLength(["abcdefgh"], 3)).toEqual(["abc", "def", "gh"]);
  });

  it("paginates a detailed session list within Discord's embed description limit", () => {
    const lines = Array.from({ length: 200 }, (_, index) => `• Session ${index}: 12:00-13:00 **VC** (1h)`);
    const pages = splitLinesByLength(lines, 4096);

    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((page) => page.length <= 4096)).toBe(true);
    expect(pages.join("\n")).toBe(lines.join("\n"));
  });

  it("returns one empty chunk when there is no content", () => {
    expect(splitLinesByLength([], 4096)).toEqual([""]);
  });

  it("rejects non-positive limits", () => {
    expect(() => splitLinesByLength(["text"], 0)).toThrow(RangeError);
  });
});
