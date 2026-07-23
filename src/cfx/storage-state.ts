// Playwright storageState is `{ cookies, origins }`. The Puppeteer-era tool
// saved a bare cookie array, so we migrate that legacy shape on read.

export interface PwCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

export interface StorageState {
  cookies: PwCookie[];
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
}

function normalizeSameSite(s: unknown): "Strict" | "Lax" | "None" {
  return s === "Strict" || s === "Lax" || s === "None" ? s : "Lax";
}

function normalizeCookie(c: any): PwCookie | null {
  if (!c || typeof c.name !== "string" || typeof c.value !== "string" || typeof c.domain !== "string") {
    return null;
  }
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: typeof c.path === "string" ? c.path : "/",
    expires: typeof c.expires === "number" ? c.expires : -1,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite: normalizeSameSite(c.sameSite),
  };
}

/** Accepts a Playwright storageState object OR a legacy Puppeteer cookie array
 *  and returns a valid Playwright storageState. */
export function toStorageState(raw: unknown): StorageState {
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "cookies" in raw) {
    const obj = raw as Partial<StorageState>;
    const cookies = (obj.cookies ?? []).map(normalizeCookie).filter((c): c is PwCookie => c !== null);
    return { cookies, origins: obj.origins ?? [] };
  }
  const arr = Array.isArray(raw) ? raw : [];
  const cookies = arr.map(normalizeCookie).filter((c): c is PwCookie => c !== null);
  return { cookies, origins: [] };
}

/** True when the raw value is the legacy Puppeteer array format. */
export function isLegacyFormat(raw: unknown): boolean {
  return Array.isArray(raw);
}
