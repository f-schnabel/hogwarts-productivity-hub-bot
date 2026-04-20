import { describe, expect, it, test } from "vitest";
import { projectFiles } from "archunit";
import fs from "node:fs";
import path from "node:path";

const ARCHITECTURE_TEST_TIMEOUT_MS = 15_000;
const PROJECT_ROOT = process.cwd();
const SRC_ROOT = path.join(PROJECT_ROOT, "src");
const EVENTS_ROOT = path.join(SRC_ROOT, "discord", "events");

interface ImportEdge {
  importer: string;
  imported: string;
}

function normalizePath(filePath: string): string {
  return path.relative(PROJECT_ROOT, filePath).replaceAll("\\", "/");
}

function getTsFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return getTsFiles(fullPath);
    if (entry.isFile() && fullPath.endsWith(".ts")) return [fullPath];
    return [];
  });
}

function resolveImport(fromFile: string, specifier: string): string | null {
  if (specifier.startsWith("@/")) {
    return path.join(SRC_ROOT, specifier.slice(2));
  }

  if (specifier.startsWith(".")) {
    return path.resolve(path.dirname(fromFile), specifier);
  }

  return null;
}

function resolveTsModule(basePath: string): string | null {
  const directFile = basePath.endsWith(".ts") ? basePath : `${basePath}.ts`;
  if (fs.existsSync(directFile)) return directFile;

  const indexFile = path.join(basePath, "index.ts");
  if (fs.existsSync(indexFile)) return indexFile;

  return null;
}

function collectLocalImports(): ImportEdge[] {
  const importRegex = /from\s+["']([^"']+)["']|import\s+["']([^"']+)["']/g;
  const files = getTsFiles(SRC_ROOT);
  const edges: ImportEdge[] = [];

  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    for (const match of content.matchAll(importRegex)) {
      const specifier = match[1] ?? match[2];
      if (!specifier) continue;

      const resolvedBase = resolveImport(file, specifier);
      if (!resolvedBase) continue;

      const imported = resolveTsModule(resolvedBase);
      if (!imported) continue;

      edges.push({ importer: file, imported });
    }
  }

  return edges;
}

function getEventFolders(): string[] {
  return getTsFiles(EVENTS_ROOT)
    .filter((file) => path.basename(file) === "index.ts")
    .map((file) => path.dirname(file))
    .sort();
}

function isInsideFolder(file: string, folder: string): boolean {
  const relative = path.relative(folder, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function getCommandEntryFiles(): string[] {
  return getTsFiles(path.join(EVENTS_ROOT, "interactionCreate")).filter((file) => {
    const relative = path.relative(path.join(EVENTS_ROOT, "interactionCreate"), file).replaceAll("\\", "/");
    if (relative === "index.ts") return false;
    if (!relative.includes("/")) return true;
    return relative.split("/").length === 2 && relative.endsWith("/index.ts");
  });
}

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

  it("interactionCreate command entry files should not depend on each other", () => {
    const commandEntries = new Set(getCommandEntryFiles());
    const violations = collectLocalImports().filter(
      ({ importer, imported }) => commandEntries.has(importer) && commandEntries.has(imported) && importer !== imported,
    );

    expect(
      violations.map(({ importer, imported }) => `${normalizePath(importer)} -> ${normalizePath(imported)}`),
    ).toEqual([]);
  });

  test.skip("event folder internals should stay private to their own folder", () => {
    const eventFolders = getEventFolders();
    const commandEntries = new Set(getCommandEntryFiles());
    const internalFiles = new Map<string, string>();

    for (const folder of eventFolders) {
      for (const file of getTsFiles(folder)) {
        if (path.basename(file) === "index.ts") continue;
        if (commandEntries.has(file)) continue;
        internalFiles.set(file, folder);
      }
    }

    const violations = collectLocalImports().filter(({ importer, imported }) => {
      const owningFolder = internalFiles.get(imported);
      if (!owningFolder) return false;
      return path.dirname(importer) !== owningFolder && !isInsideFolder(importer, owningFolder);
    });

    expect(
      violations.map(({ importer, imported }) => `${normalizePath(importer)} -> ${normalizePath(imported)}`),
    ).toEqual([]);
  });
});
