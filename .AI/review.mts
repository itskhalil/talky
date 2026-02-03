import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";
import { createInterface } from "readline";

// --- Config ---

const SETTINGS_PATH = join(
  homedir(),
  "Library/Application Support/com.khalil.talky/settings_store.json"
);
const AI_DIR = import.meta.dirname!;
const RUNS_DIR = join(AI_DIR, "eval-runs");

interface Provider {
  id: string;
  base_url: string;
}

function loadSettings() {
  const raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
  const s = raw.settings;
  const providerId: string = s.post_process_provider_id;
  const provider: Provider = s.post_process_providers.find(
    (p: Provider) => p.id === providerId
  );
  const apiKey: string = s.post_process_api_keys[providerId] ?? "";
  const model: string = s.post_process_models[providerId] ?? "";
  return { provider, apiKey, model };
}

async function callLLM(
  provider: Provider,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userMessage: string
): Promise<string> {
  if (provider.id === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 8192,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as any;
    return data.content[0].text;
  }

  const res = await fetch(`${provider.base_url}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    }),
  });
  if (!res.ok) throw new Error(`API error: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as any;
  return data.choices[0].message.content;
}

// --- Readline helpers ---

function createRL() {
  return createInterface({ input: process.stdin, output: process.stdout });
}

function ask(rl: ReturnType<typeof createRL>, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

// --- Run discovery ---

function getLatestRun(): string | null {
  if (!existsSync(RUNS_DIR)) return null;
  const dirs = readdirSync(RUNS_DIR).sort();
  return dirs.length ? dirs[dirs.length - 1] : null;
}

interface RunData {
  name: string;
  runDir: string;
  meta: { model: string; provider: string; samples: number; timestamp: string };
  examples: Map<string, { outputs: string[]; scores: any[] }>;
}

const DIMS = ["voice", "density", "clarity", "readability", "additions", "tagging"] as const;

function loadRun(runName: string): RunData {
  const runDir = join(RUNS_DIR, runName);
  const metaPath = join(runDir, "meta.json");
  const meta = existsSync(metaPath)
    ? JSON.parse(readFileSync(metaPath, "utf-8"))
    : { model: "unknown", provider: "unknown", samples: 1, timestamp: runName };

  const files = readdirSync(runDir);
  const mdFiles = files.filter((f) => f.endsWith(".md") && f !== "summary.md" && f !== "feedback.md");

  // Group by example name (strip _N suffix and .md)
  const examples = new Map<string, { outputs: string[]; scores: any[] }>();

  for (const mdFile of mdFiles) {
    const base = mdFile.replace(/\.md$/, "");
    // Match name_N or just name
    const match = base.match(/^(.+?)(?:_(\d+))?$/);
    if (!match) continue;
    const exName = match[1];
    const sampleIdx = match[2] ? parseInt(match[2], 10) - 1 : 0;

    if (!examples.has(exName)) {
      examples.set(exName, { outputs: [], scores: [] });
    }
    const ex = examples.get(exName)!;

    // Read output
    ex.outputs[sampleIdx] = readFileSync(join(runDir, mdFile), "utf-8");

    // Read scores
    const scoresFile = `${base}.scores.json`;
    if (files.includes(scoresFile)) {
      ex.scores[sampleIdx] = JSON.parse(readFileSync(join(runDir, scoresFile), "utf-8"));
    }
  }

  return { name: runName, runDir, meta, examples };
}

function formatScoreLine(scores: any): string {
  return DIMS.map((d) => `${d}=${scores[d]?.score ?? "?"}`).join(" ");
}

function avgScore(scoresList: any[], dim: string): number | null {
  const vals = scoresList.map((s) => s[dim]?.score).filter((v) => typeof v === "number");
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

// --- Main ---

export async function review(runNameOverride?: string) {
  const runArg = runNameOverride ?? process.argv[2];
  const runName = runArg || getLatestRun();

  if (!runName) {
    console.error("No eval runs found. Run eval.mts first.");
    process.exit(1);
  }

  const run = loadRun(runName);
  const numSamples = run.meta.samples;

  console.log(`\nReviewing run: ${run.name} (${numSamples} sample${numSamples > 1 ? "s" : ""}/example)`);
  console.log(`Model: ${run.meta.model} | Provider: ${run.meta.provider}\n`);

  const rl = createRL();
  const humanReview: Record<string, { score: number | null; notes: string; aiAvg: number | null }> = {};

  for (const [exName, data] of run.examples) {
    console.log(`\n${"━".repeat(3)} ${exName} ${"━".repeat(Math.max(1, 40 - exName.length))}`);

    for (let i = 0; i < data.outputs.length; i++) {
      if (numSamples > 1) {
        console.log(`\nSample ${i + 1}:`);
      }

      // Print truncated output (first 60 lines)
      const lines = data.outputs[i].split("\n");
      const preview = lines.slice(0, 60).join("\n");
      console.log(preview);
      if (lines.length > 60) console.log(`  ... (${lines.length - 60} more lines)`);

      if (data.scores[i]) {
        console.log(`  AI: ${formatScoreLine(data.scores[i])}`);
      }
    }

    const aiAvg = avgScore(data.scores, "overall");
    console.log(`\n  AI avg overall: ${aiAvg !== null ? aiAvg.toFixed(1) : "?"}`);

    const scoreInput = await ask(rl, "Your score (1-5, enter to skip): ");
    const score = scoreInput.trim() ? parseInt(scoreInput.trim(), 10) : null;
    const notes = await ask(rl, "Notes (enter to skip): ");

    humanReview[exName] = { score, notes: notes.trim(), aiAvg };
  }

  // Summary table
  console.log(`\n${"━".repeat(3)} Summary ${"━".repeat(35)}`);
  console.log("| Example | AI avg | Human | Notes |");
  console.log("| --- | --- | --- | --- |");
  for (const [exName, review] of Object.entries(humanReview)) {
    const aiStr = review.aiAvg !== null ? review.aiAvg.toFixed(1) : "?";
    const humanStr = review.score !== null ? String(review.score) : "-";
    const notesStr = review.notes.slice(0, 50);
    console.log(`| ${exName} | ${aiStr} | ${humanStr} | ${notesStr} |`);
  }

  // Compare with previous run
  const allRuns = readdirSync(RUNS_DIR).sort();
  const currentIdx = allRuns.indexOf(run.name);
  if (currentIdx > 0) {
    const prevRunName = allRuns[currentIdx - 1];
    const prevReviewPath = join(RUNS_DIR, prevRunName, "human-review.json");
    if (existsSync(prevReviewPath)) {
      const prevReview = JSON.parse(readFileSync(prevReviewPath, "utf-8"));
      const prevScores = Object.values(prevReview.reviews as Record<string, any>)
        .map((r: any) => r.score)
        .filter((v) => typeof v === "number");
      const curScores = Object.values(humanReview)
        .map((r) => r.score)
        .filter((v): v is number => v !== null);

      if (prevScores.length && curScores.length) {
        const prevAvg = prevScores.reduce((a, b) => a + b, 0) / prevScores.length;
        const curAvg = curScores.reduce((a, b) => a + b, 0) / curScores.length;
        const delta = curAvg - prevAvg;
        console.log(`\nvs previous run (${prevRunName}): overall Δ ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}`);
      }
    }
  }

  // Prompt suggestions
  const suggestInput = await ask(rl, "\nWant Claude to suggest prompt edits based on your feedback? (y/n): ");

  let suggestions: string | null = null;

  if (suggestInput.trim().toLowerCase() === "y") {
    console.log("\nGenerating suggestions...\n");

    const { provider, apiKey, model } = loadSettings();
    const currentPrompt = readFileSync(join(run.runDir, "prompt.txt"), "utf-8");

    // Gather low-scoring examples and feedback
    let feedbackContext = "";
    for (const [exName, review] of Object.entries(humanReview)) {
      const data = run.examples.get(exName);
      if (!data) continue;

      feedbackContext += `\n## ${exName}\n`;
      feedbackContext += `Human score: ${review.score ?? "not scored"}\n`;
      feedbackContext += `Notes: ${review.notes || "(none)"}\n`;
      feedbackContext += `AI avg overall: ${review.aiAvg?.toFixed(1) ?? "?"}\n`;

      // Include outputs for low-scoring examples
      if (review.score !== null && review.score <= 3) {
        for (let i = 0; i < data.outputs.length; i++) {
          feedbackContext += `\nSample ${i + 1} output (first 2000 chars):\n${data.outputs[i].slice(0, 2000)}\n`;
        }
      }
    }

    const suggestSystem = `You are a prompt engineering expert. Given the current system prompt and human review feedback, suggest specific edits to improve the prompt. Be concrete: quote the exact lines to change and provide replacement text. Keep suggestions focused and actionable.`;
    const suggestMessage = `## Current Prompt\n${currentPrompt}\n\n## Human Review Feedback\n${feedbackContext}`;

    suggestions = await callLLM(provider, apiKey, model, suggestSystem, suggestMessage);
    console.log(suggestions);
  }

  rl.close();

  // Save human review
  const reviewData = {
    run: run.name,
    timestamp: new Date().toISOString(),
    reviews: humanReview,
    suggestions,
  };
  const reviewPath = join(run.runDir, "human-review.json");
  writeFileSync(reviewPath, JSON.stringify(reviewData, null, 2));
  console.log(`\nSaved to ${reviewPath}`);
}

// Allow direct execution
const isDirectRun = process.argv[1]?.endsWith("review.mts");
if (isDirectRun) {
  review().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
