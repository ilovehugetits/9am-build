import { readFile } from "fs/promises";
import path from "path";

export interface RepoEntry {
  name: string;
  githubUrl: string;
  branch?: string;
}

export interface ReposConfig {
  repos: RepoEntry[];
}

const CONFIG_PATH = path.resolve(import.meta.dirname, "../../repos.json");

export async function loadReposConfig(): Promise<ReposConfig> {
  const config: ReposConfig = JSON.parse(await readFile(CONFIG_PATH, "utf-8"));
  if (!config.repos || config.repos.length === 0) {
    throw new Error("repos.json: 'repos' list cannot be empty.");
  }
  return config;
}
