import { describe, expect, it } from "vitest";
import { projectFiles } from "archunit";

const ARCHITECTURE_TEST_TIMEOUT_MS = 15_000;

describe("Architecture boundaries", () => {
  it("db should not depend on discord", { timeout: ARCHITECTURE_TEST_TIMEOUT_MS }, async () => {
    const rule = projectFiles().inFolder("src/db/**").shouldNot().dependOnFiles().inFolder("src/discord/**");
    await expect(rule).toPassAsync();
  });

  it("db should not depend on web", { timeout: ARCHITECTURE_TEST_TIMEOUT_MS }, async () => {
    const rule = projectFiles().inFolder("src/db/**").shouldNot().dependOnFiles().inFolder("src/web/**");
    await expect(rule).toPassAsync();
  });

  it("db should not depend on services", { timeout: ARCHITECTURE_TEST_TIMEOUT_MS }, async () => {
    const rule = projectFiles().inFolder("src/db/**").shouldNot().dependOnFiles().inFolder("src/services/**");
    await expect(rule).toPassAsync();
  });

  it("discord should not depend on web", { timeout: ARCHITECTURE_TEST_TIMEOUT_MS }, async () => {
    const rule = projectFiles().inFolder("src/discord/**").shouldNot().dependOnFiles().inFolder("src/web/**");
    await expect(rule).toPassAsync();
  });

  it("common should not depend on db", { timeout: ARCHITECTURE_TEST_TIMEOUT_MS }, async () => {
    const rule = projectFiles().inFolder("src/common/**").shouldNot().dependOnFiles().inFolder("src/db/**");
    await expect(rule).toPassAsync();
  });

  it("common should not depend on services", { timeout: ARCHITECTURE_TEST_TIMEOUT_MS }, async () => {
    const rule = projectFiles().inFolder("src/common/**").shouldNot().dependOnFiles().inFolder("src/services/**");
    await expect(rule).toPassAsync();
  });

  it("common should not depend on web", { timeout: ARCHITECTURE_TEST_TIMEOUT_MS }, async () => {
    const rule = projectFiles().inFolder("src/common/**").shouldNot().dependOnFiles().inFolder("src/web/**");
    await expect(rule).toPassAsync();
  });

  it("common should not depend on discord", { timeout: ARCHITECTURE_TEST_TIMEOUT_MS }, async () => {
    const rule = projectFiles().inFolder("src/common/**").shouldNot().dependOnFiles().inFolder("src/discord/**");
    await expect(rule).toPassAsync();
  });
});
