import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { getPreviousTag } from "./git.js";

let dir: string;

function git(...args: string[]): void {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdio: ["pipe", "pipe", "pipe"] });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

function commit(message: string): void {
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-q", "-m", message);
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "9am-git-"));
  git("init", "-q");
  commit("first");
  git("tag", "v1.0.0");
  commit("second");
});

afterEach(() => rm(dir, { recursive: true, force: true }));

test("finds the previous tag before the new release tag exists locally", () => {
  expect(getPreviousTag(dir, "v1.1.0")).toBe("v1.0.0");
});

test("skips the release tag itself when it already points at HEAD", () => {
  git("tag", "v1.1.0");
  expect(getPreviousTag(dir, "v1.1.0")).toBe("v1.0.0");
});

test("returns null when the repo has no other tag", () => {
  git("tag", "-d", "v1.0.0");
  expect(getPreviousTag(dir, "v1.1.0")).toBeNull();
});
