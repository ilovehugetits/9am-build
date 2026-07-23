import type { Page } from "playwright";
import chalk from "chalk";
import { setupVirtualAuthenticator, type SavedCredential } from "./passkey.js";
import { API_BASE } from "./api.js";

export const PORTAL_URL = "https://portal.cfx.re/assets/created-assets";

/** Auth signal: an in-page fetch of v1/me (credentials included), mirroring the
 *  portal app. Returns false when cross-origin (e.g. on forum.cfx.re, where the
 *  call is CORS-blocked) or mid-navigation. */
async function portalAuthed(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(async (base) => {
      try {
        const r = await fetch(`${base}/v1/me`, { credentials: "include" });
        return r.status === 200;
      } catch {
        return false;
      }
    }, API_BASE);
  } catch {
    return false;
  }
}

/** The portal is a client-side SPA: after navigation it redirects to /login and
 *  renders the "Sign in with" button a moment later. Wait for it, then click. */
async function clickSignIn(page: Page): Promise<boolean> {
  const signIn = page.getByRole("button", { name: /sign in with/i });
  await signIn.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  if (await signIn.count()) {
    await signIn.first().click();
    return true;
  }
  return false;
}

type SettleResult = "authed" | "passkey-form" | "timeout";

/** After clicking sign-in, the SSO either auto-completes (forum session alive →
 *  back on the portal, authed) or lands on the forum login form (passkey button
 *  visible). Poll for whichever happens first. */
async function settle(page: Page, timeoutMs: number): Promise<SettleResult> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portalAuthed(page)) return "authed";
    const passkeyBtn = page.getByRole("button", { name: /log in with a passkey/i });
    if ((await passkeyBtn.count().catch(() => 0)) && (await passkeyBtn.first().isVisible().catch(() => false))) {
      return "passkey-form";
    }
    await page.waitForTimeout(500);
  }
  return "timeout";
}

async function waitForAuthed(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portalAuthed(page)) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

/** Tier 2: forum session still alive — clicking sign-in completes SSO with no
 *  passkey prompt. */
export async function loginViaSSO(page: Page): Promise<boolean> {
  await page.goto(PORTAL_URL, { waitUntil: "domcontentloaded" });
  if (await portalAuthed(page)) return true;
  await clickSignIn(page);
  return (await settle(page, 25_000)) === "authed";
}

/** Tier 3: full passkey login via the virtual authenticator (used when the forum
 *  session is gone and SSO shows the login form). */
export async function loginWithPasskey(page: Page, credential: SavedCredential): Promise<boolean> {
  await setupVirtualAuthenticator(page, credential);

  await page.goto(PORTAL_URL, { waitUntil: "domcontentloaded" });
  if (await portalAuthed(page)) return true;

  await clickSignIn(page);
  const result = await settle(page, 25_000);
  if (result === "authed") return true; // forum session was still alive after all

  if (result === "passkey-form") {
    await page.getByRole("button", { name: /log in with a passkey/i }).first().click();
    if (await waitForAuthed(page, 30_000)) {
      console.log(chalk.green("Passkey login successful."));
      return true;
    }
  }
  return false;
}
