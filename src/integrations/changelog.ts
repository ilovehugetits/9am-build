import Anthropic from "@anthropic-ai/sdk";
import chalk from "chalk";

interface CommitInfo {
  message: string;
  added: string[];
  removed: string[];
  modified: string[];
}

export interface ChangelogInput {
  repoName: string;
  commits: CommitInfo[];
  diff: string;
}

const MAX_DIFF_LENGTH = 15_000;
const MAX_DIFF_PER_FILE = 3_000;
const MAX_FILES_PER_COMMIT = 15;

const SYSTEM_PROMPT = `You write Discord changelogs for "9am studios", a FiveM server resource. From the git commits and diff, produce a short changelog for server owners and players.

Format:
- 1-6 bullets, each on its own line, each starting with "•"
- Order by impact: new features, then improvements, then fixes
- Start each bullet with a past-tense verb: Added, Improved, Fixed, Changed, Removed
- No emojis, no headers, no intro or outro — output only the bullets

Content:
- Describe what each change does for the person using the resource, in plain language
- Light technical detail is welcome when it helps: feature names, commands, config options, framework names (e.g. "Added QBox framework support", "Fixed /duty command not toggling"). Never mention file paths, function names, or code internals
- Merge closely related changes into one bullet
- Skip refactors, formatting, CI, version bumps, and dependency updates unless they change behavior
- Base the changelog only on what the commits and diff show — if the diff is truncated, do not guess at unseen changes`;

/**
 * Trims the raw diff to a budget by working per-file instead of a blind slice:
 * noise files (lockfiles, generated/binary assets) are dropped entirely, each
 * remaining file is capped, and whatever doesn't fit is summarized by name so
 * the model knows what it isn't seeing.
 */
function prepareDiff(diff: string): string {
  const NOISE_FILE = /(^|\/)(bun\.lock|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|.*\.(lock|min\.js|min\.css|map|png|jpg|jpeg|gif|webp|ico|ttf|woff2?))( |$)/;

  const sections = diff.split(/^(?=diff --git )/m).filter(Boolean);
  const kept: string[] = [];
  const omitted: string[] = [];
  let used = 0;

  for (const section of sections) {
    const fileName = section.match(/^diff --git a\/(\S+)/)?.[1] ?? "unknown";

    if (NOISE_FILE.test(fileName) || section.includes("Binary files")) continue;

    const chunk =
      section.length > MAX_DIFF_PER_FILE
        ? section.slice(0, MAX_DIFF_PER_FILE) + "\n... (file diff truncated)\n"
        : section;

    if (used + chunk.length > MAX_DIFF_LENGTH) {
      omitted.push(fileName);
      continue;
    }

    kept.push(chunk);
    used += chunk.length;
  }

  let result = kept.join("");
  if (omitted.length > 0) {
    result += `\n... (diff omitted for ${omitted.length} more file(s): ${omitted.join(", ")})`;
  }
  return result || diff.slice(0, MAX_DIFF_LENGTH);
}

function buildUserMessage(input: ChangelogInput, truncatedDiff: string): string {
  const commitSummary = input.commits
    .map((c) => {
      const files = [
        ...c.added.map((f) => `A ${f}`),
        ...c.removed.map((f) => `D ${f}`),
        ...c.modified.map((f) => `M ${f}`),
      ];
      const shown = files.slice(0, MAX_FILES_PER_COMMIT);
      if (files.length > MAX_FILES_PER_COMMIT) {
        shown.push(`... +${files.length - MAX_FILES_PER_COMMIT} more files`);
      }
      return `- ${c.message}${shown.length > 0 ? `\n  ${shown.join("\n  ")}` : ""}`;
    })
    .join("\n");

  return `Repository: ${input.repoName}

Commits (A=added, D=deleted, M=modified):
${commitSummary}

Diff:
\`\`\`diff
${truncatedDiff}
\`\`\`

Write the changelog.`;
}

async function generateViaAnthropic(input: ChangelogInput, truncatedDiff: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY!;
  const anthropic = new Anthropic({ apiKey });

  const response = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 1000,
    output_config: { effort: "medium" },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserMessage(input, truncatedDiff) }],
  });

  const { input_tokens, output_tokens } = response.usage;
  const inputCost = (input_tokens / 1_000_000) * 3;
  const outputCost = (output_tokens / 1_000_000) * 15;
  const totalCost = inputCost + outputCost;
  console.log(
    chalk.gray(
      `[Changelog] Anthropic API: ${input_tokens} input + ${output_tokens} output = ${input_tokens + output_tokens} tokens ($${totalCost.toFixed(6)})`
    )
  );

  const textBlock = response.content.find((block) => block.type === "text");
  return textBlock?.text ?? "• Minor updates.";
}

async function generateViaOpenRouter(input: ChangelogInput, truncatedDiff: string): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY!;
  const model = process.env.OPENROUTER_MODEL ?? "anthropic/claude-sonnet-5";

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1000,
      reasoning: { effort: "medium" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserMessage(input, truncatedDiff) },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter API error (${response.status}): ${text}`);
  }

  const data = await response.json() as any;

  const usage = data.usage;
  if (usage) {
    console.log(
      chalk.gray(
        `[Changelog] OpenRouter API (${model}): ${usage.prompt_tokens} input + ${usage.completion_tokens} output = ${usage.prompt_tokens + usage.completion_tokens} tokens`
      )
    );
  }

  return data.choices?.[0]?.message?.content ?? "• Minor updates.";
}

export async function generateChangelog(input: ChangelogInput): Promise<string> {
  const hasOpenRouter = !!process.env.OPENROUTER_API_KEY;
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;

  if (!hasOpenRouter && !hasAnthropic) {
    throw new Error("Neither OPENROUTER_API_KEY nor ANTHROPIC_API_KEY is set.");
  }

  const truncatedDiff = prepareDiff(input.diff);

  if (hasOpenRouter) {
    return generateViaOpenRouter(input, truncatedDiff);
  }

  return generateViaAnthropic(input, truncatedDiff);
}
