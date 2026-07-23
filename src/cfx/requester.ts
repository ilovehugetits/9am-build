import type { Requester, HttpResponse, MultipartField } from "./api.js";
import type { PwCookie } from "./storage-state.js";

// The Cfx portal API is plain cookie-authed HTTP, so we call it with Bun's
// native fetch and a Cookie header built from the session. (Playwright's
// APIRequestContext mis-parses Set-Cookie under Bun, so we avoid it here — the
// browser is only used for login.)

function domainMatches(host: string, cookieDomain: string): boolean {
  const d = cookieDomain.startsWith(".") ? cookieDomain.slice(1) : cookieDomain;
  return host === d || host.endsWith(`.${d}`);
}

function pathMatches(reqPath: string, cookiePath: string): boolean {
  if (!cookiePath || cookiePath === "/") return true;
  if (reqPath === cookiePath) return true;
  const prefix = cookiePath.endsWith("/") ? cookiePath : `${cookiePath}/`;
  return reqPath.startsWith(prefix);
}

export function cookieHeaderFor(url: string, cookies: PwCookie[]): string {
  const { hostname, pathname } = new URL(url);
  const map = new Map<string, string>();
  for (const c of cookies) {
    if (domainMatches(hostname, c.domain) && pathMatches(pathname, c.path)) {
      map.set(c.name, c.value); // last write wins for duplicate names
    }
  }
  return [...map.entries()].map(([n, v]) => `${n}=${v}`).join("; ");
}

const BROWSER_HEADERS = {
  Origin: "https://portal.cfx.re",
  Referer: "https://portal.cfx.re/",
};

function wrap(res: Response): HttpResponse {
  return {
    status: res.status,
    ok: res.ok,
    json: () => res.json(),
    text: () => res.text(),
  };
}

export function fetchRequester(cookies: PwCookie[]): Requester {
  const base = (url: string) => ({ Cookie: cookieHeaderFor(url, cookies), ...BROWSER_HEADERS });

  return {
    async get(url) {
      return wrap(await fetch(url, { headers: base(url) }));
    },
    async postJson(url, body) {
      return wrap(
        await fetch(url, {
          method: "POST",
          headers: { ...base(url), "Content-Type": "application/json" },
          body: JSON.stringify(body ?? {}),
        })
      );
    },
    async postMultipart(url, fields: MultipartField[]) {
      const form = new FormData();
      for (const f of fields) {
        if (typeof f.value === "string") {
          form.append(f.name, f.value);
        } else {
          const bytes = Uint8Array.from(f.value.buffer);
          form.append(f.name, new Blob([bytes], { type: f.value.mimeType }), f.value.fileName);
        }
      }
      return wrap(await fetch(url, { method: "POST", headers: base(url), body: form }));
    },
    async del(url) {
      return wrap(await fetch(url, { method: "DELETE", headers: base(url) }));
    },
  };
}
