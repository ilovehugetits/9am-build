import { createHmac, timingSafeEqual } from "crypto";
import chalk from "chalk";
import { cloneOrPull, getGitDiff } from "../core/git.js";
import { deployCommand } from "./deploy.js";
import { buildQueue } from "../server-support/queue.js";
import { loadReposConfig, type RepoEntry } from "../server-support/repos.js";
import { generateChangelog } from "../integrations/changelog.js";
import { sendDiscordChangelog, classifyReleaseType } from "../integrations/discord.js";

interface GitHubCommit {
  id: string;
  message: string;
  added: string[];
  removed: string[];
  modified: string[];
}

interface GitHubPushPayload {
  ref: string;
  before: string;
  after: string;
  compare: string;
  commits: GitHubCommit[];
  head_commit: GitHubCommit | null;
  repository: {
    name: string;
    full_name: string;
    clone_url: string;
  };
}

function getEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`.env: '${key}' is not defined.`);
  return value;
}

function verifySignature(payload: string, signature: string, secret: string): boolean {
  const expected = "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

function findRepo(payload: GitHubPushPayload, repos: RepoEntry[]): RepoEntry | null {
  return (
    repos.find(
      (r) => r.name === payload.repository.name || r.githubUrl === payload.repository.clone_url
    ) ?? null
  );
}

async function handleWebhook(req: Request, repos: RepoEntry[], webhookSecret: string): Promise<Response> {
  const body = await req.text();

  const signature = req.headers.get("x-hub-signature-256");
  if (!signature) {
    console.log(chalk.red("[Webhook] Missing signature header, rejected."));
    return new Response("Missing signature", { status: 401 });
  }

  if (!verifySignature(body, signature, webhookSecret)) {
    console.log(chalk.red("[Webhook] Invalid signature, rejected."));
    return new Response("Invalid signature", { status: 401 });
  }

  const event = req.headers.get("x-github-event");
  if (event !== "push") {
    console.log(chalk.gray(`[Webhook] Event: ${event}, skipping.`));
    return new Response("Ignored event", { status: 200 });
  }

  let payload: GitHubPushPayload;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const repo = findRepo(payload, repos);
  if (!repo) {
    console.log(chalk.yellow(`[Webhook] Unknown repo: ${payload.repository.full_name}`));
    return new Response("Unknown repository", { status: 200 });
  }

  const pushBranch = payload.ref.replace("refs/heads/", "");
  const targetBranch = repo.branch ?? "main";
  if (pushBranch !== targetBranch) {
    console.log(
      chalk.gray(`[Webhook] ${repo.name}: Push branch ${pushBranch}, target ${targetBranch}, skipping.`)
    );
    return new Response("Branch mismatch", { status: 200 });
  }

  console.log(chalk.blue(`[Webhook] ${repo.name}: Push received, queuing build...`));

  buildQueue.enqueue(repo.name, async () => {
    console.log(chalk.blue(`\n[Pipeline] ${repo.name}: Starting...`));
    const repoDir = await cloneOrPull(repo.name, repo.githubUrl, targetBranch);
    const { release } = await deployCommand(repoDir);
    console.log(chalk.bold.green(`[Pipeline] ${repo.name}: Completed.`));

    // Discord changelog (non-fatal) — announce new releases and same-version
    // re-deploys; skip only when no GitHub release could be made at all.
    try {
      if (!release || release.status === "skipped") {
        console.log(
          chalk.gray(
            `[Discord] ${repo.name}: No new GitHub release (${release?.status ?? "failed"}), skipping notification.`
          )
        );
      } else {
        console.log(chalk.gray(`[Changelog] ${repo.name}: Generating...`));

        const isInitialPush = payload.before === "0000000000000000000000000000000000000000";
        const diff = isInitialPush ? "" : getGitDiff(repoDir, payload.before, payload.after);

        const changelog = await generateChangelog({
          repoName: repo.name,
          commits: payload.commits.map((c) => ({
            message: c.message,
            added: c.added,
            removed: c.removed,
            modified: c.modified,
          })),
          diff,
        });

        console.log(chalk.gray(`[Changelog] ${repo.name}:\n${changelog}`));

        await sendDiscordChangelog({
          repoName: repo.name,
          changelog,
          version: release.version,
          releaseType: classifyReleaseType(payload.commits.map((c) => c.message)),
        });
      }
    } catch (err: any) {
      console.error(chalk.yellow(`[Changelog] ${repo.name}: Failed (non-fatal): ${err.message}`));
    }

    console.log();
  });

  return new Response(JSON.stringify({ status: "queued", repo: repo.name }), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function startServer(): Promise<void> {
  const webhookSecret = getEnv("WEBHOOK_SECRET");
  const port = parseInt(getEnv("PORT"), 10);
  const config = await loadReposConfig();

  console.log(chalk.bold("\n9am-build Webhook Server\n"));
  console.log(chalk.gray(`Port: ${port}`));
  console.log(chalk.gray(`Monitored repos: ${config.repos.map((r) => r.name).join(", ")}\n`));

  Bun.serve({
    port,

    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);

      if (req.method === "GET" && url.pathname === "/health") {
        return new Response(JSON.stringify({ status: "ok" }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (req.method === "POST" && url.pathname === "/webhook") {
        return handleWebhook(req, config.repos, webhookSecret);
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  console.log(chalk.bold.green(`Server started on port ${port}.\n`));
}
