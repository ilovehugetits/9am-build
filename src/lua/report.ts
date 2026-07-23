import { readFileSync } from "fs";
import path from "path";
import chalk from "chalk";
import type { RunSummary, TestResult } from "./types.js";

const FRAME_RE = /^(.+?):(\d+):/;
const CONTEXT_LINES = 2;

/** Pull `path:line` out of the first traceback frame that points at a file. */
function primaryFrame(frames: string[] | undefined): { file: string; line: number } | null {
  for (const frame of frames ?? []) {
    const match = FRAME_RE.exec(frame);
    if (!match) continue;
    const file = match[1].trim();
    if (file === "[C]" || file.startsWith("[")) continue;
    return { file, line: Number(match[2]) };
  }
  return null;
}

function sourceExcerpt(root: string, file: string, line: number): string[] {
  let content: string;
  try {
    content = readFileSync(path.join(root, file), "utf-8");
  } catch {
    return [];
  }
  const lines = content.split(/\r?\n/);
  const from = Math.max(1, line - CONTEXT_LINES);
  const to = Math.min(lines.length, line + CONTEXT_LINES);
  const width = String(to).length;

  const out: string[] = [];
  for (let n = from; n <= to; n++) {
    const marker = n === line ? chalk.red(">") : " ";
    out.push(`    ${marker} ${String(n).padStart(width)} | ${lines[n - 1] ?? ""}`);
  }
  return out;
}

function pad(label: string): string {
  return label.padEnd(11);
}

function renderFailure(test: TestResult, root: string): string[] {
  const out: string[] = [];

  if (test.status === "fail") {
    out.push(`  ${pad("assertion")}${test.assertion ?? "unknown"}`);
    out.push(`  ${pad("expected")}${test.expected ?? ""}`);
    out.push(`  ${pad("actual")}${test.actual ?? ""}`);
  } else {
    out.push(`  ${pad("error")}${test.message ?? "unknown error"}`);
  }
  if (test.status === "fail" && test.message) {
    out.push(`  ${pad("message")}${test.message}`);
  }

  if (test.traceback?.length) {
    out.push("");
    out.push("  traceback");
    for (const frame of test.traceback) out.push(`    ${frame}`);
  }

  const frame = primaryFrame(test.traceback);
  if (frame) {
    const excerpt = sourceExcerpt(root, frame.file, frame.line);
    if (excerpt.length) {
      out.push("");
      out.push(`  source ${frame.file}:${frame.line}`);
      out.push(...excerpt);
    }
  }

  if (test.unstubbed?.length) {
    const width = Math.max(...test.unstubbed.map((u) => u.name.length));
    out.push("");
    out.push("  unstubbed globals read during this test");
    for (const u of test.unstubbed) {
      out.push(`    ${u.name.padEnd(width)}  ${u.at}`);
    }
  }

  return out;
}

/**
 * Agent-first plain text: greppable `^FAIL` / `^PASS` anchors, every location a
 * `path:line` pair, no box drawing or status glyphs. Chalk drops color
 * automatically when stdout is not a TTY, so piped output stays clean.
 */
export function renderText(summary: RunSummary): string {
  const out: string[] = [];
  out.push(
    `${summary.resource} — ${summary.files.length} file${summary.files.length === 1 ? "" : "s"}, ` +
      `${summary.tests.length} test${summary.tests.length === 1 ? "" : "s"}`
  );
  out.push("");

  for (const test of summary.tests) {
    const location = `${test.file}:${test.line}`;
    if (test.status === "pass") {
      out.push(`${chalk.green("PASS")} ${location}  ${test.name}  ${test.durationMs}ms`);
      continue;
    }
    out.push("");
    out.push(`${chalk.red("FAIL")} ${location}  ${test.name}`);
    out.push("");
    out.push(...renderFailure(test, summary.root));
    out.push("");
  }

  out.push("");
  const parts = [
    `${summary.tests.length} test${summary.tests.length === 1 ? "" : "s"}`,
    `${summary.passed} passed`,
    `${summary.failed} failed`,
    `${summary.durationMs}ms`,
  ];
  out.push(summary.failed > 0 ? chalk.red(parts.join("  ")) : chalk.green(parts.join("  ")));

  return out.join("\n");
}

export function renderJson(summary: RunSummary): string {
  return JSON.stringify(summary, null, 2);
}
