import { access, chmod } from "fs/promises";
import chalk from "chalk";
import { chromium } from "playwright";
import { setupVirtualAuthenticator, getRegisteredCredentials, saveCredential } from "../cfx/passkey.js";
import { AUTH_STATE_FILE } from "../cfx/session.js";

const FORUM_SECURITY_URL = "https://forum.cfx.re/my/preferences/security";

export async function registerCommand(): Promise<void> {
  console.log(chalk.bold("\n9am-build — Passkey Registration\n"));

  let hasState = false;
  try {
    await access(AUTH_STATE_FILE);
    hasState = true;
  } catch {
    /* no saved state */
  }

  const browser = await chromium.launch({ headless: false, args: ["--disable-blink-features=AutomationControlled"] });
  const context = await browser.newContext(hasState ? { storageState: AUTH_STATE_FILE } : {});
  const page = await context.newPage();

  const { authenticatorId, cdp } = await setupVirtualAuthenticator(page);

  await page.goto(FORUM_SECURITY_URL, { waitUntil: "domcontentloaded" });

  console.log(chalk.bold.cyan("\n════════════════════════════════════════"));
  console.log(chalk.bold.cyan("  In the browser window:"));
  console.log(chalk.bold.cyan("  1. Log in to the forum if prompted"));
  console.log(chalk.bold.cyan("  2. Click 'Add Passkey' (confirm access with your password)"));
  console.log(chalk.bold.cyan("  3. Name the passkey and confirm"));
  console.log(chalk.bold.cyan("  4. Return here and press Enter"));
  console.log(chalk.bold.cyan("════════════════════════════════════════\n"));

  await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));

  const credentials = await getRegisteredCredentials(cdp, authenticatorId);
  if (credentials.length === 0) {
    console.log(chalk.red("No passkey credential found — registration may have failed."));
    await browser.close();
    process.exit(1);
  }

  await saveCredential(credentials[credentials.length - 1]);
  await context.storageState({ path: AUTH_STATE_FILE });
  await chmod(AUTH_STATE_FILE, 0o600).catch(() => {}); // portal jwt + forum cookies — owner-only
  console.log(chalk.green(`\nPasskey saved (rpId: ${credentials[credentials.length - 1].rpId}).`));
  console.log(chalk.gray("auth-state.json refreshed.\n"));

  await browser.close();
}
