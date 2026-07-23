import { readFileSync } from "fs";
import path from "path";
import chalk from "chalk";
import type { RunSummary, TestResult } from "./types.js";

const FRAME_RE = /^(.+?):(\d+):/;
const CONTEXT_LINES = 2;

/** Pull `path:line` out of the first traceback frame that points at a file. */
function primaryFrame(test: TestResult): { file: string; line: number } | null {
  for (const frame of test.traceback ?? []) {
    const match = FRAME_RE.exec(frame);
    if (!match) continue;
    const file = match[1].trim();
    // "[C]" is a native frame; a leading "..." means Lua truncated a long
    // chunk name, so the path cannot be resolved back to a real file.
    if (file.startsWith("[") || file.startsWith("...")) continue;
    return { file, line: Number(match[2]) };
  }
  // No usable frame: fall back to the it() location so there is always an anchor.
  return test.line > 0 ? { file: test.file, line: test.line } : null;
}

function sourceExcerpt(root: string, file: string, line: number): string[] {
  let content: string;
  try {
    content = readFileSync(path.join(root, file), "utf-8");
  } catch {
    return [];
  }
  const lines = content.split(/\r?\n/);
  if (line < 1 || line > lines.length) return [];

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

const pad = (label: string) => label.padEnd(11);

function renderFailure(test: TestResult, root: string): string[] {
  const out: string[] = [];

  if (test.status === "fail") {
    out.push(`  ${pad("matcher")}${test.matcher ?? "unknown"}`);
    out.push(`  ${pad("expected")}${test.expected ?? ""}`);
    out.push(`  ${pad("actual")}${test.actual ?? ""}`);
    if (test.message) out.push(`  ${pad("message")}${test.message}`);
  } else {
    out.push(`  ${pad("error")}${test.message ?? "unknown error"}`);
  }

  if (test.traceback?.length) {
    out.push("");
    out.push("  traceback");
    for (const frame of test.traceback) out.push(`    ${frame}`);
  }

  const frame = primaryFrame(test);
  if (frame) {
    const excerpt = sourceExcerpt(root, frame.file, frame.line);
    if (excerpt.length) {
      out.push("");
      out.push(`  source ${frame.file}:${frame.line}`);
      out.push(...excerpt);
    }
  }

  return out;
}

/**
 * Agent-first plain text: greppable `^FAIL` / `^PASS` anchors, every location a
 * `path:line` pair, no box drawing or status glyphs. Chalk drops colour
 * automatically when stdout is not a TTY, so piped output stays clean.
 */
export function renderText(summary: RunSummary): string {
  const out: string[] = [];
  const fileCount = summary.files.length;
  out.push(
    `${summary.resource} — ${fileCount} file${fileCount === 1 ? "" : "s"}, ` +
      `${summary.total} test${summary.total === 1 ? "" : "s"}  [${summary.runtime}]`
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
    `${summary.total} test${summary.total === 1 ? "" : "s"}`,
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
