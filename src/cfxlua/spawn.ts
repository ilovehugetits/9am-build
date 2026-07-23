import { spawn, type SpawnOptions } from "child_process";

export interface CapturedProcess {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn a child process and capture its output.
 *
 * Uses node:child_process rather than Bun.spawn so the published CLI runs on
 * plain Node. The package previously required Bun via a `#!/usr/bin/env bun`
 * shebang, which meant `npx 9am-build test` only worked on machines that
 * happened to have Bun installed.
 */
export function runProcess(
  command: string,
  args: string[],
  options: SpawnOptions = {}
): Promise<CapturedProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));

    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
}
