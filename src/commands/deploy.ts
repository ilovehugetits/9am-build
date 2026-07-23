import path from "path";
import { rm } from "fs/promises";
import chalk from "chalk";
import { buildZips } from "./build.js";
import { ensureSession } from "../cfx/session.js";
import { uploadAsset } from "../cfx/upload.js";
import { readManifestVersion } from "../core/manifest.js";
import { createGitHubRelease, type GitHubReleaseResult } from "../integrations/github.js";

export async function deployCommand(
  scriptDir: string
): Promise<{ repoDir: string; release: GitHubReleaseResult | null }> {
  const resolvedDir = path.resolve(scriptDir);
  const { config, zips, outputDir } = await buildZips(resolvedDir);

  const version = await readManifestVersion(resolvedDir);
  if (!version) throw new Error("Could not read version from fxmanifest.lua.");

  console.log(chalk.gray("Ensuring portal session..."));
  const session = await ensureSession();
  try {
    if (zips.escrowZip && config.versions.escrow) {
      await uploadAsset(session.request, {
        assetId: config.versions.escrow.assetId, zipPath: zips.escrowZip, version, label: "ESCROW",
      });
    }
    if (zips.openZip && config.versions.open) {
      await uploadAsset(session.request, {
        assetId: config.versions.open.assetId, zipPath: zips.openZip, version, label: "OPEN",
      });
    }
    console.log(chalk.bold.green("All versions uploaded."));
  } finally {
    await session.close();
  }

  let release: GitHubReleaseResult | null = null;
  try {
    const zipPaths = [zips.escrowZip, zips.openZip].filter((p): p is string => !!p);
    release = await createGitHubRelease({ repoDir: resolvedDir, zipPaths });
  } catch (err) {
    console.log(chalk.yellow(`GitHub release failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`));
  }

  await rm(outputDir, { recursive: true, force: true });
  return { repoDir: resolvedDir, release };
}
