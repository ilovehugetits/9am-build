import { glob } from "glob";

const IGNORED = [
  "**/node_modules/**",
  "web/**",
  ".build/**",
  "**/.git/**",
];

/**
 * Find test files under a resource root. Returns posix-relative paths, sorted,
 * so report output is stable across platforms and runs.
 */
export async function discoverTests(root: string): Promise<string[]> {
  const matches = await glob("**/*.test.lua", {
    cwd: root,
    nodir: true,
    dot: false,
    ignore: IGNORED,
    posix: true,
  });
  return matches.sort();
}
