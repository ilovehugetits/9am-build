import chalk from "chalk";
import { runBrowser } from "../cfx/run-browser.js";

export async function loginCommand(): Promise<void> {
  console.log(chalk.bold("\n9am-build — Interactive Portal Login\n"));
  // Headed login for when the headless flow is blocked by the forum's
  // new-device email check; refreshes auth-state.json.
  const code = await runBrowser("login-interactive");
  if (code !== 0) {
    throw new Error(`Interactive login failed (browser runner exited ${code}).`);
  }
}
