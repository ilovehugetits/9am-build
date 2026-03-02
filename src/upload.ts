import type { Browser } from "puppeteer";
import path from "path";
import chalk from "chalk";

const PORTAL_URL = "https://portal.cfx.re/assets/created-assets";

export async function uploadAsset(browser: Browser, assetId: number, zipPath: string, label: string): Promise<void> {
  const page = await browser.newPage();

  try {
    console.log(chalk.blue(`[${label}] Asset ${assetId} için upload başlıyor...`));

    await page.goto(PORTAL_URL, { waitUntil: "networkidle2", timeout: 30_000 });

    try {
      await page.waitForSelector("text/Created Assets", { timeout: 30_000 });
    } catch {
      await page.screenshot({ path: `/tmp/debug-upload-${label}-${Date.now()}.png`, fullPage: true });
      const url = page.url();
      const text = await page.evaluate(() => document.body.innerText.slice(0, 1000));
      console.log(chalk.red(`[DEBUG] URL: ${url}`));
      console.log(chalk.red(`[DEBUG] Page text: ${text}`));
      throw new Error(`Created Assets sayfası yüklenemedi (${label})`);
    }

    await new Promise((r) => setTimeout(r, 3000));

    // Asset ID'ye göre satırı bul, checkbox'ına tıkla ve RE-UPLOAD'a bas
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
      throw new Error(`Asset ID ${assetId} portalda bulunamadı.`);
    }

    await new Promise((r) => setTimeout(r, 500));

    // RE-UPLOAD butonuna tıkla
    await page.evaluate(() => {
      const buttons = document.querySelectorAll("button");
      for (const b of buttons) {
        if (b.textContent?.includes("RE-UPLOAD") && !b.hasAttribute("disabled")) {
          b.click();
          break;
        }
      }
    });

    // "Update an asset" modal'ının açılmasını bekle
    await page.waitForSelector("dialog, [role='dialog']", { visible: true, timeout: 10_000 });

    // Modal içindeki file input'u bul ve dosyayı yükle
    const fileInput = await page.$('dialog input[type="file"], [role="dialog"] input[type="file"]');
    if (!fileInput) {
      // File input gizli olabilir, Choose File butonuna tıklayıp filechooser yakala
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

    console.log(chalk.blue(`[${label}] Dosya seçildi, upload bekleniyor...`));

    // "Upload File" butonu aktif olacak, tıkla
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

    // Upload tamamlanmasını bekle (modal kapanır)
    await page.waitForSelector("dialog, [role='dialog']", { hidden: true, timeout: 120_000 });

    console.log(chalk.green(`[${label}] Asset ${assetId} başarıyla yüklendi!\n`));
  } finally {
    await page.close();
  }
}
