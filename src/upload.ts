import type { Browser } from "puppeteer";
import path from "path";
import chalk from "chalk";

const PORTAL_URL = "https://portal.cfx.re/assets/created-assets";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForPortalLoaded(page: import("puppeteer").Page, timeout = 30_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const hasCreatedAssets = await page
      .evaluate(() => document.body.innerText.includes("Created Assets"))
      .catch(() => false);
    if (hasCreatedAssets) return;
    await sleep(500);
  }
  throw new Error(`Portal failed to load (timeout), last URL: ${page.url()}`);
}

/** Poll for a button inside the open dialog whose text matches `matcher` and click it. */
async function clickDialogButton(
  page: import("puppeteer").Page,
  matcher: RegExp,
  timeout = 15_000,
  requireEnabled = true
): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const clicked = await page.evaluate(
      (src, flags, needEnabled) => {
        const re = new RegExp(src, flags);
        const d = document.querySelector("dialog, [role='dialog']");
        if (!d) return false;
        const btns = Array.from(d.querySelectorAll("button"));
        const b = btns.find(
          (x) => re.test((x.textContent || "").trim()) && (!needEnabled || !x.hasAttribute("disabled"))
        );
        if (b) {
          (b as HTMLElement).click();
          return true;
        }
        return false;
      },
      matcher.source,
      matcher.flags,
      requireEnabled
    );
    if (clicked) return true;
    await sleep(400);
  }
  return false;
}

export async function uploadAsset(browser: Browser, assetId: number, zipPath: string, label: string): Promise<void> {
  const page = await browser.newPage();

  try {
    console.log(chalk.blue(`[${label}] Starting upload for asset ${assetId}...`));

    await page.goto(PORTAL_URL, { waitUntil: "load", timeout: 30_000 });
    try {
      await waitForPortalLoaded(page, 30_000);
    } catch {
      throw new Error(`Portal page failed to load (${label}): ${page.url()}`);
    }

    await sleep(3000);

    // 1. Find the asset row by ID and select its checkbox.
    const found = await page.evaluate((id) => {
      const rows = document.querySelectorAll("tr");
      for (const r of rows) {
        if (r.textContent?.includes(String(id))) {
          const cb = r.querySelector('[role="checkbox"]') as HTMLElement | null;
          if (cb) cb.click();
          return true;
        }
      }
      return false;
    }, assetId);

    if (!found) {
      throw new Error(`Asset ID ${assetId} not found on portal.`);
    }

    await sleep(700);

    // 2. Open the "New Asset Version" dialog.
    const opened = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button")).find(
        (x) => /upload new version/i.test(x.textContent || "") && !x.hasAttribute("disabled")
      );
      if (b) {
        (b as HTMLElement).click();
        return true;
      }
      return false;
    });
    if (!opened) {
      throw new Error(`"UPLOAD NEW VERSION" button not found for asset ${assetId}.`);
    }

    // 3. Wait for the dialog's file input and upload the zip.
    const fileSel = "dialog input[type='file'], [role='dialog'] input[type='file']";
    await page.waitForSelector(fileSel, { timeout: 15_000 });
    const fileInput = await page.$(fileSel);
    if (!fileInput) {
      throw new Error("File input not found in upload dialog.");
    }
    await fileInput.uploadFile(path.resolve(zipPath));
    console.log(chalk.blue(`[${label}] File uploaded, waiting for version detection...`));

    // 4. Portal reads the version from the zip's fxmanifest; give it time.
    await sleep(4000);

    // Fail fast (and clearly) if the portal rejects the version as a duplicate.
    const duplicate = await page
      .evaluate(() =>
        /this version already exists/i.test(
          document.querySelector("dialog, [role='dialog']")?.textContent || ""
        )
      )
      .catch(() => false);
    if (duplicate) {
      throw new Error(
        `Version already exists for asset ${assetId} — bump the fxmanifest.lua version to a unique value.`
      );
    }

    // 5. Select "Full Release" as the version type.
    await clickDialogButton(page, /full release/i, 10_000);
    await sleep(800);

    // 6. Advance to the release-notes step (Next enables once type + version are set).
    if (!(await clickDialogButton(page, /^next$/i, 20_000))) {
      throw new Error(`"Next" never enabled — version type/version not selected (${label}).`);
    }
    await sleep(2000);

    // 7. Final submit.
    if (!(await clickDialogButton(page, /^upload file$/i, 15_000))) {
      throw new Error(`"Upload File" submit button not found (${label}).`);
    }

    // 8. Wait for completion. On success the dialog does NOT auto-dismiss — it
    // shows a confirmation ("...uploaded successfully.") with Close / View
    // Versions buttons, so detect the success text rather than the dialog's
    // removal. A plain waitForSelector(hidden) here would false-timeout.
    const deadline = Date.now() + 180_000;
    let done = false;
    while (Date.now() < deadline) {
      await sleep(1500);
      const status = await page
        .evaluate(() => {
          const d = document.querySelector("dialog, [role='dialog']");
          if (!d) return "gone";
          const t = (d.textContent || "").toLowerCase();
          if (/uploaded successfully|has been uploaded/.test(t)) return "success";
          if (/upload failed|an error occurred|something went wrong/.test(t)) return "error";
          return "pending";
        })
        .catch(() => "pending");
      if (status === "success" || status === "gone") {
        done = true;
        break;
      }
      if (status === "error") {
        throw new Error(`Portal reported an upload error (${label}).`);
      }
    }
    if (!done) {
      throw new Error(`Upload did not complete within timeout (${label}).`);
    }

    // Dismiss the confirmation dialog so the next asset starts clean.
    await clickDialogButton(page, /^close$/i, 5_000).catch(() => {});

    console.log(chalk.green(`[${label}] Asset ${assetId} uploaded successfully!\n`));
  } finally {
    await page.close();
  }
}
