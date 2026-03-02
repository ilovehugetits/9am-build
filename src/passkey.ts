import type { Page } from "puppeteer";
import { access, readFile, writeFile } from "fs/promises";
import path from "path";

const CREDENTIAL_FILE = path.resolve(import.meta.dirname, "../passkey-credential.json");

export interface SavedCredential {
  credentialId: string;
  rpId: string;
  privateKey: string;
  userHandle: string;
  signCount: number;
}

export async function setupVirtualAuthenticator(page: Page, credential?: SavedCredential): Promise<string> {
  const client = await page.createCDPSession();
  await client.send("WebAuthn.enable");

  const { authenticatorId } = await client.send("WebAuthn.addVirtualAuthenticator", {
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
    await client.send("WebAuthn.addCredential", {
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

  return authenticatorId;
}

export async function getRegisteredCredentials(page: Page, authenticatorId: string): Promise<SavedCredential[]> {
  const client = await page.createCDPSession();
  const { credentials } = await client.send("WebAuthn.getCredentials", { authenticatorId });

  return credentials.map((c: any) => ({
    credentialId: c.credentialId,
    rpId: c.rpId,
    privateKey: c.privateKey,
    userHandle: c.userHandle ?? "",
    signCount: c.signCount,
  }));
}

export async function saveCredential(credential: SavedCredential): Promise<void> {
  await writeFile(CREDENTIAL_FILE, JSON.stringify(credential, null, 2), "utf-8");
}

export async function loadCredential(): Promise<SavedCredential | null> {
  try {
    await access(CREDENTIAL_FILE);
    const raw = await readFile(CREDENTIAL_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
