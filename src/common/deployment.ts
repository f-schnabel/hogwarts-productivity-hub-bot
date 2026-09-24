import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createLogger } from "@/common/logging/logger.ts";

const log = createLogger("Deploy");
const execFileAsync = promisify(execFile);

const REPO_ROOT = path.join(import.meta.dirname, "..", "..");
// Gitignored; holds the HEAD commit that was last announced in the alert channel
const LAST_DEPLOYED_COMMIT_FILE = path.join(REPO_ROOT, ".last-deployed-commit");
const MAX_ALERT_LENGTH = 2000;

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: REPO_ROOT });
  return stdout.trim();
}

async function readLastDeployedCommit(): Promise<string | null> {
  try {
    return (await readFile(LAST_DEPLOYED_COMMIT_FILE, "utf8")).trim() || null;
  } catch {
    return null;
  }
}

export interface DeploymentInfo {
  head: string;
  commits: string[];
}

// Commit summaries added since the last announced deployment, newest first
export async function getDeploymentInfo(): Promise<DeploymentInfo | null> {
  try {
    const head = await git("rev-parse", "HEAD");
    const lastDeployed = await readLastDeployedCommit();

    // First run or unknown commit (e.g. force push): only report HEAD
    const range = lastDeployed && (await isKnownCommit(lastDeployed)) ? `${lastDeployed}..HEAD` : "-1";
    const output = await git("log", "--format=%h %s", range);
    return { head, commits: output ? output.split("\n") : [] };
  } catch (error) {
    log.warn("Failed to read git deployment info", { error: String(error) });
    return null;
  }
}

async function isKnownCommit(sha: string): Promise<boolean> {
  try {
    await git("cat-file", "-e", `${sha}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

export async function saveDeployedCommit(head: string): Promise<void> {
  try {
    await writeFile(LAST_DEPLOYED_COMMIT_FILE, head);
  } catch (error) {
    log.warn("Failed to save deployed commit", { head, error: String(error) });
  }
}

export function formatDeploymentMessage(info: DeploymentInfo | null): string {
  if (!info) return "Bot deployed successfully.";
  if (info.commits.length === 0) return "Bot restarted (no new commits).";

  const header = `Bot deployed successfully (${info.commits.length} new commit${info.commits.length === 1 ? "" : "s"}):`;
  const lines: string[] = [];
  let length = header.length;
  for (const [index, commit] of info.commits.entries()) {
    const line = `- ${commit}`;
    const remaining = info.commits.length - index;
    // Reserve room for a trailing "...and N more" line
    if (length + line.length + 1 > MAX_ALERT_LENGTH - 30) {
      lines.push(`...and ${remaining} more`);
      break;
    }
    lines.push(line);
    length += line.length + 1;
  }

  return [header, ...lines].join("\n");
}
