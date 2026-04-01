import { access, mkdir } from "fs/promises";
import path from "path";
import chalk from "chalk";

const REPOS_DIR = path.resolve(import.meta.dirname, "../repos");

export function getGitDiff(repoDir: string, beforeSha: string, afterSha: string): string {
  const result = Bun.spawnSync(["git", "diff", `${beforeSha}..${afterSha}`], {
    cwd: repoDir,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return result.stdout.toString().trim();
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
    runGit(["-C", repoDir, "fetch", "origin", branch]);
    runGit(["-C", repoDir, "reset", "--hard", `origin/${branch}`]);
    console.log(chalk.green(`[${repoName}] Pull completed.`));
  } else {
    console.log(chalk.gray(`[${repoName}] Cloning repo...`));
    runGit(["clone", "--branch", branch, "--single-branch", githubUrl, repoDir]);
    console.log(chalk.green(`[${repoName}] Clone completed.`));
  }

  return repoDir;
}
