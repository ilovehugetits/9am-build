import { readFile, writeFile, cp, mkdtemp, rm, access } from "fs/promises";
import path from "path";
import os from "os";
import archiver from "archiver";
import { createWriteStream } from "fs";
import { glob } from "glob";
import chalk from "chalk";
import type { UploadConfig } from "./config.js";

interface BuildResult {
  escrowZip?: string;
  openZip?: string;
}

const ALWAYS_EXCLUDE = [
  "**/node_modules/**",
  "**/.build/**",
];

async function copyScriptFiles(scriptDir: string, destDir: string, excludePatterns: string[]): Promise<void> {
  const allFiles = await glob("**/*", {
    cwd: scriptDir,
    nodir: true,
    dot: false,
    ignore: [...ALWAYS_EXCLUDE, ...excludePatterns],
  });

  for (const file of allFiles) {
    const srcPath = path.join(scriptDir, file);
    const destPath = path.join(destDir, file);
    await cp(srcPath, destPath, { recursive: true, force: true });
  }
}

async function buildFrontend(scriptDir: string, config: UploadConfig): Promise<void> {
  if (!config.frontend) return;

  const frontendDir = path.join(scriptDir, config.frontend.dir);

  try {
    await access(path.join(frontendDir, "package.json"));
  } catch {
    throw new Error(`Frontend directory not found: ${frontendDir}`);
  }

  const buildCmd = config.frontend.buildCommand ?? "bun run build";
  console.log(chalk.gray(`Frontend build: ${config.frontend.dir} → ${buildCmd}`));

  // Install dependencies
  const install = Bun.spawnSync(["bun", "install"], { cwd: frontendDir, stdio: ["pipe", "pipe", "pipe"] });
  if (install.exitCode !== 0) {
    throw new Error(`Frontend bun install failed: ${install.stderr.toString()}`);
  }

  // Run build
  const parts = buildCmd.split(" ");
  const build = Bun.spawnSync(parts, { cwd: frontendDir, stdio: ["pipe", "pipe", "pipe"] });
  if (build.exitCode !== 0) {
    throw new Error(`Frontend build failed: ${build.stderr.toString()}`);
  }

  console.log(chalk.green("Frontend build completed."));
}

function buildEscrowIgnoreBlock(patterns: string[]): string {
  const entries = patterns.map((p) => `  '${p}'`).join(",\n");
  return `\n\nescrow_ignore {\n${entries}\n}\n`;
}

async function appendEscrowIgnore(fxmanifestPath: string, patterns: string[]): Promise<void> {
  const content = await readFile(fxmanifestPath, "utf-8");
  const block = buildEscrowIgnoreBlock(patterns);
  await writeFile(fxmanifestPath, content + block, "utf-8");
}

async function createZip(sourceDir: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", resolve);
    archive.on("error", reject);

    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

export async function buildVersions(scriptDir: string, config: UploadConfig, outputDir: string): Promise<BuildResult> {
  const result: BuildResult = {};
  const resolvedScriptDir = path.resolve(scriptDir);

  // Frontend build (before zipping)
  await buildFrontend(resolvedScriptDir, config);

  // Escrow: exclude entire frontend dir, then copy only build output
  if (config.versions.escrow) {
    const escrowExclude = [...config.exclude];
    if (config.frontend) {
      escrowExclude.push(`${config.frontend.dir}/**`);
    }

    const tempDir = await mkdtemp(path.join(os.tmpdir(), `${config.name}-escrow-`));

    try {
      await copyScriptFiles(resolvedScriptDir, tempDir, escrowExclude);

      // Copy only the frontend build output
      if (config.frontend) {
        const buildOutput = config.frontend.buildOutput ?? "build";
        const srcBuildDir = path.join(resolvedScriptDir, config.frontend.dir, buildOutput);
        const destBuildDir = path.join(tempDir, config.frontend.dir, buildOutput);
        await cp(srcBuildDir, destBuildDir, { recursive: true, force: true });
      }

      const fxPath = path.join(tempDir, "fxmanifest.lua");
      await appendEscrowIgnore(fxPath, config.versions.escrow.escrowIgnore!);

      const zipPath = path.join(outputDir, `${config.name}-escrow.zip`);
      await createZip(tempDir, zipPath);
      result.escrowZip = zipPath;
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  // Open source: include frontend src
  if (config.versions.open) {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), `${config.name}-open-`));

    try {
      await copyScriptFiles(resolvedScriptDir, tempDir, config.exclude);

      const fxPath = path.join(tempDir, "fxmanifest.lua");
      await appendEscrowIgnore(fxPath, ["**/*.*", "*"]);

      const zipPath = path.join(outputDir, `${config.name}-open.zip`);
      await createZip(tempDir, zipPath);
      result.openZip = zipPath;
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  return result;
}
