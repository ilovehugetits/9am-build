import { access, chmod, readFile, writeFile } from "fs/promises";
import path from "path";
import type { Page, CDPSession } from "playwright";

export const CREDENTIAL_FILE = path.resolve(import.meta.dirname, "../../passkey-credential.json");

export interface SavedCredential {
  credentialId: string;
  rpId: string;
  privateKey: string;
  userHandle: string;
  signCount: number;
}

export async function setupVirtualAuthenticator(
  page: Page,
  credential?: SavedCredential
): Promise<{ authenticatorId: string; cdp: CDPSession }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");

  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  if (credential) {
    await cdp.send("WebAuthn.addCredential", {
      authenticatorId,
      credential: {
        credentialId: credential.credentialId,
        rpId: credential.rpId,
        privateKey: credential.privateKey,
        userHandle: credential.userHandle,
        signCount: credential.signCount,
        isResidentCredential: true,
      },
    });
  }

  return { authenticatorId, cdp };
}

export async function getRegisteredCredentials(cdp: CDPSession, authenticatorId: string): Promise<SavedCredential[]> {
  const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
  return credentials.map((c: any) => ({
    credentialId: c.credentialId,
    rpId: c.rpId,
    privateKey: c.privateKey,
    userHandle: c.userHandle ?? "",
    signCount: c.signCount,
  }));
}

export async function loadCredential(): Promise<SavedCredential | null> {
  try {
    await access(CREDENTIAL_FILE);
    return JSON.parse(await readFile(CREDENTIAL_FILE, "utf-8"));
  } catch {
    return null;
  }
}

export async function saveCredential(credential: SavedCredential): Promise<void> {
  // Holds a WebAuthn private key — keep it owner-only (no-op on Windows,
  // enforced on the Linux/Coolify host where it matters).
  await writeFile(CREDENTIAL_FILE, JSON.stringify(credential, null, 2), { encoding: "utf-8", mode: 0o600 });
  await chmod(CREDENTIAL_FILE, 0o600).catch(() => {});
}
