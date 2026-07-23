import path from "path";
import { rm } from "fs/promises";
import chalk from "chalk";
import { buildZips } from "./build.js";
import { createGitHubRelease, type GitHubReleaseResult } from "../integrations/github.js";

/** Build zips and publish a GitHub release with them — no portal upload,
 *  no browser. Discord announcement is handled by the caller via announceRelease. */
export async function releaseCommand(
  scriptDir: string
): Promise<{ repoDir: string; release: GitHubReleaseResult | null }> {
  const resolvedDir = path.resolve(scriptDir);
  const { zips, outputDir } = await buildZips(resolvedDir);

  let release: GitHubReleaseResult | null = null;
  try {
    const zipPaths = [zips.escrowZip, zips.openZip].filter((p): p is string => !!p);
    release = await createGitHubRelease({ repoDir: resolvedDir, zipPaths });
  } catch (err) {
    console.log(chalk.yellow(`GitHub release failed: ${err instanceof Error ? err.message : String(err)}`));
    throw err;
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }

  console.log(chalk.bold.green("GitHub release complete (portal untouched).\n"));
  return { repoDir: resolvedDir, release };
}
