import { describe, expect, it } from "vitest";
import { projectFiles } from "archunit";

describe("Architecture boundaries", () => {
  it("db should not depend on discord", async () => {
    const rule = projectFiles().inFolder("src/db/**").shouldNot().dependOnFiles().inFolder("src/discord/**");
    await expect(rule).toPassAsync();
  });

  it("db should not depend on web", async () => {
    const rule = projectFiles().inFolder("src/db/**").shouldNot().dependOnFiles().inFolder("src/web/**");
    await expect(rule).toPassAsync();
  });

  it("db should not depend on services", async () => {
    const rule = projectFiles().inFolder("src/db/**").shouldNot().dependOnFiles().inFolder("src/services/**");
    await expect(rule).toPassAsync();
  });

  it("discord should not depend on web", async () => {
    const rule = projectFiles().inFolder("src/discord/**").shouldNot().dependOnFiles().inFolder("src/web/**");
    await expect(rule).toPassAsync();
  });

  it("common should not depend on db", async () => {
    const rule = projectFiles().inFolder("src/common/**").shouldNot().dependOnFiles().inFolder("src/db/**");
    await expect(rule).toPassAsync();
  });

  it("common should not depend on services", async () => {
    const rule = projectFiles().inFolder("src/common/**").shouldNot().dependOnFiles().inFolder("src/services/**");
    await expect(rule).toPassAsync();
  });

  it("common should not depend on web", async () => {
    const rule = projectFiles().inFolder("src/common/**").shouldNot().dependOnFiles().inFolder("src/web/**");
    await expect(rule).toPassAsync();
  });

  it("common should not depend on discord", async () => {
    const rule = projectFiles().inFolder("src/common/**").shouldNot().dependOnFiles().inFolder("src/discord/**");
    await expect(rule).toPassAsync();
  });
});
