import { test, expect } from "bun:test";
import { cookieHeaderFor } from "./requester.js";
import type { PwCookie } from "./storage-state.js";

const c = (over: Partial<PwCookie>): PwCookie => ({
  name: "n", value: "v", domain: "portal-api.cfx.re", path: "/", expires: -1,
  httpOnly: false, secure: true, sameSite: "None", ...over,
});

test("includes exact-domain cookies", () => {
  const header = cookieHeaderFor("https://portal-api.cfx.re/v1/me", [c({ name: "jwt", value: "abc" })]);
  expect(header).toBe("jwt=abc");
});

test("includes dot-prefixed parent-domain cookies", () => {
  const header = cookieHeaderFor("https://portal-api.cfx.re/v1/me", [
    c({ name: "_ga", value: "g", domain: ".cfx.re", secure: false, sameSite: "Lax" }),
  ]);
  expect(header).toBe("_ga=g");
});

test("excludes cookies for unrelated domains", () => {
  const header = cookieHeaderFor("https://portal-api.cfx.re/v1/me", [
    c({ name: "_forum_session", value: "s", domain: "forum.cfx.re" }),
  ]);
  expect(header).toBe("");
});

test("joins multiple cookies and de-dupes by name (last wins)", () => {
  const header = cookieHeaderFor("https://portal-api.cfx.re/v1/me", [
    c({ name: "jwt", value: "old" }),
    c({ name: "refresh-token", value: "r" }),
    c({ name: "jwt", value: "new" }),
  ]);
  expect(header).toBe("jwt=new; refresh-token=r");
});
