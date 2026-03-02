import chalk from "chalk";

const BRAND_COLOR = 0xf3dd70;

export interface DiscordChangelogOptions {
  repoName: string;
  changelog: string;
}

export async function sendDiscordChangelog(options: DiscordChangelogOptions): Promise<void> {
  const webhookUrl = process.env.DISCORD_CHANGELOG_WEBHOOK;
  if (!webhookUrl) {
    console.log(chalk.yellow("[Discord] DISCORD_CHANGELOG_WEBHOOK is not set, skipping."));
    return;
  }

  const embed = {
    title: `${options.repoName} updated! 🚀`,
    description: `${options.changelog}\n\n📦 Download the latest version from [CFX Portal](https://portal.cfx.re/assets/granted-assets?page=1&sort=asset.updated_at&direction=asc&search=${encodeURIComponent(options.repoName)}).`,
    color: BRAND_COLOR,
    timestamp: new Date().toISOString(),
  };

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "9am studios",
      avatar_url: "https://cdn.9am.dev/logo.png",
      embeds: [embed],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Discord webhook failed (${response.status}): ${text}`);
  }

  console.log(chalk.green("[Discord] Changelog notification sent."));
}
