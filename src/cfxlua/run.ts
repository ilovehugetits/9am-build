import path from "path";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import chalk from "chalk";
import { ensureCfxLuaToolchain, testAssetsDir, toWslPath, type CfxLuaToolchain } from "./ensure-toolchain.js";
import { assertResourceDir, discoverTestFiles, loadTestConfig } from "./discover.js";

export type RunTestsOptions = {
  resourceDir: string;
  timeoutMs?: number;
  verbose?: boolean;
};

export type RunTestsResult = {
  passed: number;
  failed: number;
  total: number;
  exitCode: number;
  output: string;
};

const SUMMARY_RE = /9AM_TEST_SUMMARY passed=(\d+) failed=(\d+) total=(\d+)/;

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function parseSummary(output: string): { passed: number; failed: number; total: number } | null {
  const match = output.match(SUMMARY_RE);
  if (!match) return null;
  return {
    passed: Number(match[1]),
    failed: Number(match[2]),
    total: Number(match[3]),
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function spawnCfxLua(
  toolchain: CfxLuaToolchain,
  args: string[],
  env: Record<string, string | undefined>,
  cwd: string
) {
  if (toolchain.viaWsl) {
    const wslArgs = args.map(toWslPath);
    const wslEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined) wslEnv[key] = value;
    }
    const exports = Object.entries(wslEnv)
      .map(([key, value]) => `${key}=${shellQuote(value)}`)
      .join(" ");
    const cmd = `${exports} ${shellQuote(toWslPath(toolchain.vm))} ${wslArgs.map(shellQuote).join(" ")}`;
    return Bun.spawn(["wsl", "bash", "-lc", cmd], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  return Bun.spawn([toolchain.vm, ...args], {
    cwd: path.dirname(toolchain.vm),
    env: {
      ...process.env,
      ...env,
      PATH: `${path.dirname(toolchain.vm)}${path.delimiter}${process.env.PATH ?? ""}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

export async function runResourceTests(options: RunTestsOptions): Promise<RunTestsResult> {
  const resourceDir = path.resolve(options.resourceDir);
  await assertResourceDir(resourceDir);

  const config = await loadTestConfig(resourceDir);
  const testFiles = await discoverTestFiles(resourceDir, config);
  if (testFiles.length === 0) {
    throw new Error(
      `No CfxLua tests found in ${resourceDir}.\n` +
        "Add files matching tests/**/*.spec.lua or configure patterns in 9am-test.json."
    );
  }

  const toolchain = await ensureCfxLuaToolchain();
  const assets = testAssetsDir();
  const bootstrap = path.join(toolchain.runtimeDir, "bootstrap.lua");
  const runnerSource = await Bun.file(path.join(assets, "runner.lua")).text();
  const tempDir = await mkdtemp(path.join(tmpdir(), "9am-build-test-"));
  const runnerPath = path.join(tempDir, "9am-test-runner.lua");

  try {
    await writeFile(runnerPath, runnerSource, "utf8");

    const env: Record<string, string> = {
      CFXLUA_TIMEOUT: String(options.timeoutMs ?? 30_000),
      CFXLUA_RESOURCE_NAME: path.basename(resourceDir),
      NINEAM_TEST_ASSETS: toolchain.viaWsl ? toWslPath(assets) : toPosix(assets),
      __cfx_bootstrapPath: toolchain.viaWsl
        ? toWslPath(toolchain.runtimeDir)
        : toPosix(toolchain.runtimeDir),
    };

    const args = [
      toPosix(bootstrap),
      toPosix(runnerPath),
      toPosix(resourceDir),
      ...testFiles.map(toPosix),
    ];

    if (options.verbose) {
      const mode = toolchain.viaWsl ? "via WSL" : "native";
      console.log(chalk.gray(`CfxLua ${toolchain.version} (${mode}) → ${testFiles.length} file(s)`));
      for (const file of testFiles) console.log(chalk.gray(`  ${file}`));
      console.log("");
    }

    const proc = await spawnCfxLua(toolchain, args, env, resourceDir);

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    const output = stdout + (stderr ? `\n${stderr}` : "");
    const summary = parseSummary(output);

    return {
      passed: summary?.passed ?? 0,
      failed: summary?.failed ?? (exitCode === 0 ? 0 : 1),
      total: summary?.total ?? testFiles.length,
      exitCode: summary ? (summary.failed > 0 ? 1 : 0) : exitCode,
      output,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
