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
const USER_TEMPLATE_PATH = join(
  AI_DIR,
  "../src-tauri/resources/prompts/enhance_notes_user.txt",
);
const EXAMPLES_DIR = join(AI_DIR, "Examples");

interface Provider {
  id: string;
  base_url: string;
}

interface ModelEnvironment {
  id: string;
  name: string;
  api_key: string;
  base_url: string;
  chat_model: string;
  summarisation_model: string;
}

function loadSettings() {
  const raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
  const s = raw.settings;
  const defaultEnvId: string = s.default_environment_id;
  const env: ModelEnvironment = s.model_environments.find(
    (e: ModelEnvironment) => e.id === defaultEnvId,
  );
  if (!env) throw new Error(`Default environment ${defaultEnvId} not found`);
  const provider: Provider = { id: env.name.toLowerCase(), base_url: env.base_url };
  const apiKey: string = env.api_key;
  const model: string = env.summarisation_model;
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
      samples: { type: "string", default: "2" },
      example: { type: "string" },
    },
  });
  const numSamples = Math.max(1, parseInt(values.samples!, 10));

  const { provider, apiKey, model } = loadSettings();
  const systemPrompt = readFileSync(PROMPT_PATH, "utf-8");
  const userTemplate = readFileSync(USER_TEMPLATE_PATH, "utf-8");
  let examples = loadExamples();
  if (values.example) {
    const filter = values.example.toLowerCase();
    examples = examples.filter((e) => e.name.toLowerCase().includes(filter));
    if (examples.length === 0) {
      console.error(`No examples matching "${values.example}"`);
      process.exit(1);
    }
  }

  console.log(
    `Provider: ${provider.id} | Model: ${model} | Samples: ${numSamples}`,
  );
  console.log(`Examples: ${examples.map((e) => e.name).join(", ")}\n`);

  // Create run directory
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runDir = join(AI_DIR, "eval-runs", timestamp);
  mkdirSync(runDir, { recursive: true });

  // Snapshot prompt and metadata
  writeFileSync(join(runDir, "prompt.txt"), `=== SYSTEM PROMPT ===\n${systemPrompt}\n\n=== USER TEMPLATE ===\n${userTemplate}`);
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
  // Word counts: goldenWords[exName], outputWords[exName][sampleIdx]
  const goldenWords: Record<string, number> = {};
  const outputWords: Record<string, number[]> = {};

  // Run all examples in parallel
  await Promise.all(
    examples.map(async (ex) => {
      console.log(`--- ${ex.name} ---`);
      allScores[ex.name] = [];
      outputWords[ex.name] = [];
      goldenWords[ex.name] = ex.golden.split(/\s+/).filter(Boolean).length;

      const notesSection = ex.notes?.trim()
        ? ex.notes
        : "No notes were taken.";
      const userMessage = `<user_notes>\n${notesSection}\n</user_notes>\n\n<transcript>\n${ex.transcript}\n</transcript>\n\n${userTemplate}`;

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
          systemPrompt,
          userMessage,
        );
        writeFileSync(join(runDir, `${label}.md`), output);
        const wc = output.split(/\s+/).filter(Boolean).length;
        outputWords[ex.name].push(wc);

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
        console.log(`  [${ex.name}] Scores: ${scoreStr} | words: ${wc} (golden: ${goldenWords[ex.name]})\n`);
      }
    }),
  );

  // Write summary
  let summary = `# Eval Run: ${timestamp}\n\n`;
  summary += `**Model:** ${model}  \n**Provider:** ${provider.id}  \n**Samples:** ${numSamples}\n\n`;

  if (numSamples > 1) {
    // Per-sample detail
    summary += `## Per-Sample Scores\n\n`;
    summary += `| Example | Sample | ${DIMS.join(" | ")} | words | golden |\n`;
    summary += `| --- | --- | ${DIMS.map(() => "---").join(" | ")} | --- | --- |\n`;
    for (const ex of examples) {
      for (let s = 0; s < allScores[ex.name].length; s++) {
        const sc = allScores[ex.name][s];
        const row = DIMS.map((d) => sc[d]?.score ?? "?").join(" | ");
        summary += `| ${ex.name} | ${s + 1} | ${row} | ${outputWords[ex.name][s]} | ${goldenWords[ex.name]} |\n`;
      }
    }
    summary += `\n`;
  }

  // Averages table
  summary += `## ${numSamples > 1 ? "Averages" : "Scores"}\n\n`;
  summary += `| Example | ${DIMS.join(" | ")} | words | golden |\n`;
  summary += `| --- | ${DIMS.map(() => "---").join(" | ")} | --- | --- |\n`;

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
    const avgWords = outputWords[ex.name].length
      ? Math.round(outputWords[ex.name].reduce((a, b) => a + b, 0) / outputWords[ex.name].length)
      : "?";
    summary += `| ${ex.name} | ${row} | ${avgWords} | ${goldenWords[ex.name]} |\n`;
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
  const allOutputWords = examples.flatMap((e) => outputWords[e.name]);
  const allGoldenWords = examples.map((e) => goldenWords[e.name]);
  const avgOutputWords = allOutputWords.length ? Math.round(allOutputWords.reduce((a, b) => a + b, 0) / allOutputWords.length) : "?";
  const avgGoldenWords = allGoldenWords.length ? Math.round(allGoldenWords.reduce((a, b) => a + b, 0) / allGoldenWords.length) : "?";
  summary += `| **Average** | ${grandAvgs.join(" | ")} | ${avgOutputWords} | ${avgGoldenWords} |\n`;

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
