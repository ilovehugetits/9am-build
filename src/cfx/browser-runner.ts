// Runs under Node (not Bun): Bun cannot drive Playwright's pipe transport on
// Windows, so all browser work is delegated to this standalone entry, launched
// as `node --import tsx browser-runner.ts <mode>`. It reads/writes the same
// auth-state.json / passkey-credential.json the Bun side uses.
import path from "path";
import { chmod, readFile, writeFile } from "fs/promises";
import { chromium } from "playwright";
import { loginViaSSO, loginWithPasskey } from "./login.js";
import {
  loadCredential, saveCredential, setupVirtualAuthenticator, getRegisteredCredentials,
} from "./passkey.js";
import { toStorageState, type StorageState } from "./storage-state.js";

const AUTH_STATE_FILE = path.resolve(import.meta.dirname, "../../auth-state.json");
const FORUM_SECURITY_URL = "https://forum.cfx.re/my/preferences/security";

// Sandbox stays ON by default; containers running as root opt out via env.
function launchArgs(): string[] {
  const args = ["--disable-blink-features=AutomationControlled"];
  if (process.env.CHROMIUM_NO_SANDBOX === "1") {
    args.push("--no-sandbox", "--disable-setuid-sandbox");
  }
  return args;
}

async function readState(): Promise<StorageState | null> {
  try {
    return toStorageState(JSON.parse(await readFile(AUTH_STATE_FILE, "utf-8")));
  } catch {
    return null;
  }
}

async function writeState(state: StorageState): Promise<void> {
  await writeFile(AUTH_STATE_FILE, JSON.stringify(state), { encoding: "utf-8", mode: 0o600 });
  await chmod(AUTH_STATE_FILE, 0o600).catch(() => {});
}

/** Tier 2/3 login: refresh auth-state.json via SSO or passkey. */
async function runLogin(): Promise<void> {
  const state = await readState();
  const browser = await chromium.launch({ headless: true, args: launchArgs() });
  try {
    const context = await browser.newContext(state ? { storageState: state } : {});
    const page = await context.newPage();

    let ok = await loginViaSSO(page);
    if (!ok) {
      const credential = await loadCredential();
      if (!credential) throw new Error("No passkey credential. Run 'bun run register-passkey' first.");
      console.log("SSO needs re-auth — logging in with passkey...");
      ok = await loginWithPasskey(page, credential);
    }
    if (!ok) throw new Error("Portal login failed (SSO + passkey both failed).");

    await writeState((await context.storageState()) as StorageState);
    console.log("Session refreshed.");
  } finally {
    await browser.close();
  }
}

/** Headed, interactive passkey registration. */
async function runRegister(): Promise<void> {
  const state = await readState();
  const browser = await chromium.launch({ headless: false, args: launchArgs() });
  const context = await browser.newContext(state ? { storageState: state } : {});
  const page = await context.newPage();

  const { authenticatorId, cdp } = await setupVirtualAuthenticator(page);
  await page.goto(FORUM_SECURITY_URL, { waitUntil: "domcontentloaded" });

  console.log("\n════════════════════════════════════════");
  console.log("  In the browser window:");
  console.log("  1. Log in to the forum if prompted");
  console.log("  2. Click 'Add Passkey' (confirm access with your password)");
  console.log("  3. Name the passkey and confirm");
  console.log("  4. Return here and press Enter");
  console.log("════════════════════════════════════════\n");

  await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));

  const credentials = await getRegisteredCredentials(cdp, authenticatorId);
  if (credentials.length === 0) {
    console.error("No passkey credential found — registration may have failed.");
    await browser.close();
    process.exit(1);
  }

  await saveCredential(credentials[credentials.length - 1]);
  await writeState((await context.storageState()) as StorageState);
  console.log(`\nPasskey saved (rpId: ${credentials[credentials.length - 1].rpId}).`);
  console.log("auth-state.json refreshed.");

  await browser.close();
}

const mode = process.argv[2];
try {
  if (mode === "login") await runLogin();
  else if (mode === "register") await runRegister();
  else {
    console.error(`Unknown browser-runner mode: ${mode}`);
    process.exit(2);
  }
} catch (err) {
  console.error(`browser-runner(${mode}) failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
