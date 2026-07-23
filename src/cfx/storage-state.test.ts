import { test, expect } from "bun:test";
import { toStorageState, isLegacyFormat } from "./storage-state.js";

test("converts legacy puppeteer cookie array to storageState", () => {
  const legacy = [
    { name: "jwt", value: "abc", domain: "portal-api.cfx.re", path: "/", expires: 123, httpOnly: true, secure: false, sameSite: "Lax" },
    { name: "_t", value: "def", domain: "forum.cfx.re", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "None" },
  ];
  const state = toStorageState(legacy);
  expect(state.origins).toEqual([]);
  expect(state.cookies).toHaveLength(2);
  expect(state.cookies[0]).toEqual({
    name: "jwt", value: "abc", domain: "portal-api.cfx.re", path: "/",
    expires: 123, httpOnly: true, secure: false, sameSite: "Lax",
  });
});

test("passes through an existing storageState object", () => {
  const existing = { cookies: [{ name: "x", value: "y", domain: "d", path: "/", expires: -1, httpOnly: false, secure: true, sameSite: "None" }], origins: [] };
  const state = toStorageState(existing);
  expect(state.cookies).toHaveLength(1);
  expect(state.cookies[0].sameSite).toBe("None");
});

test("defaults invalid sameSite to Lax", () => {
  const state = toStorageState([{ name: "a", value: "b", domain: "d", path: "/", expires: -1, sameSite: "whatever" }]);
  expect(state.cookies[0].sameSite).toBe("Lax");
});

test("drops malformed cookies missing name/value/domain", () => {
  const state = toStorageState([{ name: "ok", value: "v", domain: "d" }, { value: "no-name" }, null]);
  expect(state.cookies).toHaveLength(1);
  expect(state.cookies[0].name).toBe("ok");
});

test("isLegacyFormat detects arrays", () => {
  expect(isLegacyFormat([])).toBe(true);
  expect(isLegacyFormat({ cookies: [], origins: [] })).toBe(false);
});
