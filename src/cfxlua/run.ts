import path from "path";
import { mkdtemp, writeFile, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import chalk from "chalk";
import { ensureCfxLuaToolchain, testAssetsDir, toWslPath, type CfxLuaToolchain } from "./ensure-toolchain.js";
import { assertResourceDir, discoverTestFiles, loadTestConfig, resolveBatteryEnv } from "./discover.js";
import { runProcess } from "./spawn.js";
import type { RunSummary, TestResult } from "./types.js";

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
  summary: RunSummary;
};

const SUMMARY_RE = /9AM_TEST_SUMMARY passed=(\d+) failed=(\d+) total=(\d+)/;
const JSON_RE = /9AM_TEST_JSON_BEGIN\r?\n([\s\S]*?)\r?\n9AM_TEST_JSON_END/;

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

const ANSI_RE = /\[[0-9;]*m/g;

/**
 * The CfxLua VM decorates stdout: it prefixes every line with `[resource] ` and
 * appends an ANSI reset. Both land in the middle of our marker lines and inside
 * the JSON payload, so strip them before parsing anything.
 */
function normalizeOutput(output: string, resourceName: string): string {
  const prefix = `[${resourceName}] `;
  return output
    .split(/\r?\n/)
    .map((line) => {
      const plain = line.replace(ANSI_RE, "");
      return plain.startsWith(prefix) ? plain.slice(prefix.length) : plain;
    })
    .join("\n");
}

function parseSummary(output: string): { passed: number; failed: number; total: number } | null {
  const match = output.match(SUMMARY_RE);
  if (!match) return null;
  return { passed: Number(match[1]), failed: Number(match[2]), total: Number(match[3]) };
}

interface LuaPayload {
  passed: number;
  failed: number;
  total: number;
  tests: TestResult[];
}

function parsePayload(output: string): LuaPayload | null {
  const match = output.match(JSON_RE);
  if (!match) return null;
  try {
    return JSON.parse(match[1]) as LuaPayload;
  } catch {
    return null;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function spawnCfxLua(
  toolchain: CfxLuaToolchain,
  args: string[],
  env: Record<string, string>,
  cwd: string
) {
  if (toolchain.viaWsl) {
    const wslArgs = args.map(toWslPath);
    const exports = Object.entries(env)
      .map(([key, value]) => `${key}=${shellQuote(value)}`)
      .join(" ");
    const cmd = `${exports} ${shellQuote(toWslPath(toolchain.vm))} ${wslArgs.map(shellQuote).join(" ")}`;
    return runProcess("wsl", ["bash", "-lc", cmd], { cwd });
  }

  return runProcess(toolchain.vm, args, {
    cwd: path.dirname(toolchain.vm),
    env: {
      ...process.env,
      ...env,
      PATH: `${path.dirname(toolchain.vm)}${path.delimiter}${process.env.PATH ?? ""}`,
    },
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
        "Add files matching tests/**/*.spec.lua, or any *.test.lua, " +
        "or configure patterns in 9am-test.json."
    );
  }

  const toolchain = await ensureCfxLuaToolchain();
  const assets = testAssetsDir();
  const bootstrap = path.join(toolchain.runtimeDir, "bootstrap.lua");
  const runnerSource = await readFile(path.join(assets, "runner.lua"), "utf8");
  const tempDir = await mkdtemp(path.join(tmpdir(), "9am-build-test-"));
  const runnerPath = path.join(tempDir, "9am-test-runner.lua");
  const started = Date.now();

  try {
    await writeFile(runnerPath, runnerSource, "utf8");

    const battery = resolveBatteryEnv(config);
    const env: Record<string, string> = {
      CFXLUA_TIMEOUT: String(options.timeoutMs ?? 30_000),
      CFXLUA_RESOURCE_NAME: path.basename(resourceDir),
      NINEAM_TEST_FRAMEWORK: battery.framework,
      NINEAM_TEST_BATTERIES: battery.batteries,
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

    const runtimeLabel = `CfxLua ${toolchain.version}${toolchain.viaWsl ? " via WSL" : ""}`;
    if (options.verbose) {
      console.log(chalk.gray(`${runtimeLabel} → ${testFiles.length} file(s)`));
    }

    const { stdout, stderr, exitCode } = await spawnCfxLua(toolchain, args, env, resourceDir);
    const output = stdout + (stderr ? `\n${stderr}` : "");
    const normalized = normalizeOutput(output, path.basename(resourceDir));

    const payload = parsePayload(normalized);
    const counts = payload ?? parseSummary(normalized);

    const relativeFiles = testFiles.map((f) => toPosix(path.relative(resourceDir, f)));
    const summary: RunSummary = {
      resource: path.basename(resourceDir),
      root: resourceDir,
      files: relativeFiles,
      tests: payload?.tests ?? [],
      passed: counts?.passed ?? 0,
      failed: counts?.failed ?? (exitCode === 0 ? 0 : 1),
      total: counts?.total ?? testFiles.length,
      durationMs: Date.now() - started,
      runtime: runtimeLabel,
    };

    return {
      passed: summary.passed,
      failed: summary.failed,
      total: summary.total,
      exitCode: counts ? (summary.failed > 0 ? 1 : 0) : exitCode,
      output,
      summary,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
