import { chmod, readFile, writeFile } from "fs/promises";
import path from "path";
import chalk from "chalk";
import { isAuthenticated, type Requester } from "./api.js";
import { fetchRequester } from "./requester.js";
import { runBrowser } from "./run-browser.js";
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

const noop = async (): Promise<void> => {};

export async function ensureSession(): Promise<Session> {
  // Tier 1: existing jwt still valid — pure fetch, no browser.
  const cached = await requesterFromState(await readStorageState());
  if (cached) {
    console.log(chalk.green("Portal session valid (jwt)."));
    return { request: cached, close: noop };
  }

  // Tiers 2 & 3 need a browser: the Node runner refreshes auth-state.json via
  // SSO (forum session alive) or a full passkey login.
  console.log(chalk.gray("Session expired — refreshing via browser (SSO/passkey)..."));
  const code = await runBrowser("login");
  if (code !== 0) {
    throw new Error(`Portal login failed (browser runner exited ${code}).`);
  }

  const refreshed = await requesterFromState(await readStorageState());
  if (!refreshed) {
    throw new Error("Portal login ran but the refreshed session is still unauthenticated.");
  }
  return { request: refreshed, close: noop };
}
