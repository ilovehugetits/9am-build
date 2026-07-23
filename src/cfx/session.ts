import { chmod, readFile, writeFile } from "fs/promises";
import path from "path";
import chalk from "chalk";
import { chromium, type Browser } from "playwright";
import { isAuthenticated, type Requester } from "./api.js";
import { fetchRequester } from "./requester.js";
import { loginViaSSO, loginWithPasskey } from "./login.js";
import { loadCredential } from "./passkey.js";
import { toStorageState, isLegacyFormat, type StorageState } from "./storage-state.js";

export const AUTH_STATE_FILE = path.resolve(import.meta.dirname, "../../auth-state.json");

export interface Session {
  request: Requester;
  close(): Promise<void>;
}

/** Read the saved session, migrating the legacy Puppeteer array format to
 *  Playwright storageState (and rewriting the file) when needed. Null if absent. */
async function readStorageState(): Promise<StorageState | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(AUTH_STATE_FILE, "utf-8"));
  } catch {
    return null;
  }
  const state = toStorageState(raw);
  if (isLegacyFormat(raw)) {
    console.log(chalk.gray("Migrating legacy auth-state.json to Playwright format..."));
    await persistStorageState(state);
  }
  return state;
}

async function persistStorageState(state: StorageState): Promise<void> {
  await writeFile(AUTH_STATE_FILE, JSON.stringify(state), { encoding: "utf-8", mode: 0o600 });
  await chmod(AUTH_STATE_FILE, 0o600).catch(() => {}); // portal jwt + forum cookies — owner-only
}

async function requesterFromState(state: StorageState | null): Promise<Requester | null> {
  if (!state) return null;
  const req = fetchRequester(state.cookies);
  return (await isAuthenticated(req)) ? req : null;
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

const noop = async (): Promise<void> => {};

export async function ensureSession(): Promise<Session> {
  const state = await readStorageState();

  // Tier 1: existing jwt still valid — no browser.
  const cached = await requesterFromState(state);
  if (cached) {
    console.log(chalk.green("Portal session valid (jwt)."));
    return { request: cached, close: noop };
  }

  // Tiers 2 & 3 need a browser.
  const browser: Browser = await chromium.launch({ headless: true, args: launchArgs() });
  try {
    const context = await browser.newContext(state ? { storageState: state } : {});
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

    const freshState = (await context.storageState()) as StorageState;
    await persistStorageState(freshState);
    return { request: fetchRequester(freshState.cookies), close: noop };
  } finally {
    await browser.close();
  }
}
