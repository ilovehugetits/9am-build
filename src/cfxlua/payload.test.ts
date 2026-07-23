import { test, expect, describe } from "bun:test";
import path from "path";
import os from "os";
import { existsSync } from "fs";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { runResourceTests } from "./run.js";

const MANIFEST = "fx_version 'cerulean'\ngame 'gta5'\nversion '1.0.0'\n";

async function makeResource(files: Record<string, string>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "9am-payload-"));
  await writeFile(path.join(dir, "fxmanifest.lua"), MANIFEST, "utf8");
  for (const [rel, body] of Object.entries(files)) {
    const target = path.join(dir, rel);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body, "utf8");
  }
  return {
    dir,
    cleanup: async () => {
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          await rm(dir, { recursive: true, force: true });
          return;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    },
  };
}

function toolchainAvailable(): boolean {
  if (process.env.NINEAM_CFXLUA_E2E === "1") return true;
  if (process.env.CFXLUA_VM && process.env.CFXLUA_RUNTIME) return true;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  const cache = process.env.NINEAM_CFXLUA_CACHE ?? path.join(home, ".9am-build", "cfxlua");
  return existsSync(cache);
}

const e2e = toolchainAvailable() ? test : test.skip;
const E2E_TIMEOUT = 300_000;

const RESOURCE = {
  "server/pricing.lua": `local M = {}

function M.withTax(price, rate)
  return price + (price * rate)
end

return M
`,
  "server/pricing.test.lua": `local pricing = require('server.pricing')

describe('withTax', function()
  it('adds the tax', function()
    expect(pricing.withTax(100, 0.2)).to.equal(120.0)
  end)

  it('mismatches on purpose', function()
    expect(pricing.withTax(100, 0.2)).to.equal(999)
  end)

  it('blows up inside resource code', function()
    expect(pricing.withTax(nil, 0.2)).to.equal(0)
  end)
end)
`,
};

describe("structured payload", () => {
  e2e(
    "returns one entry per test, anchored at the it() line",
    async () => {
      const { dir, cleanup } = await makeResource(RESOURCE);
      try {
        const { summary } = await runResourceTests({ resourceDir: dir, verbose: false });
        expect(summary.tests).toHaveLength(3);

        const passing = summary.tests.find((t) => t.test === "adds the tax");
        expect(passing?.status).toBe("pass");
        expect(passing?.file).toBe("server/pricing.test.lua");
        expect(passing?.line).toBe(4);
      } finally {
        await cleanup();
      }
    },
    E2E_TIMEOUT
  );

  e2e(
    "captures matcher, expected and actual for a failed assertion",
    async () => {
      const { dir, cleanup } = await makeResource(RESOURCE);
      try {
        const { summary } = await runResourceTests({ resourceDir: dir, verbose: false });
        const failed = summary.tests.find((t) => t.test === "mismatches on purpose");
        expect(failed?.status).toBe("fail");
        expect(failed?.matcher).toBe("equal");
        expect(failed?.expected).toBe("999");
        expect(failed?.actual).toBe("120.0");
      } finally {
        await cleanup();
      }
    },
    E2E_TIMEOUT
  );

  e2e(
    "resolves required resource modules to relative paths in the traceback",
    async () => {
      const { dir, cleanup } = await makeResource(RESOURCE);
      try {
        const { summary } = await runResourceTests({ resourceDir: dir, verbose: false });
        const errored = summary.tests.find((t) => t.test === "blows up inside resource code");
        expect(errored?.status).toBe("error");
        // The whole point of the custom searcher: an absolute path would be
        // truncated by Lua to "...urce/server\\pricing.lua" and stop being a
        // usable anchor.
        expect(errored?.traceback?.[0]).toStartWith("server/pricing.lua:4:");
        expect(errored?.message).toContain("server/pricing.lua:4:");
      } finally {
        await cleanup();
      }
    },
    E2E_TIMEOUT
  );

  e2e(
    "strips CfxLua bootstrap and scheduler frames from the traceback",
    async () => {
      const { dir, cleanup } = await makeResource(RESOURCE);
      try {
        const { summary } = await runResourceTests({ resourceDir: dir, verbose: false });
        for (const result of summary.tests) {
          const traceback = result.traceback?.join("\n") ?? "";
          expect(traceback).not.toContain("bootstrap.lua");
          expect(traceback).not.toContain("scheduler.lua");
          expect(traceback).not.toContain("framework.lua");
        }
      } finally {
        await cleanup();
      }
    },
    E2E_TIMEOUT
  );

  e2e(
    "discovers co-located *.test.lua, not just tests/**/*.spec.lua",
    async () => {
      const { dir, cleanup } = await makeResource(RESOURCE);
      try {
        const { summary } = await runResourceTests({ resourceDir: dir, verbose: false });
        expect(summary.files).toEqual(["server/pricing.test.lua"]);
      } finally {
        await cleanup();
      }
    },
    E2E_TIMEOUT
  );
});
