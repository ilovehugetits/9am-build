import type { Page } from "playwright";
import chalk from "chalk";
import { setupVirtualAuthenticator, type SavedCredential } from "./passkey.js";
import { API_BASE } from "./api.js";

export const PORTAL_URL = "https://portal.cfx.re/assets/created-assets";

async function portalAuthed(page: Page): Promise<boolean> {
  // Run the auth check as an in-page fetch (credentials included), mirroring the
  // portal app. Cross-origin calls (e.g. while briefly on forum.cfx.re) are
  // CORS-blocked and throw — treat those as "not yet authed".
  try {
    return await page.evaluate(async (base) => {
      const r = await fetch(`${base}/v1/me`, { credentials: "include" });
      return r.status === 200;
    }, API_BASE);
  } catch {
    return false;
  }
}

/** From any state on the portal, click "Sign in with" and wait for either the
 *  forum login page or a completed SSO (v1/me == 200). Returns true if authed. */
export async function completeSSO(page: Page): Promise<boolean> {
  const signIn = page.getByRole("button", { name: /sign in with/i });
  if (await signIn.count()) {
    await signIn.first().click();
  }
  for (let i = 0; i < 20; i++) {
    if (await portalAuthed(page)) return true;
    if (/forum\.cfx\.re\/login/.test(page.url())) return false; // needs credentials/passkey
    await page.waitForTimeout(500);
  }
  return portalAuthed(page);
}

/** Tier 2: forum session still alive — navigating the portal + clicking sign-in
 *  completes SSO with no passkey prompt. */
export async function loginViaSSO(page: Page): Promise<boolean> {
  await page.goto(PORTAL_URL, { waitUntil: "domcontentloaded" });
  if (await portalAuthed(page)) return true;
  return completeSSO(page);
}

/** Tier 3: full passkey login via the virtual authenticator. */
export async function loginWithPasskey(page: Page, credential: SavedCredential): Promise<boolean> {
  await setupVirtualAuthenticator(page, credential);

  await page.goto(PORTAL_URL, { waitUntil: "domcontentloaded" });
  if (await portalAuthed(page)) return true;

  // portal → forum login page
  const signIn = page.getByRole("button", { name: /sign in with/i });
  if (await signIn.count()) await signIn.first().click();

  const passkeyBtn = page.getByRole("button", { name: /log in with a passkey/i });
  await passkeyBtn.waitFor({ state: "visible", timeout: 30_000 });
  await passkeyBtn.click();

  // WebAuthn autosigns via the virtual authenticator; forum then SSO-redirects.
  for (let i = 0; i < 30; i++) {
    if (await portalAuthed(page)) {
      console.log(chalk.green("Passkey login successful."));
      return true;
    }
    if (/portal\.cfx\.re\/login/.test(page.url())) {
      const b = page.getByRole("button", { name: /sign in with/i });
      if (await b.count()) await b.first().click();
    }
    await page.waitForTimeout(1000);
  }
  return portalAuthed(page);
}
