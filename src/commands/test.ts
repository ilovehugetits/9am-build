import path from "path";
import { readFileSync } from "fs";
import chalk from "chalk";
import { discoverTests } from "../lua/discover.js";
import { createFactory, runTestFile } from "../lua/runtime.js";
import { renderJson, renderText } from "../lua/report.js";
import type { RunSummary, TestResult } from "../lua/types.js";

export interface TestOptions {
  dir: string;
  json: boolean;
  strict: boolean;
}

/** Resource name from fxmanifest/folder, used only for the report header. */
function resolveResourceName(root: string): string {
  try {
    const config = JSON.parse(readFileSync(path.join(root, "upload-config.json"), "utf-8"));
    if (typeof config.name === "string" && config.name) return config.name;
  } catch {
    // Not every resource has an upload-config.json; the folder name is fine.
  }
  return path.basename(root);
}

export async function testCommand(options: TestOptions): Promise<number> {
  const root = path.resolve(options.dir);
  const resource = resolveResourceName(root);
  const files = await discoverTests(root);

  if (files.length === 0) {
    if (options.json) {
      const empty: RunSummary = {
        resource, root, files: [], tests: [], durationMs: 0, passed: 0, failed: 0,
      };
      console.log(renderJson(empty));
    } else {
      console.log(chalk.yellow(`No *.test.lua files found under ${root}`));
      console.log(chalk.gray("Create one, e.g. server/purchase.test.lua, then run this again."));
    }
    return options.strict ? 1 : 0;
  }

  const started = Date.now();
  const factory = createFactory();
  const tests: TestResult[] = [];

  for (const file of files) {
    try {
      tests.push(...(await runTestFile(factory, file, { root, resourceName: resource })));
    } catch (err) {
      // A file that fails to compile or throws while loading produces no test
      // results at all, so synthesize one so it cannot pass silently.
      tests.push({
        file,
        name: "<file failed to load>",
        line: 0,
        status: "error",
        durationMs: 0,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const failed = tests.filter((t) => t.status !== "pass").length;
  const summary: RunSummary = {
    resource,
    root,
    files,
    tests,
    durationMs: Date.now() - started,
    passed: tests.length - failed,
    failed,
  };

  console.log(options.json ? renderJson(summary) : renderText(summary));
  return failed > 0 ? 1 : 0;
}
