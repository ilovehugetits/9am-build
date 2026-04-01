import chalk from "chalk";
import { cloneOrPull, getRepoDir, getGitDiff } from "./git.js";
import { deployScript } from "./deploy.js";
import { startServer, loadReposConfig } from "./server.js";
import { registerPasskey } from "./register-passkey.js";
import { generateChangelog } from "./changelog.js";
import { sendDiscordChangelog } from "./discord.js";

async function main() {
  const command = process.argv[2];

  if (!command) {
    console.error(chalk.red("Usage:"));
    console.error(chalk.red("  bun run deploy <script-name>    Build + upload"));
    console.error(chalk.red("  bun run build <script-name>     Build only (no upload)"));
    console.error(chalk.red("  bun run server                  Start webhook server"));
    console.error(chalk.red("  bun run register-passkey        Register forum passkey"));
    console.error(chalk.red("  bun src/index.ts debug <repo> <commit-id>  Changelog test"));
    process.exit(1);
  }

  // Server mode
  if (command === "server" || command === "serve") {
    await startServer();
    return;
  }

  // Passkey registration mode
  if (command === "register-passkey") {
    await registerPasskey();
    return;
  }

  // Debug mode: "debug <repo-name> <commit-id>"
  if (command === "debug") {
    const repoName = process.argv[3];
    const commitId = process.argv[4];

    if (!repoName || !commitId) {
      console.error(chalk.red("Usage: bun src/index.ts debug <repo-name> <commit-id>"));
      process.exit(1);
    }

    const repoDir = getRepoDir(repoName);
    console.log(chalk.bold(`\n9am-build — Debug Changelog\n`));

    // Get commit info
    const logResult = Bun.spawnSync(
      ["git", "log", commitId, "-1", "--pretty=format:%s"],
      { cwd: repoDir, stdio: ["pipe", "pipe", "pipe"] }
    );
    const commitMessage = logResult.stdout.toString().trim();

    const filesResult = Bun.spawnSync(
      ["git", "diff-tree", "--no-commit-id", "-r", "--name-status", commitId],
      { cwd: repoDir, stdio: ["pipe", "pipe", "pipe"] }
    );
    const filesRaw = filesResult.stdout.toString().trim();

    const added: string[] = [];
    const removed: string[] = [];
    const modified: string[] = [];
    for (const line of filesRaw.split("\n").filter(Boolean)) {
      const [status, file] = line.split("\t");
      if (status === "A") added.push(file);
      else if (status === "D") removed.push(file);
      else modified.push(file);
    }

    // Get diff (commit vs parent)
    const diff = getGitDiff(repoDir, `${commitId}~1`, commitId);

    console.log(chalk.gray(`Commit: ${commitMessage}`));
    console.log(chalk.gray(`Files: +${added.length} -${removed.length} ~${modified.length}\n`));

    // Generate changelog
    const changelog = await generateChangelog({
      repoName,
      commits: [{ message: commitMessage, added, removed, modified }],
      diff,
    });

    console.log(chalk.green(`Changelog:\n${changelog}\n`));

    // Send to Discord
    await sendDiscordChangelog({ repoName, changelog });
    return;
  }

  // Build-only mode: "build <script-name>"
  const buildOnly = command === "build";
  const scriptName = buildOnly ? process.argv[3] : command;

  if (!scriptName) {
    console.error(chalk.red("Script name not specified."));
    process.exit(1);
  }

  const config = await loadReposConfig();
  const repo = config.repos.find((r) => r.name === scriptName);

  if (!repo) {
    console.log(chalk.yellow(`[${scriptName}] Not found in repos.json, trying as direct path...`));
    await deployScript(scriptName, { buildOnly });
    return;
  }

  const repoDir = await cloneOrPull(repo.name, repo.githubUrl, repo.branch ?? "main");
  await deployScript(repoDir, { buildOnly });
}

main().catch((err) => {
  console.error(chalk.red(`\nError: ${err.message}`));
  process.exit(1);
});
