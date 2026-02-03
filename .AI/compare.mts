import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const RUNS_DIR = join(import.meta.dirname!, "eval-runs");

function usage() {
  console.log("Usage: node .AI/compare.mts <run1> <run2>");
  console.log("\nAvailable runs:");
  try {
    for (const d of readdirSync(RUNS_DIR).sort()) console.log(`  ${d}`);
  } catch {
    console.log("  (no runs yet)");
  }
  process.exit(1);
}

interface Scores {
  [dim: string]: { score: number; reasoning: string };
}

function loadScores(runDir: string): Record<string, Scores> {
  const result: Record<string, Scores> = {};
  for (const f of readdirSync(runDir)) {
    if (!f.endsWith(".scores.json")) continue;
    const name = f.replace(".scores.json", "");
    result[name] = JSON.parse(readFileSync(join(runDir, f), "utf-8"));
  }
  return result;
}

function main() {
  const [run1, run2] = process.argv.slice(2);
  if (!run1 || !run2) usage();

  const dir1 = join(RUNS_DIR, run1);
  const dir2 = join(RUNS_DIR, run2);

  const scores1 = loadScores(dir1);
  const scores2 = loadScores(dir2);

  const dims = ["voice", "density", "clarity", "readability", "additions", "tagging"];
  const allExamples = [...new Set([...Object.keys(scores1), ...Object.keys(scores2)])].sort();

  console.log(`\nComparing: ${run1} → ${run2}\n`);

  // Score comparison table
  console.log(`| Example | Dim | ${run1} | ${run2} | Δ |`);
  console.log(`| --- | --- | --- | --- | --- |`);

  const deltas: Record<string, number[]> = {};
  dims.forEach((d) => (deltas[d] = []));

  for (const ex of allExamples) {
    for (const d of dims) {
      const s1 = scores1[ex]?.[d]?.score;
      const s2 = scores2[ex]?.[d]?.score;
      if (s1 == null && s2 == null) continue;
      const delta = s1 != null && s2 != null ? s2 - s1 : NaN;
      const deltaStr = isNaN(delta) ? "?" : (delta > 0 ? "+" : "") + delta;
      if (!isNaN(delta)) deltas[d].push(delta);
      console.log(`| ${ex} | ${d} | ${s1 ?? "?"} | ${s2 ?? "?"} | ${deltaStr} |`);
    }
  }

  // Average deltas
  console.log("\n**Average Δ per dimension:**");
  for (const d of dims) {
    const vals = deltas[d];
    if (vals.length === 0) continue;
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sign = avg > 0 ? "+" : "";
    console.log(`  ${d}: ${sign}${avg.toFixed(1)}`);
  }

  // Text diff hint
  console.log("\n**To diff outputs:**");
  for (const ex of allExamples) {
    console.log(`  diff "${join(dir1, ex + ".md")}" "${join(dir2, ex + ".md")}"`);
  }
}

main();
