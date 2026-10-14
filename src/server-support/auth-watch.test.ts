import { test, expect } from "bun:test";
import { forumSessionStatus } from "./auth-watch.js";
import type { StorageState } from "../cfx/storage-state.js";

const NOW = Date.UTC(2026, 9, 15);
const DAY = 24 * 60 * 60;

function stateWithForumCookie(expires: number): StorageState {
  return {
    cookies: [
      { name: "jwt", value: "a", domain: "portal-api.cfx.re", path: "/", expires: NOW / 1000 + 90 * DAY, httpOnly: true, secure: true, sameSite: "Lax" },
      { name: "_t", value: "b", domain: "forum.cfx.re", path: "/", expires, httpOnly: true, secure: true, sameSite: "Lax" },
    ],
    origins: [],
  };
}

test("missing when there is no state or no forum cookie", () => {
  expect(forumSessionStatus(null, NOW).kind).toBe("missing");
  expect(forumSessionStatus({ cookies: [], origins: [] }, NOW).kind).toBe("missing");
  expect(forumSessionStatus(stateWithForumCookie(-1), NOW).kind).toBe("missing");
});

test("expired when the forum cookie is in the past", () => {
  expect(forumSessionStatus(stateWithForumCookie(NOW / 1000 - DAY), NOW).kind).toBe("expired");
});

test("expiring when fewer than 7 days are left", () => {
  const status = forumSessionStatus(stateWithForumCookie(NOW / 1000 + 3 * DAY), NOW);
  expect(status).toMatchObject({ kind: "expiring", daysLeft: 3 });
});

test("ok when 7 or more days are left", () => {
  const status = forumSessionStatus(stateWithForumCookie(NOW / 1000 + 30 * DAY), NOW);
  expect(status).toMatchObject({ kind: "ok", daysLeft: 30 });
});
