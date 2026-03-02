import { readFile } from "fs/promises";
import path from "path";

export interface VersionConfig {
  assetId: number;
  escrowIgnore?: string[];
}

export interface FrontendConfig {
  dir: string;
  buildCommand?: string;
}

export interface UploadConfig {
  name: string;
  exclude: string[];
  frontend?: FrontendConfig;
  versions: {
    escrow?: VersionConfig;
    open?: VersionConfig;
  };
}

const CONFIG_FILENAME = "upload-config.json";

export async function loadConfig(scriptDir: string): Promise<UploadConfig> {
  const configPath = path.resolve(scriptDir, CONFIG_FILENAME);
  const raw = await readFile(configPath, "utf-8");
  const config: UploadConfig = JSON.parse(raw);

  if (!config.name) {
    throw new Error("Config'de 'name' alanı eksik.");
  }

  if (!config.versions || (!config.versions.escrow && !config.versions.open)) {
    throw new Error("Config'de en az bir versiyon (escrow veya open) tanımlanmalı.");
  }

  if (config.versions.escrow && config.versions.escrow.assetId == null) {
    throw new Error("Escrow versiyonunda 'assetId' eksik.");
  }

  if (config.versions.open && config.versions.open.assetId == null) {
    throw new Error("Open source versiyonunda 'assetId' eksik.");
  }

  if (config.versions.escrow && (!config.versions.escrow.escrowIgnore || config.versions.escrow.escrowIgnore.length === 0)) {
    throw new Error("Escrow versiyonunda 'escrowIgnore' listesi boş olamaz.");
  }

  return config;
}
