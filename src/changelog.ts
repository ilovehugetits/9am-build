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

const SYSTEM_PROMPT = `You are a changelog writer for a FiveM game server resource called "9am studios". Analyze the provided git commits and code diff, then write a brief, user-facing changelog in English.

Rules:
- Write 1-5 short bullet points summarizing the changes
- Each bullet point should start with a bullet character (•)
- Do NOT use emojis anywhere in the changelog
- Focus on what changed from the user's perspective, not implementation details
- Use simple, clear language (e.g. "• Added commission system", "• Fixed vehicle spawning bug")
- Do not mention file names, function names, or technical details
- If changes are minor (typos, formatting, config tweaks), write "• Minor fixes and improvements"
- Return ONLY the bullet points, no headers or extra text`;

export async function generateChangelog(input: ChangelogInput): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set.");
  }

  const anthropic = new Anthropic({ apiKey });

  const truncatedDiff =
    input.diff.length > MAX_DIFF_LENGTH
      ? input.diff.slice(0, MAX_DIFF_LENGTH) + "\n... (truncated)"
      : input.diff;

  const commitSummary = input.commits
    .map((c) => {
      const files = [
        ...c.added.map((f) => `+ ${f}`),
        ...c.removed.map((f) => `- ${f}`),
        ...c.modified.map((f) => `~ ${f}`),
      ].join("\n");
      return `Commit: ${c.message}\nFiles:\n${files}`;
    })
    .join("\n\n");

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 300,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Repository: ${input.repoName}\n\nCommits:\n${commitSummary}\n\nCode diff:\n\`\`\`\n${truncatedDiff}\n\`\`\``,
      },
    ],
  });

  const { input_tokens, output_tokens } = response.usage;
  const inputCost = (input_tokens / 1_000_000) * 3;
  const outputCost = (output_tokens / 1_000_000) * 15;
  const totalCost = inputCost + outputCost;
  console.log(
    chalk.gray(
      `[Changelog] API usage: ${input_tokens} input + ${output_tokens} output = ${input_tokens + output_tokens} tokens ($${totalCost.toFixed(6)})`
    )
  );

  const textBlock = response.content.find((block) => block.type === "text");
  return textBlock?.text ?? "• Minor updates.";
}
