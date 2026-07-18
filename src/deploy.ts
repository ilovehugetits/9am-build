import path from "path";
import { mkdir, rm } from "fs/promises";
import chalk from "chalk";
import { loadConfig } from "./config.js";
import { buildVersions } from "./build.js";
import { getAuthenticatedContext } from "./auth.js";
import { uploadAsset } from "./upload.js";
import { createGitHubRelease, type GitHubReleaseResult } from "./github.js";

interface DeployOptions {
  buildOnly?: boolean;
}

export async function deployScript(
  scriptDir: string,
  options: DeployOptions = {}
): Promise<GitHubReleaseResult | null> {
  const resolvedDir = path.resolve(scriptDir);
  console.log(chalk.bold(`\n9am-build — ${resolvedDir}\n`));

  // 1. Load config
  console.log(chalk.gray("Loading config..."));
  const config = await loadConfig(resolvedDir);
  console.log(chalk.green(`Script: ${config.name}`));

  const versionList = [
    config.versions.escrow && "escrow",
    config.versions.open && "open",
  ].filter(Boolean);
  console.log(chalk.green(`Versions: ${versionList.join(", ")}\n`));

  // 2. Output directory for zips
  const outputDir = path.join(resolvedDir, ".build");
  await mkdir(outputDir, { recursive: true });

  // 3. Build
  console.log(chalk.gray("Creating zip files..."));
  const zips = await buildVersions(resolvedDir, config, outputDir);

  if (zips.escrowZip) {
    console.log(chalk.green(`Escrow zip: ${zips.escrowZip}`));
  }
  if (zips.openZip) {
    console.log(chalk.green(`Open source zip: ${zips.openZip}`));
  }
  console.log();

  if (options.buildOnly) {
    console.log(chalk.bold.green("Zips ready! (.build/ directory)\n"));
    return null;
  }

  // 4. Auth
  console.log(chalk.gray("Checking portal auth..."));
  const context = await getAuthenticatedContext();

  // 5. Upload
  try {
    if (zips.escrowZip && config.versions.escrow) {
      await uploadAsset(context, config.versions.escrow.assetId, zips.escrowZip, "ESCROW");
    }

    if (zips.openZip && config.versions.open) {
      await uploadAsset(context, config.versions.open.assetId, zips.openZip, "OPEN");
    }

    console.log(chalk.bold.green("All versions uploaded successfully!"));
    await context.close();
  } catch (err) {
    console.log(chalk.red(`Upload error: ${err instanceof Error ? err.message : String(err)}`));
    await context.close().catch(() => {});
    throw err;
  }

  // 6. GitHub release with the built zips (non-fatal)
  let release: GitHubReleaseResult | null = null;
  try {
    const zipPaths = [zips.escrowZip, zips.openZip].filter((p): p is string => !!p);
    release = await createGitHubRelease({ repoDir: resolvedDir, zipPaths });
  } catch (err) {
    console.log(
      chalk.yellow(`GitHub release failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
    );
  }

  // 7. Cleanup
  await rm(outputDir, { recursive: true, force: true });
  console.log(chalk.gray("Temporary files cleaned up.\n"));

  return release;
}
