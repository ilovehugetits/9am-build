import path from "path";

const RUNNER = path.resolve(import.meta.dirname, "browser-runner.ts");

// The browser runner must execute under Node (Bun cannot drive Playwright's
// pipe transport on Windows). Node + tsx are present locally and in the Docker
// image. NODE_BIN allows overriding the node binary if it isn't on PATH.
const NODE_BIN = process.env.NODE_BIN || "node";

export type BrowserMode = "login" | "register";

/** Spawn the Node-side browser runner, inheriting stdio (so interactive
 *  registration and progress logs reach the user). Resolves to the exit code. */
export async function runBrowser(mode: BrowserMode): Promise<number> {
  const proc = Bun.spawn([NODE_BIN, "--import", "tsx", RUNNER, mode], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await proc.exited;
}
