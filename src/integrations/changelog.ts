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

function buildUserMessage(input: ChangelogInput, truncatedDiff: string): string {
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

  return `Repository: ${input.repoName}\n\nCommits:\n${commitSummary}\n\nCode diff:\n\`\`\`\n${truncatedDiff}\n\`\`\``;
}

async function generateViaAnthropic(input: ChangelogInput, truncatedDiff: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY!;
  const anthropic = new Anthropic({ apiKey });

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 300,
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
  const model = process.env.OPENROUTER_MODEL ?? "anthropic/claude-sonnet-4.6";

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 300,
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

  const truncatedDiff =
    input.diff.length > MAX_DIFF_LENGTH
      ? input.diff.slice(0, MAX_DIFF_LENGTH) + "\n... (truncated)"
      : input.diff;

  if (hasOpenRouter) {
    return generateViaOpenRouter(input, truncatedDiff);
  }

  return generateViaAnthropic(input, truncatedDiff);
}
