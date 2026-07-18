import path from "path";
import { readFile } from "fs/promises";
import chalk from "chalk";

export interface GitHubReleaseOptions {
  repoDir: string;
  zipPaths: string[];
}

export interface GitHubReleaseResult {
  // "created" = brand-new release, "existing" = tag already had a release
  // (version not bumped), "skipped" = missing token/remote/version
  status: "created" | "existing" | "skipped";
  version?: string;
  tag?: string;
  htmlUrl?: string;
}

interface GitHubRepoRef {
  owner: string;
  repo: string;
}

const API_BASE = "https://api.github.com";

function gitOutput(repoDir: string, args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", repoDir, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  return result.stdout.toString().trim();
}

function parseGitHubRepo(remoteUrl: string): GitHubRepoRef | null {
  // Matches both https://github.com/owner/repo(.git) and git@github.com:owner/repo(.git)
  const match = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

export async function readManifestVersion(repoDir: string): Promise<string | null> {
  try {
    const manifest = await readFile(path.join(repoDir, "fxmanifest.lua"), "utf-8");
    const match = manifest.match(/^\s*version\s+['"]([^'"]+)['"]/m);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

async function githubRequest(
  token: string,
  method: string,
  url: string,
  body?: unknown
): Promise<Response> {
  return fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function uploadReleaseAsset(
  token: string,
  repoRef: GitHubRepoRef,
  releaseId: number,
  zipPath: string
): Promise<void> {
  const assetName = path.basename(zipPath);
  const data = await Bun.file(zipPath).arrayBuffer();

  const url = `https://uploads.github.com/repos/${repoRef.owner}/${repoRef.repo}/releases/${releaseId}/assets?name=${encodeURIComponent(assetName)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/zip",
    },
    body: data,
  });

  if (response.status === 422) {
    console.log(chalk.yellow(`[GitHub] Asset '${assetName}' already exists on the release, skipping.`));
    return;
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Asset upload failed for '${assetName}' (${response.status}): ${text}`);
  }

  console.log(chalk.green(`[GitHub] Asset uploaded: ${assetName}`));
}

export async function createGitHubRelease(options: GitHubReleaseOptions): Promise<GitHubReleaseResult> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.log(chalk.yellow("[GitHub] GITHUB_TOKEN is not set, skipping release."));
    return { status: "skipped" };
  }

  const remoteUrl = gitOutput(options.repoDir, ["config", "--get", "remote.origin.url"]);
  if (!remoteUrl) {
    console.log(chalk.yellow("[GitHub] No git remote found, skipping release."));
    return { status: "skipped" };
  }

  const repoRef = parseGitHubRepo(remoteUrl);
  if (!repoRef) {
    console.log(chalk.yellow(`[GitHub] Remote is not a GitHub URL (${remoteUrl}), skipping release.`));
    return { status: "skipped" };
  }

  const version = await readManifestVersion(options.repoDir);
  if (!version) {
    console.log(chalk.yellow("[GitHub] Could not read version from fxmanifest.lua, skipping release."));
    return { status: "skipped" };
  }

  const tag = `v${version}`;
  const headSha = gitOutput(options.repoDir, ["rev-parse", "HEAD"]);

  console.log(chalk.gray(`[GitHub] Creating release ${tag} for ${repoRef.owner}/${repoRef.repo}...`));

  let releaseId: number;
  let releaseStatus: GitHubReleaseResult["status"];
  let htmlUrl: string | undefined;
  const createResponse = await githubRequest(
    token,
    "POST",
    `${API_BASE}/repos/${repoRef.owner}/${repoRef.repo}/releases`,
    {
      tag_name: tag,
      target_commitish: headSha || undefined,
      name: tag,
      generate_release_notes: true,
    }
  );

  if (createResponse.status === 422) {
    // Tag/release already exists — attach assets to the existing release instead
    console.log(chalk.yellow(`[GitHub] Release ${tag} already exists, uploading assets to it.`));
    const existingResponse = await githubRequest(
      token,
      "GET",
      `${API_BASE}/repos/${repoRef.owner}/${repoRef.repo}/releases/tags/${encodeURIComponent(tag)}`
    );
    if (!existingResponse.ok) {
      const text = await existingResponse.text();
      throw new Error(`Could not fetch existing release ${tag} (${existingResponse.status}): ${text}`);
    }
    const existing = (await existingResponse.json()) as { id: number; html_url: string };
    releaseId = existing.id;
    releaseStatus = "existing";
    htmlUrl = existing.html_url;
  } else if (!createResponse.ok) {
    const text = await createResponse.text();
    throw new Error(`Release creation failed (${createResponse.status}): ${text}`);
  } else {
    const created = (await createResponse.json()) as { id: number; html_url: string };
    releaseId = created.id;
    releaseStatus = "created";
    htmlUrl = created.html_url;
    console.log(chalk.green(`[GitHub] Release created: ${created.html_url}`));
  }

  for (const zipPath of options.zipPaths) {
    await uploadReleaseAsset(token, repoRef, releaseId, zipPath);
  }

  console.log(chalk.green(`[GitHub] Release ${tag} is ready with ${options.zipPaths.length} asset(s).`));

  return { status: releaseStatus, version, tag, htmlUrl };
}
