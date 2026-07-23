#!/usr/bin/env node
import { createRequire } from "module";
import chalk from "chalk";
import { testCommand } from "./commands/test.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

function usage(): void {
  console.log(`9am-build ${version}

Usage:
  9am-build test [dir]     Run *.test.lua files against a simulated FiveM environment

Options:
  --json                   Emit results as a single JSON document
  --strict                 Exit non-zero when no test files are found
  -h, --help               Show this message
  -v, --version            Show the version
`);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);

  if (argv.includes("-h") || argv.includes("--help")) {
    usage();
    return 0;
  }
  if (argv.includes("-v") || argv.includes("--version")) {
    console.log(version);
    return 0;
  }

  const [command, ...rest] = argv;
  if (command !== "test") {
    if (command) console.error(chalk.red(`Unknown command: ${command}`));
    usage();
    return 1;
  }

  const positional = rest.filter((arg) => !arg.startsWith("-"));
  return testCommand({
    dir: positional[0] ?? process.cwd(),
    json: rest.includes("--json"),
    strict: rest.includes("--strict"),
  });
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(chalk.red(err instanceof Error ? err.stack ?? err.message : String(err)));
    process.exit(1);
  });
