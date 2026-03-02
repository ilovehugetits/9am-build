import puppeteer from "puppeteer";
import chalk from "chalk";
import { getAuthenticatedContext } from "./auth.js";
import { setupVirtualAuthenticator, getRegisteredCredentials, saveCredential } from "./passkey.js";

const FORUM_SECURITY_URL = "https://forum.cfx.re/u/me/preferences/security";

export async function registerPasskey(): Promise<void> {
  console.log(chalk.bold("\n9am-build — Passkey Kayıt\n"));

  // 1. Auth context al (cookie ile veya login ile)
  console.log(chalk.gray("Forum'a giriş yapılıyor..."));
  const browser = await getAuthenticatedContext();
  const page = (await browser.pages())[0];

  // 2. Virtual authenticator oluştur (credential yüklemeden)
  const authenticatorId = await setupVirtualAuthenticator(page);

  // 3. Forum güvenlik ayarları sayfasına git
  await page.goto(FORUM_SECURITY_URL, { waitUntil: "networkidle2" });
  await new Promise((r) => setTimeout(r, 2000));

  console.log(chalk.bold.cyan("\n════════════════════════════════════════"));
  console.log(chalk.bold.cyan("  Şimdi browser'da:"));
  console.log(chalk.bold.cyan("  1. 'Add passkey' butonuna tıkla"));
  console.log(chalk.bold.cyan("  2. Passkey adını gir ve onayla"));
  console.log(chalk.bold.cyan("  3. Tamamlanınca buraya dön"));
  console.log(chalk.bold.cyan("════════════════════════════════════════\n"));

  // 4. Kullanıcının passkey eklemesini bekle
  console.log(chalk.gray("Passkey kaydını bekleniyor... (devam etmek için Enter'a bas)"));
  await new Promise<void>((resolve) => {
    process.stdin.once("data", () => resolve());
  });

  // 5. Credential'ı al ve kaydet
  const credentials = await getRegisteredCredentials(page, authenticatorId);

  if (credentials.length === 0) {
    console.log(chalk.red("Hiç passkey credential bulunamadı. Kayıt başarısız olmuş olabilir."));
    await browser.close();
    process.exit(1);
  }

  const credential = credentials[credentials.length - 1];
  await saveCredential(credential);

  console.log(chalk.green(`\nPasskey başarıyla kaydedildi! (rpId: ${credential.rpId})`));
  console.log(chalk.gray("Credential passkey-credential.json'a kaydedildi.\n"));

  await browser.close();
}
