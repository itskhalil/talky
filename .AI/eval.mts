import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  existsSync,
} from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import { parseArgs } from "util";
import { review } from "./review.mts";

// --- Config ---

const SETTINGS_PATH = join(
  homedir(),
  "Library/Application Support/com.khalil.talky/settings_store.json",
);
const AI_DIR = import.meta.dirname!;
const PROMPT_PATH = join(
  AI_DIR,
  "../src-tauri/resources/prompts/enhance_notes.txt",
);
const EXAMPLES_DIR = join(AI_DIR, "Examples");

interface Provider {
  id: string;
  base_url: string;
}

function loadSettings() {
  const raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
  const s = raw.settings;
  const providerId: string = s.post_process_provider_id;
  const provider: Provider = s.post_process_providers.find(
    (p: Provider) => p.id === providerId,
  );
  const apiKey: string = s.post_process_api_keys[providerId] ?? "";
  const model: string = s.post_process_models[providerId] ?? "";
  return { provider, apiKey, model };
}

// --- LLM Call ---

async function callLLM(
  provider: Provider,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userMessage: string,
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
    if (!res.ok)
      throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as any;
    return data.content[0].text;
  }

  // OpenAI-compatible providers
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

// --- Judge ---

const JUDGE_SYSTEM = `You evaluate AI-enhanced meeting notes. The goal is notes that feel like the USER wrote them—enhanced, not replaced.

**The test:** Does this read like the user's own notes with helpful additions? Or like an AI summary of the transcript?

Before scoring, list specific problems you find. Then score 1-5 on:

1. **Voice** — Does it sound like the user?
   - 5: Same vocabulary, tone, and style as user's notes
   - 3: Some AI-ification of language or phrasing
   - 1: Sounds like a different person wrote it

2. **Density** — Terse bullets, not prose?
   - 5: Compressed facts, scannable
   - 3: Some verbose sections
   - 1: Essay-style paragraphs
   - PENALIZE: meta-descriptions ("talked about X", "discussed X", "covered X" — just say X), "the team", full sentences

3. **Clarity** — Simple, direct language?
   - 5: Plain words, no jargon
   - 3: Some corporate/AI-speak
   - 1: Reads like a consultant wrote it
   - PENALIZE: "leverage", "facilitate", "comprehensive", "ensure", "utilize"

4. **Readability** — Clean hierarchy, easy to scan?
   - 5: Logical nesting, appropriate sections
   - 3: Usable but cluttered or flat
   - 1: Over-fragmented with separators, or wall of text
   - NOTE: [ai]-tagged sections/headers are fine — that's proper attribution, not clutter

5. **Additions** — Do [ai] lines add genuinely useful context?
   - 5: Surfaces things user would want but missed
   - 3: Mix of useful and filler
   - 1: Obvious or redundant

6. **Tagging** — Is attribution correct? (Every line must be tagged)
   - 5: All lines correctly attributed
   - 3: Mostly correct, some misattributions
   - 1: Frequent wrong labels or missing tags

Respond with JSON:
{
  "problems": ["...", "..."],
  "voice": { "score": N, "reasoning": "..." },
  "density": { "score": N, "reasoning": "..." },
  "clarity": { "score": N, "reasoning": "..." },
  "readability": { "score": N, "reasoning": "..." },
  "additions": { "score": N, "reasoning": "..." },
  "tagging": { "score": N, "reasoning": "..." }
}`;

function buildJudgeMessage(
  userNotes: string | null,
  transcript: string,
  golden: string,
  output: string,
): string {
  return `## USER'S ORIGINAL NOTES
${userNotes ?? "(no notes taken)"}

## TRANSCRIPT (first 3000 chars)
${transcript.slice(0, 3000)}

## GOLDEN REFERENCE
${golden}

## MODEL OUTPUT TO JUDGE
${output}`;
}

// --- Main ---

interface ExampleData {
  name: string;
  transcript: string;
  notes: string | null;
  golden: string;
}

function loadExamples(): ExampleData[] {
  const examples: ExampleData[] = [];
  for (const dir of readdirSync(EXAMPLES_DIR)) {
    const exDir = join(EXAMPLES_DIR, dir);
    const files = readdirSync(exDir);
    const transcriptFile = files.find(
      (f) => f.includes("transcript") && !f.endsWith(".png"),
    );
    const enhancedFile = files.find((f) => f.includes("enhanced"));
    const notesFile = files.find(
      (f) => f.includes("notes") && !f.endsWith(".png"),
    );

    if (!transcriptFile || !enhancedFile) {
      console.warn(`Skipping ${dir}: missing transcript or enhanced file`);
      continue;
    }

    examples.push({
      name: dir,
      transcript: readFileSync(join(exDir, transcriptFile), "utf-8"),
      notes: notesFile ? readFileSync(join(exDir, notesFile), "utf-8") : null,
      golden: readFileSync(join(exDir, enhancedFile), "utf-8"),
    });
  }
  return examples;
}

const DIMS = [
  "voice",
  "density",
  "clarity",
  "readability",
  "additions",
  "tagging",
] as const;

