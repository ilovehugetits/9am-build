import { test, expect } from "bun:test";
import { parseManifestVersion } from "./manifest.js";

test("parses single-quoted version", () => {
  expect(parseManifestVersion("fx_version 'cerulean'\nversion '1.2.3'")).toBe("1.2.3");
});

test("parses double-quoted version", () => {
  expect(parseManifestVersion('version "0.0.1"')).toBe("0.0.1");
});

test("ignores fx_version and matches version line", () => {
  expect(parseManifestVersion("fx_version 'cerulean'\ngame 'gta5'\nversion '2.0.0'")).toBe("2.0.0");
});

test("returns null when absent", () => {
  expect(parseManifestVersion("game 'gta5'")).toBeNull();
});
