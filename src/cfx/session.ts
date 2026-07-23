import { access, chmod } from "fs/promises";
import path from "path";
import chalk from "chalk";
import { chromium, request, type APIRequestContext, type Browser } from "playwright";
import { isAuthenticated, type Requester } from "./api.js";
import { playwrightRequester } from "./requester.js";
import { loginViaSSO, loginWithPasskey } from "./login.js";
import { loadCredential } from "./passkey.js";

export const AUTH_STATE_FILE = path.resolve(import.meta.dirname, "../../auth-state.json");

export interface Session {
  request: Requester;
  close(): Promise<void>;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function apiSessionFromState(): Promise<APIRequestContext | null> {
  if (!(await fileExists(AUTH_STATE_FILE))) return null;
  const ctx = await request.newContext({ storageState: AUTH_STATE_FILE });
  if (await isAuthenticated(playwrightRequester(ctx))) return ctx;
  await ctx.dispose();
  return null;
}

// Keep the Chromium sandbox ON by default (secure locally). Containers that run
// as root (e.g. Coolify) can opt out by setting CHROMIUM_NO_SANDBOX=1.
function launchArgs(): string[] {
  const args = ["--disable-blink-features=AutomationControlled"];
  if (process.env.CHROMIUM_NO_SANDBOX === "1") {
    args.push("--no-sandbox", "--disable-setuid-sandbox");
  }
  return args;
}

export async function ensureSession(): Promise<Session> {
  // Tier 1: existing jwt still valid — no browser.
  const cached = await apiSessionFromState();
  if (cached) {
    console.log(chalk.green("Portal session valid (jwt)."));
    return { request: playwrightRequester(cached), close: () => cached.dispose() };
  }

  // Tiers 2 & 3 need a browser.
  const browser: Browser = await chromium.launch({ headless: true, args: launchArgs() });
  try {
    const hasState = await fileExists(AUTH_STATE_FILE);
    const context = await browser.newContext(hasState ? { storageState: AUTH_STATE_FILE } : {});
    const page = await context.newPage();

    // Tier 2: forum session alive → SSO with no passkey prompt.
    let ok = await loginViaSSO(page);

    // Tier 3: full passkey login.
    if (!ok) {
      const credential = await loadCredential();
      if (!credential) {
        throw new Error("No passkey credential. Run 'bun run register-passkey' first.");
      }
      console.log(chalk.gray("SSO needs re-auth — logging in with passkey..."));
      ok = await loginWithPasskey(page, credential);
    }

    if (!ok) throw new Error("Portal login failed (SSO + passkey both failed).");

    await context.storageState({ path: AUTH_STATE_FILE });
    await chmod(AUTH_STATE_FILE, 0o600).catch(() => {}); // portal jwt + forum cookies — owner-only
    const apiCtx = await request.newContext({ storageState: AUTH_STATE_FILE });
    return { request: playwrightRequester(apiCtx), close: () => apiCtx.dispose() };
  } finally {
    await browser.close();
  }
}
