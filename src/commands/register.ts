import chalk from "chalk";
import { runBrowser } from "../cfx/run-browser.js";

export async function registerCommand(): Promise<void> {
  console.log(chalk.bold("\n9am-build — Passkey Registration\n"));
  // Browser work runs under Node (Bun cannot drive Playwright's pipe transport
  // on Windows); the runner opens a headed window and saves the credential.
  const code = await runBrowser("register");
  if (code !== 0) {
    throw new Error(`Passkey registration failed (browser runner exited ${code}).`);
  }
}
