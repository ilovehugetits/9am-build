import { readFile } from "fs/promises";
import path from "path";

export interface VersionConfig {
  assetId: number;
  escrowIgnore?: string[];
}

export interface FrontendConfig {
  dir: string;
  buildCommand?: string;
  buildOutput?: string;
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
    throw new Error("Config is missing 'name' field.");
  }

  if (!config.versions || (!config.versions.escrow && !config.versions.open)) {
    throw new Error("Config must define at least one version (escrow or open).");
  }

  if (config.versions.escrow && config.versions.escrow.assetId == null) {
    throw new Error("Escrow version is missing 'assetId'.");
  }

  if (config.versions.open && config.versions.open.assetId == null) {
    throw new Error("Open source version is missing 'assetId'.");
  }

  if (config.versions.escrow && (!config.versions.escrow.escrowIgnore || config.versions.escrow.escrowIgnore.length === 0)) {
    throw new Error("Escrow version 'escrowIgnore' list cannot be empty.");
  }

  return config;
}
