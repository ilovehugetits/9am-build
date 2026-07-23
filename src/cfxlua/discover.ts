import { glob } from "glob";
import path from "path";
import { access } from "fs/promises";

const DEFAULT_PATTERNS = [
  "tests/**/*.spec.lua",
  "tests/**/*.test.lua",
  "test/**/*.spec.lua",
  "test/**/*.test.lua",
];

export type TestConfig = {
  patterns?: string[];
  include?: string[];
  exclude?: string[];
};

export async function loadTestConfig(resourceDir: string): Promise<TestConfig | null> {
  const configPath = path.join(resourceDir, "9am-test.json");
  try {
    await access(configPath);
    const raw = await Bun.file(configPath).json();
    return raw as TestConfig;
  } catch {
    return null;
  }
}

export async function discoverTestFiles(
  resourceDir: string,
  config?: TestConfig | null
): Promise<string[]> {
  const resolved = path.resolve(resourceDir);
  const patterns = config?.patterns?.length ? config.patterns : DEFAULT_PATTERNS;
  const exclude = config?.exclude ?? ["**/node_modules/**", "**/.build/**"];

  const found = new Set<string>();

  for (const pattern of patterns) {
    const matches = await glob(pattern, {
      cwd: resolved,
      absolute: true,
      nodir: true,
      ignore: exclude,
    });
    for (const match of matches) found.add(match);
  }

  if (config?.include?.length) {
    for (const entry of config.include) {
      const abs = path.isAbsolute(entry) ? entry : path.join(resolved, entry);
      found.add(abs);
    }
  }

  return [...found].sort();
}

export async function assertResourceDir(resourceDir: string): Promise<void> {
  const manifest = path.join(resourceDir, "fxmanifest.lua");
  try {
    await access(manifest);
  } catch {
    throw new Error(
      `Not a FiveM resource: ${resourceDir}\nExpected fxmanifest.lua in the resource root.`
    );
  }
}
