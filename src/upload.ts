import type { Browser } from "puppeteer";
import path from "path";
import chalk from "chalk";

const PORTAL_URL = "https://portal.cfx.re/assets/created-assets";

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

export async function uploadAsset(browser: Browser, assetId: number, zipPath: string, label: string): Promise<void> {
  const page = await browser.newPage();

  try {
    console.log(chalk.blue(`[${label}] Starting upload for asset ${assetId}...`));

    await page.goto(PORTAL_URL, { waitUntil: "load", timeout: 30_000 });

    try {
      await waitForPortalLoaded(page, 30_000);
    } catch {
      await page.screenshot({ path: `/tmp/debug-upload-${label}-${Date.now()}.png`, fullPage: true });
      const url = page.url();
      throw new Error(`Portal page failed to load (${label}): ${url}`);
    }

    await new Promise((r) => setTimeout(r, 3000));

    // Find row by asset ID, click checkbox, then RE-UPLOAD
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

    await new Promise((r) => setTimeout(r, 500));

    // Click RE-UPLOAD button
    await page.evaluate(() => {
      const buttons = document.querySelectorAll("button");
      for (const b of buttons) {
        if (b.textContent?.includes("RE-UPLOAD") && !b.hasAttribute("disabled")) {
          b.click();
          break;
        }
      }
    });

    // Wait for "Update an asset" modal to appear
    await page.waitForSelector("dialog, [role='dialog']", { visible: true, timeout: 10_000 });

    // Find file input in modal and upload file
    const fileInput = await page.$('dialog input[type="file"], [role="dialog"] input[type="file"]');
    if (!fileInput) {
      // File input may be hidden, click Choose File and catch file chooser
      const [fileChooser] = await Promise.all([
        page.waitForFileChooser({ timeout: 10_000 }),
        page.evaluate(() => {
          const dialog = document.querySelector('dialog, [role="dialog"]');
          const buttons = dialog?.querySelectorAll("button") ?? [];
          for (const b of buttons) {
            if (b.textContent?.includes("Choose File")) {
              b.click();
              break;
            }
          }
        }),
      ]);
      await fileChooser.accept([path.resolve(zipPath)]);
    } else {
      await fileInput.uploadFile(path.resolve(zipPath));
    }

    console.log(chalk.blue(`[${label}] File selected, waiting for upload...`));

    // Click "Upload File" button
    await new Promise((r) => setTimeout(r, 1000));

    await page.evaluate(() => {
      const dialog = document.querySelector('dialog, [role="dialog"]');
      const buttons = dialog?.querySelectorAll("button") ?? [];
      for (const b of buttons) {
        if (b.textContent?.includes("Upload File") && !b.hasAttribute("disabled")) {
          b.click();
          break;
        }
      }
    });

    // Wait for upload to complete (modal closes)
    await page.waitForSelector("dialog, [role='dialog']", { hidden: true, timeout: 120_000 });

    console.log(chalk.green(`[${label}] Asset ${assetId} uploaded successfully!\n`));
  } catch (err) {
    // Keep page open on error for inspection
    throw err;
  }
}
