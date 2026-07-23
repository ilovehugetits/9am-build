import path from "path";
import chalk from "chalk";
import { runResourceTests } from "../cfxlua/run.js";

export async function testCommand(resourcePath: string, options?: { verbose?: boolean }): Promise<void> {
  const resolved = path.resolve(resourcePath);
  console.log(chalk.bold(`\n9am-build — CfxLua Tests\n`));
  console.log(chalk.gray(`Resource: ${resolved}\n`));

  const result = await runResourceTests({
    resourceDir: resolved,
    verbose: options?.verbose ?? true,
  });

  process.stdout.write(result.output);

  if (!result.output.endsWith("\n")) console.log("");

  if (result.exitCode === 0) {
    console.log(chalk.bold.green(`\n${result.passed}/${result.total} passed\n`));
    return;
  }

  console.log(chalk.bold.red(`\n${result.failed}/${result.total} failed (${result.passed} passed)\n`));
  process.exit(1);
}
