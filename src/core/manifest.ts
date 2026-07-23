import { readFile } from "fs/promises";
import path from "path";

const VERSION_RE = /^\s*versions?[\s(]+['"]([^'"]*)['"]/m;

export function parseManifestVersion(content: string): string | null {
  const match = content.match(VERSION_RE);
  return match ? match[1] : null;
}

export async function readManifestVersion(repoDir: string): Promise<string | null> {
  try {
    const content = await readFile(path.join(repoDir, "fxmanifest.lua"), "utf-8");
    return parseManifestVersion(content);
  } catch {
    return null;
  }
}
