import path from "path";
import { mkdir, rm } from "fs/promises";
import chalk from "chalk";
import { loadConfig } from "./config.js";
import { buildVersions } from "./build.js";
import { getAuthenticatedContext } from "./auth.js";
import { uploadAsset } from "./upload.js";

interface DeployOptions {
  buildOnly?: boolean;
}

export async function deployScript(scriptDir: string, options: DeployOptions = {}): Promise<void> {
  const resolvedDir = path.resolve(scriptDir);
  console.log(chalk.bold(`\n9am-build — ${resolvedDir}\n`));

  // 1. Config oku
  console.log(chalk.gray("Config okunuyor..."));
  const config = await loadConfig(resolvedDir);
  console.log(chalk.green(`Script: ${config.name}`));

  const versionList = [
    config.versions.escrow && "escrow",
    config.versions.open && "open",
  ].filter(Boolean);
  console.log(chalk.green(`Versiyonlar: ${versionList.join(", ")}\n`));

  // 2. Zip'ler için output klasörü
  const outputDir = path.join(resolvedDir, ".build");
  await mkdir(outputDir, { recursive: true });

  // 3. Build
  console.log(chalk.gray("Zip dosyaları oluşturuluyor..."));
  const zips = await buildVersions(resolvedDir, config, outputDir);

  if (zips.escrowZip) {
    console.log(chalk.green(`Escrow zip: ${zips.escrowZip}`));
  }
  if (zips.openZip) {
    console.log(chalk.green(`Open source zip: ${zips.openZip}`));
  }
  console.log();

  if (options.buildOnly) {
    console.log(chalk.bold.green("Zip'ler hazır! (.build/ klasöründe)\n"));
    return;
  }

  // 4. Auth
  console.log(chalk.gray("Portal auth kontrol ediliyor..."));
  const context = await getAuthenticatedContext();

  // 5. Upload
  try {
    if (zips.escrowZip && config.versions.escrow) {
      await uploadAsset(context, config.versions.escrow.assetId, zips.escrowZip, "ESCROW");
    }

    if (zips.openZip && config.versions.open) {
      await uploadAsset(context, config.versions.open.assetId, zips.openZip, "OPEN");
    }

    console.log(chalk.bold.green("Tüm versiyonlar başarıyla yüklendi!"));
  } finally {
    await context.close();
  }

  // 6. Temizlik
  await rm(outputDir, { recursive: true, force: true });
  console.log(chalk.gray("Geçici dosyalar temizlendi.\n"));
}
