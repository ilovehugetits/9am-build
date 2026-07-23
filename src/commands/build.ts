import path from "path";
import { mkdir } from "fs/promises";
import chalk from "chalk";
import { loadConfig, type UploadConfig } from "../core/config.js";
import { buildVersions, type BuildResult } from "../core/build.js";

export async function buildZips(
  scriptDir: string
): Promise<{ config: UploadConfig; zips: BuildResult; outputDir: string }> {
  const resolvedDir = path.resolve(scriptDir);
  const config = await loadConfig(resolvedDir);
  const outputDir = path.join(resolvedDir, ".build");
  await mkdir(outputDir, { recursive: true });
  console.log(chalk.gray("Building zips..."));
  const zips = await buildVersions(resolvedDir, config, outputDir);
  if (zips.escrowZip) console.log(chalk.green(`Escrow zip: ${zips.escrowZip}`));
  if (zips.openZip) console.log(chalk.green(`Open zip: ${zips.openZip}`));
  return { config, zips, outputDir };
}

export async function buildCommand(scriptDir: string): Promise<void> {
  const { outputDir } = await buildZips(scriptDir);
  console.log(chalk.bold.green(`Zips ready in ${outputDir}\n`));
}
