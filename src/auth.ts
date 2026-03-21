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
    const url = page.url();
    if (
      url.includes("portal.cfx.re") &&
      !url.includes("/login") &&
      !url.includes("/authenticate")
    ) {
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Portal yüklenemedi (timeout), son URL: ${page.url()}`);
}

async function loginWithPasskey(browser: Browser): Promise<boolean> {
  const credential = await loadCredential();
  if (!credential) return false;

  console.log(chalk.gray("Passkey ile giriş deneniyor..."));

  const page = (await browser.pages())[0];

  try {
    await setupVirtualAuthenticator(page, credential);

    await page.goto(PORTAL_URL, { waitUntil: "load" });
    await new Promise((r) => setTimeout(r, 2000));

    console.log(chalk.gray(`[DEBUG] Passkey step 1 - URL: ${page.url()}`));

    const signInBtn = await page.waitForSelector('button::-p-text("Sign in with")', { timeout: 15_000 });
    await signInBtn!.click();
    await new Promise((r) => setTimeout(r, 2000));

    console.log(chalk.gray(`[DEBUG] Passkey step 2 - URL: ${page.url()}`));

    // "Log in with a passkey" butonuna tıkla
    await page.evaluate(() => {
      const buttons = document.querySelectorAll("button");
      for (const b of buttons) {
        if (b.textContent?.toLowerCase().includes("passkey")) {
          b.click();
          break;
        }
      }
    });

    // WebAuthn otomatik olarak handle edilir, portal'a yönlendirilmesini bekle
    await waitForPortalLoaded(page, 30_000);

    console.log(chalk.gray(`[DEBUG] Passkey step 3 - URL: ${page.url()}`));

    console.log(chalk.green("Passkey ile giriş başarılı!\n"));
    await saveCookies(browser);
    return true;
  } catch (err) {
    const url = page.url();
    const text = await page.evaluate(() => document.body.innerText.slice(0, 500)).catch(() => "N/A");
    console.log(chalk.yellow(`Passkey login başarısız (URL: ${url})`));
    console.log(chalk.yellow(`Page: ${text.slice(0, 300)}`));
    console.log(chalk.yellow("Parola ile deneniyor...\n"));
    return false;
  }
}

async function loginWithPassword(browser: Browser): Promise<void> {
  const username = process.env.CFX_USERNAME;
  const password = process.env.CFX_PASSWORD;

  if (!username || !password) {
    throw new Error(".env'de CFX_USERNAME ve CFX_PASSWORD tanımlı değil.");
  }

  console.log(chalk.gray("Cfx.re Forum'a parola ile giriş yapılıyor..."));

  const page = (await browser.pages())[0];

  // 1. Portal'a git → login sayfasına yönlendirir
  await page.goto(PORTAL_URL, { waitUntil: "load" });
  await new Promise((r) => setTimeout(r, 2000));

  // 2. "Sign in with" butonuna tıkla → Forum login'e yönlendirir
  const signInBtn = await page.waitForSelector('button::-p-text("Sign in with")', { timeout: 15_000 });
  await signInBtn!.click();
  await new Promise((r) => setTimeout(r, 2000));

  // 3. Forum login formunu doldur ve gönder (rate limit retry ile)
  async function submitLogin() {
    await page.waitForSelector("#login-account-name", { timeout: 15_000 });
    await page.type("#login-account-name", username!);
    await page.type("#login-account-password", password!);

    let rateLimitSeconds = 0;
    const sessionResponsePromise = page.waitForResponse(
      (res) => res.url().includes("/session") && res.request().method() === "POST",
      { timeout: 15_000 },
    );

    await page.click("#login-button");

    try {
      const res = await sessionResponsePromise;
      if (res.status() === 429 || res.status() === 200) {
        const body = await res.json().catch(() => null);
        if (body?.extras?.wait_seconds) {
          rateLimitSeconds = body.extras.wait_seconds;
        }
      }
    } catch {
      // Response yakalanamazsa devam et
    }

    return rateLimitSeconds;
  }

  let waitSeconds = await submitLogin();

  // 4. Rate limit — beklerken manuel login'i de izle
  if (waitSeconds > 0) {
    console.log(chalk.yellow(`Rate limit — ${waitSeconds} saniye bekleniyor (veya browser'dan manuel giriş yap)...`));

    const manualLogin = (async () => {
      while (true) {
        await new Promise((r) => setTimeout(r, 2000));
        const url = page.url();
        if (url.includes("portal.cfx.re") || !url.includes("forum.cfx.re")) {
          return true;
        }
        const hasLoginForm = await page.evaluate(() => !!document.querySelector("#login-account-name")).catch(() => false);
        if (!hasLoginForm) return true;
      }
    })();

    const rateLimitWait = new Promise<false>((r) => setTimeout(() => r(false), waitSeconds * 1000));

    const manuallyLoggedIn = await Promise.race([manualLogin, rateLimitWait]);

    if (manuallyLoggedIn) {
      console.log(chalk.blue("Manuel login tespit edildi, devam ediliyor..."));
      await new Promise((r) => setTimeout(r, 3000));
      await page.goto(PORTAL_URL, { waitUntil: "load" });
      await waitForPortalLoaded(page, 15_000);
      console.log(chalk.green("Giriş başarılı! Session kaydediliyor...\n"));
      await saveCookies(browser);
      return;
    }

    // Rate limit bitti, tekrar dene
    await page.reload({ waitUntil: "load" });
    waitSeconds = await submitLogin();
    if (waitSeconds > 0) {
      throw new Error(`Rate limit devam ediyor (${waitSeconds}s). Daha sonra tekrar deneyin.`);
    }
  }

  await new Promise((r) => setTimeout(r, 3000));

  console.log(chalk.gray(`[DEBUG] Password login sonrası URL: ${page.url()}`));
  const pwText = await page.evaluate(() => document.body.innerText.slice(0, 500)).catch(() => "N/A");
  console.log(chalk.gray(`[DEBUG] Password login page: ${pwText.slice(0, 300)}`));

  // 5. Portal'a geri dönmesini bekle
  try {
    await waitForPortalLoaded(page, 30_000);
  } catch {
    const errText = await page.evaluate(() => document.body.innerText.slice(0, 500)).catch(() => "N/A");
    console.log(chalk.red(`[DEBUG] Password login failed. URL: ${page.url()}`));
    console.log(chalk.red(`[DEBUG] Page: ${errText}`));
    throw new Error("Password login sonrası portal sayfası yüklenemedi.");
  }

  console.log(chalk.green("Giriş başarılı! Session kaydediliyor...\n"));
  await saveCookies(browser);
}

const launchOptions = {
  headless: "shell" as const,
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
      console.log(chalk.green("Mevcut session geçerli.\n"));
      return browser;
    } catch {
      console.log(chalk.yellow("Session süresi dolmuş, yeniden giriş gerekiyor.\n"));
      await browser.close();
    }
  }

  // Login: önce passkey, fallback parola
  const browser = await puppeteer.launch(launchOptions);

  if (await loginWithPasskey(browser)) {
    return browser;
  }

  await loginWithPassword(browser);
  return browser;
}
