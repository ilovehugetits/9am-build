import { access, mkdir } from "fs/promises";
import path from "path";
import chalk from "chalk";

const REPOS_DIR = path.resolve(import.meta.dirname, "../../repos");

export function getGitDiff(repoDir: string, beforeSha: string, afterSha: string): string {
  const result = Bun.spawnSync(["git", "diff", `${beforeSha}..${afterSha}`], {
    cwd: repoDir,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return result.stdout.toString().trim();
}

/** Latest tag reachable from HEAD, ignoring `releaseTag` itself. Works whether
 *  or not the new release tag exists locally yet. Null when there is none. */
export function getPreviousTag(repoDir: string, releaseTag: string): string | null {
  const result = Bun.spawnSync(
    ["git", "-C", repoDir, "describe", "--tags", "--abbrev=0", "--exclude", releaseTag, "HEAD"],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
  return result.exitCode === 0 ? result.stdout.toString().trim() || null : null;
}

export function getRepoDir(repoName: string): string {
  return path.join(REPOS_DIR, repoName);
}

async function isCloned(repoName: string): Promise<boolean> {
  try {
    await access(path.join(getRepoDir(repoName), ".git"));
    return true;
  } catch {
    return false;
  }
}

function runGit(args: string[]): void {
  Bun.spawnSync(["git", ...args], { stdio: ["pipe", "pipe", "pipe"] });
}

export async function cloneOrPull(
  repoName: string,
  githubUrl: string,
  branch: string = "main"
): Promise<string> {
  await mkdir(REPOS_DIR, { recursive: true });
  const repoDir = getRepoDir(repoName);

  if (await isCloned(repoName)) {
    console.log(chalk.gray(`[${repoName}] Repo exists, pulling...`));
    // --tags: release tags are created via the GitHub API, so a branch-only
    // fetch never brings them in, and the changelog cannot find the previous one.
    runGit(["-C", repoDir, "fetch", "--tags", "--force", "origin", branch]);
    runGit(["-C", repoDir, "reset", "--hard", `origin/${branch}`]);
    console.log(chalk.green(`[${repoName}] Pull completed.`));
  } else {
    console.log(chalk.gray(`[${repoName}] Cloning repo...`));
    runGit(["clone", "--branch", branch, "--single-branch", githubUrl, repoDir]);
    console.log(chalk.green(`[${repoName}] Clone completed.`));
  }

  return repoDir;
}
