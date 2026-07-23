import path from "path";
import chalk from "chalk";
import { runResourceTests } from "../cfxlua/run.js";
import { renderJson, renderText } from "../cfxlua/report.js";

export interface TestOptions {
  dir: string;
  json?: boolean;
  strict?: boolean;
  verbose?: boolean;
}

export async function testCommand(options: TestOptions): Promise<number> {
  const resolved = path.resolve(options.dir);

  let result;
  try {
    result = await runResourceTests({
      resourceDir: resolved,
      verbose: options.verbose ?? !options.json,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // "No tests found" is a soft outcome unless --strict: a resource that has
    // not adopted testing yet should not fail someone's pipeline.
    if (message.startsWith("No CfxLua tests found")) {
      if (options.json) {
        console.log(
          JSON.stringify(
            {
              resource: path.basename(resolved),
              root: resolved,
              files: [],
              tests: [],
              passed: 0,
              failed: 0,
              total: 0,
              durationMs: 0,
              runtime: "none",
            },
            null,
            2
          )
        );
      } else {
        console.log(chalk.yellow(message));
      }
      return options.strict ? 1 : 0;
    }

    console.error(chalk.red(message));
    return 1;
  }

  console.log(options.json ? renderJson(result.summary) : renderText(result.summary));
  return result.exitCode;
}