function parseScores(judgeRaw: string, label: string): any {
  try {
    const jsonMatch = judgeRaw.match(/\{[\s\S]*\}/);
    return JSON.parse(jsonMatch![0]);
  } catch {
    console.warn(`  Failed to parse judge response for ${label}`);
    return { raw: judgeRaw };
  }
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      samples: { type: "string", default: "1" },
    },
  });
  const numSamples = Math.max(1, parseInt(values.samples!, 10));

  const { provider, apiKey, model } = loadSettings();
  const prompt = readFileSync(PROMPT_PATH, "utf-8");
  const examples = loadExamples();

  console.log(
    `Provider: ${provider.id} | Model: ${model} | Samples: ${numSamples}`,
  );
  console.log(`Examples: ${examples.map((e) => e.name).join(", ")}\n`);

  // Create run directory
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runDir = join(AI_DIR, "eval-runs", timestamp);
  mkdirSync(runDir, { recursive: true });

  // Snapshot prompt and metadata
  writeFileSync(join(runDir, "prompt.txt"), prompt);
  writeFileSync(
    join(runDir, "meta.json"),
    JSON.stringify(
      { model, provider: provider.id, samples: numSamples, timestamp },
      null,
      2,
    ),
  );

  // allScores[exName][sampleIdx] = scores object
  const allScores: Record<string, any[]> = {};

  // Run all examples in parallel
  await Promise.all(
    examples.map(async (ex) => {
      console.log(`--- ${ex.name} ---`);
      allScores[ex.name] = [];

      const notesSection = ex.notes?.trim()
        ? ex.notes
        : "No notes were taken. Generate concise notes from the transcript, marking all lines as [ai].";
      const userMessage = `## MEETING CONTEXT\nTitle: ${ex.name}\nDuration: unknown\n\n## USER'S NOTES\n${notesSection}\n\n## TRANSCRIPT\n${ex.transcript}`;

      for (let s = 1; s <= numSamples; s++) {
        const suffix = numSamples > 1 ? `_${s}` : "";
        const label = `${ex.name}${suffix}`;

        console.log(
          `  [${ex.name}] Generating${numSamples > 1 ? ` sample ${s}/${numSamples}` : ""}...`,
        );
        const output = await callLLM(
          provider,
          apiKey,
          model,
          prompt,
          userMessage,
        );
        writeFileSync(join(runDir, `${label}.md`), output);

        console.log(
          `  [${ex.name}] Judging${numSamples > 1 ? ` sample ${s}` : ""}...`,
        );
        const judgeMsg = buildJudgeMessage(
          ex.notes,
          ex.transcript,
          ex.golden,
          output,
        );
        const judgeRaw = await callLLM(
          provider,
          apiKey,
          model,
          JUDGE_SYSTEM,
          judgeMsg,
        );
        const scores = parseScores(judgeRaw, label);

        writeFileSync(
          join(runDir, `${label}.scores.json`),
          JSON.stringify(scores, null, 2),
        );
        allScores[ex.name].push(scores);

        const scoreStr = DIMS.map(
          (d) => `${d}=${scores[d]?.score ?? "?"}`,
        ).join(" ");
        console.log(`  [${ex.name}] Scores: ${scoreStr}\n`);
      }
    }),
  );

  // Write summary
  let summary = `# Eval Run: ${timestamp}\n\n`;
  summary += `**Model:** ${model}  \n**Provider:** ${provider.id}  \n**Samples:** ${numSamples}\n\n`;

  if (numSamples > 1) {
    // Per-sample detail
    summary += `## Per-Sample Scores\n\n`;
    summary += `| Example | Sample | ${DIMS.join(" | ")} |\n`;
    summary += `| --- | --- | ${DIMS.map(() => "---").join(" | ")} |\n`;
    for (const ex of examples) {
      for (let s = 0; s < allScores[ex.name].length; s++) {
        const sc = allScores[ex.name][s];
        const row = DIMS.map((d) => sc[d]?.score ?? "?").join(" | ");
        summary += `| ${ex.name} | ${s + 1} | ${row} |\n`;
      }
    }
    summary += `\n`;
  }

  // Averages table
  summary += `## ${numSamples > 1 ? "Averages" : "Scores"}\n\n`;
  summary += `| Example | ${DIMS.join(" | ")} |\n`;
  summary += `| --- | ${DIMS.map(() => "---").join(" | ")} |\n`;

  for (const ex of examples) {
    const samples = allScores[ex.name];
    const row = DIMS.map((d) => {
      const vals = samples
        .map((sc) => sc[d]?.score)
        .filter((v) => typeof v === "number");
      return vals.length
        ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1)
        : "?";
    }).join(" | ");
    summary += `| ${ex.name} | ${row} |\n`;
  }

  // Grand averages
  const grandAvgs = DIMS.map((d) => {
    const vals = examples.flatMap((e) =>
      allScores[e.name]
        .map((sc) => sc[d]?.score)
        .filter((v) => typeof v === "number"),
    );
    return vals.length
      ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1)
      : "?";
  });
  summary += `| **Average** | ${grandAvgs.join(" | ")} |\n`;

  writeFileSync(join(runDir, "summary.md"), summary);
  writeFileSync(join(runDir, "feedback.md"), "");

  console.log(`Results saved to: ${runDir}`);
  console.log(`\n${summary}`);

  // Automatically start interactive review
  await review(timestamp);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
