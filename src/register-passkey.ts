import puppeteer from "puppeteer";
import chalk from "chalk";
import { getAuthenticatedContext } from "./auth.js";
import { setupVirtualAuthenticator, getRegisteredCredentials, saveCredential } from "./passkey.js";

const FORUM_SECURITY_URL = "https://forum.cfx.re/u/me/preferences/security";

export async function registerPasskey(): Promise<void> {
  console.log(chalk.bold("\n9am-build — Passkey Registration\n"));

  // 1. Get auth context (via cookies or login)
  console.log(chalk.gray("Logging into forum..."));
  const browser = await getAuthenticatedContext();
  const page = (await browser.pages())[0];

  // 2. Create virtual authenticator (without loading credential)
  const authenticatorId = await setupVirtualAuthenticator(page);

  // 3. Navigate to forum security settings
  await page.goto(FORUM_SECURITY_URL, { waitUntil: "networkidle2" });
  await new Promise((r) => setTimeout(r, 2000));

  console.log(chalk.bold.cyan("\n════════════════════════════════════════"));
  console.log(chalk.bold.cyan("  In the browser:"));
  console.log(chalk.bold.cyan("  1. Click 'Add passkey' button"));
  console.log(chalk.bold.cyan("  2. Enter a passkey name and confirm"));
  console.log(chalk.bold.cyan("  3. Come back here when done"));
  console.log(chalk.bold.cyan("════════════════════════════════════════\n"));

  // 4. Wait for user to add passkey
  console.log(chalk.gray("Waiting for passkey registration... (press Enter to continue)"));
  await new Promise<void>((resolve) => {
    process.stdin.once("data", () => resolve());
  });

  // 5. Extract and save credential
  const credentials = await getRegisteredCredentials(page, authenticatorId);

  if (credentials.length === 0) {
    console.log(chalk.red("No passkey credentials found. Registration may have failed."));
    await browser.close();
    process.exit(1);
  }

  const credential = credentials[credentials.length - 1];
  await saveCredential(credential);

  console.log(chalk.green(`\nPasskey registered successfully! (rpId: ${credential.rpId})`));
  console.log(chalk.gray("Credential saved to passkey-credential.json.\n"));

  await browser.close();
}
