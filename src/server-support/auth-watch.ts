import { readFile } from "fs/promises";
import chalk from "chalk";
import { AUTH_STATE_FILE } from "../cfx/session.js";
import { toStorageState, type StorageState } from "../cfx/storage-state.js";
import { sendDiscordAlert } from "../integrations/discord.js";

// The forum `_t` cookie carries the SSO tier. Once it is gone, a headless login
// hits the forum's new-device email check, so a human must run `bun run login`.
const WARN_DAYS = 7;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ForumSessionStatus =
  | { kind: "ok"; expiresAt: Date; daysLeft: number }
  | { kind: "expiring"; expiresAt: Date; daysLeft: number }
  | { kind: "expired"; expiresAt: Date }
  | { kind: "missing" };

/** Classify the forum session in a storageState by its `_t` cookie expiry. */
export function forumSessionStatus(state: StorageState | null, now = Date.now()): ForumSessionStatus {
  const cookie = state?.cookies.find((c) => c.name === "_t" && c.domain.endsWith("forum.cfx.re"));
  if (!cookie || cookie.expires <= 0) return { kind: "missing" };

  const expiresAt = new Date(cookie.expires * 1000);
  const msLeft = expiresAt.getTime() - now;
  if (msLeft <= 0) return { kind: "expired", expiresAt };

  const daysLeft = Math.floor(msLeft / DAY_MS);
  return { kind: daysLeft < WARN_DAYS ? "expiring" : "ok", expiresAt, daysLeft };
}

async function readAuthState(): Promise<StorageState | null> {
  try {
    return toStorageState(JSON.parse(await readFile(AUTH_STATE_FILE, "utf-8")));
  } catch {
    return null;
  }
}

const FIX_STEPS =
  "Run `bun run login` on your local machine, then upload the new `auth-state.json` to `/data/auth-state.json` on the server.";

async function checkForumSession(): Promise<void> {
  const status = forumSessionStatus(await readAuthState());
  const date = status.kind === "missing" ? "" : status.expiresAt.toISOString().slice(0, 10);

  switch (status.kind) {
    case "ok":
      console.log(chalk.gray(`[AuthWatch] Forum session valid until ${date} (${status.daysLeft} days).`));
      return;
    case "expiring":
      return sendDiscordAlert(
        "Cfx forum session expires soon ⏳",
        `The forum cookie expires on **${date}** (${status.daysLeft} days left). After that, portal uploads fail.\n\n${FIX_STEPS}`
      );
    case "expired":
      return sendDiscordAlert(
        "Cfx forum session expired ❌",
        `The forum cookie expired on **${date}**. Portal uploads fail until you refresh it.\n\n${FIX_STEPS}`
      );
    case "missing":
      return sendDiscordAlert(
        "Cfx forum session missing ❌",
        `\`auth-state.json\` has no forum cookie. Portal uploads fail until you refresh it.\n\n${FIX_STEPS}`
      );
  }
}

/** Check the forum session now and then once a day; warn on Discord when stale. */
export function startAuthWatch(): void {
  const run = () =>
    checkForumSession().catch((err) =>
      console.error(chalk.yellow(`[AuthWatch] Check failed (non-fatal): ${err instanceof Error ? err.message : err}`))
    );
  run();
  setInterval(run, CHECK_INTERVAL_MS);
}
