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
    console.error(chalk.red("Kullanım:"));
    console.error(chalk.red("  bun run deploy <script-adı>    Build + upload"));
    console.error(chalk.red("  bun run build <script-adı>     Sadece build (upload yok)"));
    console.error(chalk.red("  bun run server                 Webhook server başlat"));
    console.error(chalk.red("  bun run register-passkey       Forum'a passkey kaydet"));
    console.error(chalk.red("  bun src/index.ts debug <repo> <commit-id>  Changelog test"));
    process.exit(1);
  }

  // Server modu
  if (command === "server" || command === "serve") {
    await startServer();
    return;
  }

  // Passkey kayıt modu
  if (command === "register-passkey") {
    await registerPasskey();
    return;
  }

  // Debug modu: "debug <repo-adı> <commit-id>"
  if (command === "debug") {
    const repoName = process.argv[3];
    const commitId = process.argv[4];

    if (!repoName || !commitId) {
      console.error(chalk.red("Kullanım: bun src/index.ts debug <repo-adı> <commit-id>"));
      process.exit(1);
    }

    const repoDir = getRepoDir(repoName);
    console.log(chalk.bold(`\n9am-build — Debug Changelog\n`));

    // Commit bilgilerini al
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

    // Diff al (commit vs parent)
    const diff = getGitDiff(repoDir, `${commitId}~1`, commitId);

    console.log(chalk.gray(`Commit: ${commitMessage}`));
    console.log(chalk.gray(`Files: +${added.length} -${removed.length} ~${modified.length}\n`));

    // Changelog üret
    const changelog = await generateChangelog({
      repoName,
      commits: [{ message: commitMessage, added, removed, modified }],
      diff,
    });

    console.log(chalk.green(`Changelog:\n${changelog}\n`));

    // Discord'a gönder
    await sendDiscordChangelog({ repoName, changelog });
    return;
  }

  // Build-only modu: "build <script-adı>"
  const buildOnly = command === "build";
  const scriptName = buildOnly ? process.argv[3] : command;

  if (!scriptName) {
    console.error(chalk.red("Script adı belirtilmedi."));
    process.exit(1);
  }

  const config = await loadReposConfig();
  const repo = config.repos.find((r) => r.name === scriptName);

  if (!repo) {
    console.log(chalk.yellow(`[${scriptName}] repos.json'da bulunamadı, doğrudan dizin olarak deneniyor...`));
    await deployScript(scriptName, { buildOnly });
    return;
  }

  const repoDir = await cloneOrPull(repo.name, repo.githubUrl, repo.branch ?? "main");
  await deployScript(repoDir, { buildOnly });
}

main().catch((err) => {
  console.error(chalk.red(`\nHata: ${err.message}`));
  process.exit(1);
});
