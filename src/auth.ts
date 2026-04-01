import puppeteer, { type Browser } from "puppeteer";
import { access, readFile, writeFile } from "fs/promises";
import path from "path";
import chalk from "chalk";
import { setupVirtualAuthenticator, loadCredential } from "./passkey.js";

const AUTH_STATE_FILE = path.resolve(import.meta.dirname, "../auth-state.json");
const PORTAL_URL = "https://portal.cfx.re/assets/created-assets";

async function authStateExists(): Promise<boolean> {
  try {
    await access(AUTH_STATE_FILE);
    return true;
  } catch {
    return false;
  }
}

async function saveCookies(browser: Browser): Promise<void> {
  const cookies = await browser.defaultBrowserContext().cookies();
  await writeFile(AUTH_STATE_FILE, JSON.stringify(cookies, null, 2), "utf-8");
}

async function waitForPortalLoaded(page: import("puppeteer").Page, timeout = 30_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const hasCreatedAssets = await page.evaluate(() =>
      document.body.innerText.includes("Created Assets")
    ).catch(() => false);
    if (hasCreatedAssets) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Portal failed to load (timeout), last URL: ${page.url()}`);
}

async function loginWithPasskey(browser: Browser): Promise<boolean> {
  const credential = await loadCredential();
  if (!credential) return false;

  console.log(chalk.gray("Attempting passkey login..."));

  const page = (await browser.pages())[0];

  try {
    await setupVirtualAuthenticator(page, credential);

    await page.goto(PORTAL_URL, { waitUntil: "load" });
    await new Promise((r) => setTimeout(r, 2000));

    await page.evaluate(() => {
      const btn = document.querySelector('button[class*="login_noWrap"]') as HTMLElement | null;
      if (btn) btn.click();
    });
    await new Promise((r) => setTimeout(r, 2000));

    // Click "Log in with a passkey" button
    await page.evaluate(() => {
      const buttons = document.querySelectorAll("button");
      for (const b of buttons) {
        if (b.textContent?.toLowerCase().includes("passkey")) {
          b.click();
          break;
        }
      }
    });

    // Wait for WebAuthn to complete
    await new Promise((r) => setTimeout(r, 5000));

    // Redirect to portal if still on forum
    if (!page.url().includes("portal.cfx.re")) {
      await page.goto(PORTAL_URL, { waitUntil: "load" });
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Click "SIGN IN WITH Cfx.re" if on portal login page
    if (page.url().includes("/login")) {
      await page.evaluate(() => {
        const btn = document.querySelector('button[class*="login_noWrap"]') as HTMLElement | null;
        if (btn) btn.click();
      });
      await new Promise((r) => setTimeout(r, 3000));
    }

    await waitForPortalLoaded(page, 30_000);

    console.log(chalk.green("Passkey login successful!\n"));
    await saveCookies(browser);
    return true;
  } catch (err) {
    const url = page.url();
    const text = await page.evaluate(() => document.body.innerText.slice(0, 500)).catch(() => "N/A");
    console.log(chalk.red(`Passkey login failed (URL: ${url})`));
    console.log(chalk.red(`Page: ${text.slice(0, 300)}`));
    return false;
  }
}

const launchOptions = {
  headless: true,
  protocolTimeout: 120_000,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--window-size=1280,800",
  ],
  defaultViewport: { width: 1280, height: 800 },
};

export async function getAuthenticatedContext(): Promise<Browser> {
  const hasState = await authStateExists();

  if (hasState) {
    const browser = await puppeteer.launch(launchOptions);
    const page = (await browser.pages())[0];

    const raw = await readFile(AUTH_STATE_FILE, "utf-8");
    const cookies = JSON.parse(raw);
    await browser.defaultBrowserContext().setCookie(...cookies);

    await page.goto(PORTAL_URL, { waitUntil: "load" });

    try {
      await waitForPortalLoaded(page, 10_000);
      console.log(chalk.green("Existing session is valid.\n"));
      return browser;
    } catch {
      console.log(chalk.yellow("Session expired, re-login required.\n"));
      await browser.close();
    }
  }

  // Login via passkey
  const browser = await puppeteer.launch(launchOptions);

  if (await loginWithPasskey(browser)) {
    return browser;
  }

  throw new Error("Passkey login failed. Please run 'bun run register-passkey' to register a passkey.");
}
