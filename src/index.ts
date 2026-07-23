import chalk from "chalk";
import { cloneOrPull, getRepoDir, getGitDiff } from "./core/git.js";
import { loadReposConfig } from "./server-support/repos.js";
import { buildCommand } from "./commands/build.js";
import { deployCommand } from "./commands/deploy.js";
import { releaseCommand } from "./commands/release.js";
import { registerCommand } from "./commands/register.js";
import { startServer } from "./commands/server.js";
import { announceRelease } from "./commands/shared.js";
import { generateChangelog } from "./integrations/changelog.js";
import { sendDiscordChangelog, classifyReleaseType } from "./integrations/discord.js";
import { readManifestVersion } from "./core/manifest.js";

function usage(): never {
  console.error(chalk.red("Usage:"));
  console.error(chalk.red("  bun run deploy <script>     Build + upload to portal + GitHub release"));
  console.error(chalk.red("  bun run build <script>      Build zips only"));
  console.error(chalk.red("  bun run release <script>    Build + GitHub release only (no portal)"));
  console.error(chalk.red("  bun run server              Start webhook server"));
  console.error(chalk.red("  bun run register-passkey    Register a forum passkey"));
  console.error(chalk.red("  bun src/index.ts debug <repo> <commit>  Changelog test"));
  process.exit(1);
}

async function resolveScriptDir(scriptName: string): Promise<{ dir: string; repoName: string }> {
  const config = await loadReposConfig();
  const repo = config.repos.find((r) => r.name === scriptName);
  if (!repo) {
    console.log(chalk.yellow(`[${scriptName}] Not in repos.json — treating as a local path.`));
    return { dir: scriptName, repoName: scriptName };
  }
  const dir = await cloneOrPull(repo.name, repo.githubUrl, repo.branch ?? "main");
  return { dir, repoName: repo.name };
}

async function runDebug(repoName: string, commitId: string): Promise<void> {
  const repoDir = getRepoDir(repoName);
  const commitMessage = Bun.spawnSync(["git", "log", commitId, "-1", "--pretty=format:%s"], {
    cwd: repoDir,
    stdio: ["pipe", "pipe", "pipe"],
  }).stdout.toString().trim();
  const filesRaw = Bun.spawnSync(["git", "diff-tree", "--no-commit-id", "-r", "--name-status", commitId], {
    cwd: repoDir,
    stdio: ["pipe", "pipe", "pipe"],
  }).stdout.toString().trim();
  const added: string[] = [], removed: string[] = [], modified: string[] = [];
  for (const line of filesRaw.split("\n").filter(Boolean)) {
    const [status, file] = line.split("\t");
    if (status === "A") added.push(file);
    else if (status === "D") removed.push(file);
    else modified.push(file);
  }
  const diff = getGitDiff(repoDir, `${commitId}~1`, commitId);
  const changelog = await generateChangelog({
    repoName,
    commits: [{ message: commitMessage, added, removed, modified }],
    diff,
  });
  console.log(chalk.green(`Changelog:\n${changelog}\n`));
  const version = await readManifestVersion(repoDir);
  await sendDiscordChangelog({
    repoName,
    changelog,
    version: version ?? undefined,
    releaseType: classifyReleaseType([commitMessage]),
  });
}

async function main() {
  const command = process.argv[2];
  if (!command) usage();

  switch (command) {
    case "server":
    case "serve":
      return startServer();
    case "register":
      return registerCommand();
    case "debug": {
      const [, , , repoName, commitId] = process.argv;
      if (!repoName || !commitId) usage();
      return runDebug(repoName, commitId);
    }
    case "build": {
      const scriptName = process.argv[3];
      if (!scriptName) usage();
      const { dir } = await resolveScriptDir(scriptName);
      return buildCommand(dir);
    }
    case "release": {
      const scriptName = process.argv[3];
      if (!scriptName) usage();
      const { dir, repoName } = await resolveScriptDir(scriptName);
      const { repoDir, release } = await releaseCommand(dir);
      return announceRelease(repoDir, repoName, release);
    }
    case "deploy": {
      const scriptName = process.argv[3];
      if (!scriptName) usage();
      const { dir, repoName } = await resolveScriptDir(scriptName);
      const { repoDir, release } = await deployCommand(dir);
      return announceRelease(repoDir, repoName, release);
    }
    default: {
      // Back-compat: bare "<script>" means deploy.
      const { dir, repoName } = await resolveScriptDir(command);
      const { repoDir, release } = await deployCommand(dir);
      return announceRelease(repoDir, repoName, release);
    }
  }
}

main().catch((err) => {
  console.error(chalk.red(`\nError: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});
