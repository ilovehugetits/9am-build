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
    throw new Error(`Frontend dizini bulunamadı: ${frontendDir}`);
  }

  const buildCmd = config.frontend.buildCommand ?? "bun run build";
  console.log(chalk.gray(`Frontend build: ${config.frontend.dir} → ${buildCmd}`));

  // Install dependencies
  const install = Bun.spawnSync(["bun", "install"], { cwd: frontendDir, stdio: ["pipe", "pipe", "pipe"] });
  if (install.exitCode !== 0) {
    throw new Error(`Frontend bun install başarısız: ${install.stderr.toString()}`);
  }

  // Run build
  const parts = buildCmd.split(" ");
  const build = Bun.spawnSync(parts, { cwd: frontendDir, stdio: ["pipe", "pipe", "pipe"] });
  if (build.exitCode !== 0) {
    throw new Error(`Frontend build başarısız: ${build.stderr.toString()}`);
  }

  console.log(chalk.green("Frontend build tamamlandı."));
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

  // Frontend build (zip'lemeden önce)
  await buildFrontend(resolvedScriptDir, config);

  // Escrow: frontend src hariç, sadece dist
  if (config.versions.escrow) {
    const escrowExclude = [...config.exclude];
    if (config.frontend) {
      escrowExclude.push(`${config.frontend.dir}/src/**`);
      escrowExclude.push(`${config.frontend.dir}/package.json`);
      escrowExclude.push(`${config.frontend.dir}/package-lock.json`);
      escrowExclude.push(`${config.frontend.dir}/bun.lock`);
      escrowExclude.push(`${config.frontend.dir}/bun.lockb`);
      escrowExclude.push(`${config.frontend.dir}/tsconfig*.json`);
      escrowExclude.push(`${config.frontend.dir}/vite.config.*`);
      escrowExclude.push(`${config.frontend.dir}/tailwind.config.*`);
      escrowExclude.push(`${config.frontend.dir}/postcss.config.*`);
      escrowExclude.push(`${config.frontend.dir}/.env*`);
    }

    const tempDir = await mkdtemp(path.join(os.tmpdir(), `${config.name}-escrow-`));

    try {
      await copyScriptFiles(resolvedScriptDir, tempDir, escrowExclude);

      const fxPath = path.join(tempDir, "fxmanifest.lua");
      await appendEscrowIgnore(fxPath, config.versions.escrow.escrowIgnore!);

      const zipPath = path.join(outputDir, `${config.name}-escrow.zip`);
      await createZip(tempDir, zipPath);
      result.escrowZip = zipPath;
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  // Open source: frontend src dahil
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
