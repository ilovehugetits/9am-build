import chalk from "chalk";
import { getGitDiff } from "../core/git.js";
import { generateChangelog } from "../integrations/changelog.js";
import { sendDiscordChangelog, classifyReleaseType } from "../integrations/discord.js";
import type { GitHubReleaseResult } from "../integrations/github.js";

/** After a GitHub release (brand-new or a re-deploy of an existing tag),
 *  summarize commits since the previous tag and post a Discord changelog.
 *  No-op only when no release could be made at all. */
export async function announceRelease(
  repoDir: string,
  repoName: string,
  release: GitHubReleaseResult | null
): Promise<void> {
  if (!release || release.status === "skipped" || !release.tag) return;

  try {
    const prevTag = Bun.spawnSync(
      ["git", "-C", repoDir, "describe", "--tags", "--abbrev=0", `${release.tag}^`],
      { stdio: ["pipe", "pipe", "pipe"] }
    ).stdout.toString().trim();

    const logArgs = prevTag
      ? ["git", "-C", repoDir, "log", `${prevTag}..HEAD`, "--pretty=format:%s"]
      : ["git", "-C", repoDir, "log", "-10", "--pretty=format:%s"];
    const messages = Bun.spawnSync(logArgs, { stdio: ["pipe", "pipe", "pipe"] })
      .stdout.toString().trim().split("\n").filter(Boolean);

    if (messages.length === 0) return;

    console.log(chalk.gray(`[Changelog] ${repoName}: generating (${prevTag || "history"} → ${release.tag})...`));
    const diff = prevTag ? getGitDiff(repoDir, prevTag, "HEAD") : "";
    const changelog = await generateChangelog({
      repoName,
      commits: messages.map((message) => ({ message, added: [], removed: [], modified: [] })),
      diff,
    });
    console.log(chalk.gray(`[Changelog] ${repoName}:\n${changelog}`));

    await sendDiscordChangelog({
      repoName,
      changelog,
      version: release.version,
      releaseType: classifyReleaseType(messages),
    });
  } catch (err) {
    console.error(
      chalk.yellow(`[Changelog] ${repoName}: failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
    );
  }
}
