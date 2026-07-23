import { test, expect, describe } from "bun:test";
import path from "path";
import os from "os";
import { existsSync } from "fs";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { assertResourceDir, discoverTestFiles, loadTestConfig } from "./discover.js";
import { toWslPath, testAssetsDir, packageRoot } from "./ensure-toolchain.js";
import { runResourceTests } from "./run.js";

const fixturesDir = path.join(import.meta.dir, "..", "..", "fixtures", "sample-resource");

const MANIFEST = "fx_version 'cerulean'\ngame 'gta5'\nversion '1.0.0'\n";

/**
 * Creates a throwaway FiveM resource. Returns the directory and a cleanup fn.
 */
async function makeResource(specs: Record<string, string>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "9am-smoke-"));
  await writeFile(path.join(dir, "fxmanifest.lua"), MANIFEST, "utf8");
  for (const [rel, body] of Object.entries(specs)) {
    const target = path.join(dir, rel);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body, "utf8");
  }
  return { dir, cleanup: () => removeWhenUnlocked(dir) };
}

/**
 * The VM is spawned with the resource as its working directory, so on Windows
 * the handle can outlive the process exit briefly. Retry rather than failing
 * the assertion we actually care about.
 */
async function removeWhenUnlocked(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/**
 * The end-to-end tests spawn the real CfxLua VM, which is downloaded on first
 * use. They run automatically once the toolchain is cached (or pointed at via
 * CFXLUA_VM/CFXLUA_RUNTIME) and can be forced in CI with NINEAM_CFXLUA_E2E=1.
 */
function toolchainAvailable(): boolean {
  if (process.env.NINEAM_CFXLUA_E2E === "1") return true;
  if (process.env.CFXLUA_VM && process.env.CFXLUA_RUNTIME) return true;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  const cache = process.env.NINEAM_CFXLUA_CACHE ?? path.join(home, ".9am-build", "cfxlua");
  return existsSync(cache);
}

const e2e = toolchainAvailable() ? test : test.skip;
const E2E_TIMEOUT = 300_000;

describe("resource validation", () => {
  test("accepts a directory containing fxmanifest.lua", async () => {
    await assertResourceDir(fixturesDir);
  });

  test("rejects a directory without fxmanifest.lua", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "9am-smoke-bare-"));
    try {
      await expect(assertResourceDir(dir)).rejects.toThrow(/Not a FiveM resource/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("test discovery", () => {
  test("finds every spec file in the sample fixture", async () => {
    const files = await discoverTestFiles(fixturesDir);
    const names = files.map((f) => path.basename(f)).sort();
    expect(names).toEqual(["framework.spec.lua", "pricing.spec.lua"]);
  });

  test("reads 9am-test.json when present", async () => {
    const config = await loadTestConfig(fixturesDir);
    expect(config?.patterns).toEqual(["tests/**/*.spec.lua"]);
  });

  test("returns null when 9am-test.json is absent", async () => {
    expect(await loadTestConfig(import.meta.dir)).toBeNull();
  });

  test("honours configured patterns, include and exclude", async () => {
    const { dir, cleanup } = await makeResource({
      "tests/a.spec.lua": "",
      "tests/b.test.lua": "",
      "tests/skipped/c.spec.lua": "",
      "extra/manual.spec.lua": "",
    });
    try {
      const files = await discoverTestFiles(dir, {
        patterns: ["tests/**/*.spec.lua"],
        include: ["extra/manual.spec.lua"],
        exclude: ["**/skipped/**"],
      });
      const names = files.map((f) => path.basename(f)).sort();
      expect(names).toEqual(["a.spec.lua", "manual.spec.lua"]);
    } finally {
      await cleanup();
    }
  });

  test("deduplicates a file matched by both a pattern and include", async () => {
    const { dir, cleanup } = await makeResource({ "tests/a.spec.lua": "" });
    try {
      const files = await discoverTestFiles(dir, {
        patterns: ["tests/**/*.spec.lua"],
        include: ["tests/a.spec.lua"],
      });
      expect(files.length).toBe(1);
    } finally {
      await cleanup();
    }
  });
});

describe("packaging paths", () => {
  test("test assets ship alongside the source", () => {
    expect(existsSync(path.join(testAssetsDir(), "framework.lua"))).toBe(true);
    expect(existsSync(path.join(testAssetsDir(), "helpers.lua"))).toBe(true);
    expect(existsSync(path.join(testAssetsDir(), "runner.lua"))).toBe(true);
  });

  test("package root resolves to the directory holding package.json", () => {
    expect(existsSync(path.join(packageRoot(), "package.json"))).toBe(true);
  });
});

describe.if(process.platform === "win32")("WSL path translation", () => {
  test("maps a drive letter onto /mnt", () => {
    expect(toWslPath("C:\\Users\\dev\\resource")).toBe("/mnt/c/Users/dev/resource");
  });

  test("lowercases the drive letter and normalises separators", () => {
    expect(toWslPath("D:/Games/txData")).toBe("/mnt/d/Games/txData");
  });

  test("maps a bare drive root", () => {
    expect(toWslPath("C:\\")).toBe("/mnt/c");
  });
});

describe("end-to-end runs", () => {
  e2e(
    "runs the sample fixture and reports every test as passing",
    async () => {
      const result = await runResourceTests({ resourceDir: fixturesDir, verbose: false });
      expect(result.exitCode).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.total).toBeGreaterThan(0);
      expect(result.passed).toBe(result.total);
      expect(result.output).toContain("9AM_TEST_SUMMARY");
    },
    E2E_TIMEOUT
  );

  e2e(
    "reports a non-zero exit code and per-test counts when a spec fails",
    async () => {
      const { dir, cleanup } = await makeResource({
        "tests/mixed.spec.lua": `
describe('mixed', function()
  it('passes', function() expect(1).to.equal(1) end)
  it('fails', function() expect(1).to.equal(2) end)
end)
`,
      });
      try {
        const result = await runResourceTests({ resourceDir: dir, verbose: false });
        expect(result.exitCode).toBe(1);
        expect(result.passed).toBe(1);
        expect(result.failed).toBe(1);
        expect(result.total).toBe(2);
      } finally {
        await cleanup();
      }
    },
    E2E_TIMEOUT
  );

  e2e(
    "runs afterEach even when the test body fails, so cleanup does not leak",
    async () => {
      // Regression guard: afterEach used to be skipped for failing tests, which
      // left mocked globals in place and cascaded failures into later tests.
      const { dir, cleanup } = await makeResource({
        "tests/cleanup.spec.lua": `
local cleanupRuns = 0

describe('cleanup', function()
  afterEach(function() cleanupRuns = cleanupRuns + 1 end)

  it('fails on purpose', function() expect(1).to.equal(2) end)

  it('observed afterEach from the failing test', function()
    expect(cleanupRuns).to.equal(1)
  end)
end)
`,
      });
      try {
        const result = await runResourceTests({ resourceDir: dir, verbose: false });
        expect(result.failed).toBe(1);
        expect(result.passed).toBe(1);
      } finally {
        await cleanup();
      }
    },
    E2E_TIMEOUT
  );

  e2e(
    "surfaces a Lua syntax error instead of reporting a silent pass",
    async () => {
      const { dir, cleanup } = await makeResource({
        "tests/broken.spec.lua": "describe('broken', function(\n",
      });
      try {
        const result = await runResourceTests({ resourceDir: dir, verbose: false });
        expect(result.exitCode).toBe(1);
        expect(result.failed).toBeGreaterThan(0);
      } finally {
        await cleanup();
      }
    },
    E2E_TIMEOUT
  );

  test("throws a helpful error when a resource has no test files", async () => {
    const { dir, cleanup } = await makeResource({});
    try {
      await expect(runResourceTests({ resourceDir: dir, verbose: false })).rejects.toThrow(
        /No CfxLua tests found/
      );
    } finally {
      await cleanup();
    }
  });
});
