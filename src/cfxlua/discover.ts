import { glob } from "glob";
import path from "path";
import { access, readFile } from "fs/promises";

const DEFAULT_PATTERNS = [
  "tests/**/*.spec.lua",
  "tests/**/*.test.lua",
  "test/**/*.spec.lua",
  "test/**/*.test.lua",
  // Co-located specs, e.g. server/purchase.test.lua next to server/purchase.lua.
  "**/*.test.lua",
];

const DEFAULT_EXCLUDE = [
  "**/node_modules/**",
  "**/.build/**",
  // A resource's web/ folder is a JS project; its *.test.* files are not CfxLua.
  "web/**",
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
    return JSON.parse(await readFile(configPath, "utf8")) as TestConfig;
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
  const exclude = config?.exclude ?? DEFAULT_EXCLUDE;

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
