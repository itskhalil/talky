import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_PATH = join(__dirname, 'results.json');
const RESULTS_DIR = join(__dirname, 'results');
const SUMMARY_PATH = join(RESULTS_DIR, 'summary.md');

const DIMS = ['voice', 'density', 'clarity', 'readability', 'additions', 'conciseness'];
const JUDGE_DIMS = ['voice', 'density', 'clarity', 'readability', 'additions'];

const wordCount = (s) => s.split(/\s+/).filter(Boolean).length;
const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
const median = (arr) => {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

// --- Load and group results ---

const data = JSON.parse(readFileSync(RESULTS_PATH, 'utf-8'));
const results = data.results.results;

// Ordered by config/appearance index, deduplicated
const variantMap = new Map(); // promptIdx -> label
const testCaseOrder = new Map(); // description -> first testIdx
for (const r of results) {
  if (!variantMap.has(r.promptIdx)) variantMap.set(r.promptIdx, r.prompt.label);
  if (!testCaseOrder.has(r.testCase.description)) testCaseOrder.set(r.testCase.description, r.testIdx);
}
const variants = [...variantMap.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
const testCases = [...testCaseOrder.entries()].sort((a, b) => a[1] - b[1]).map(e => e[0]);

// Group: grouped[testCase][variant] = [result, ...]
const grouped = {};
for (const r of results) {
  const tc = r.testCase.description;
  const v = r.prompt.label;
  grouped[tc] ??= {};
  grouped[tc][v] ??= [];
  grouped[tc][v].push(r);
}

const repeatCount = grouped[testCases[0]]?.[variants[0]]?.length ?? 1;

// --- Score Matrix ---

function buildScoreMatrix() {
  let md = `## Score Matrix (weighted avg, ${repeatCount} repeats)\n\n`;

  md += `| Test Case | ${variants.join(' | ')} |\n`;
  md += `|---|${variants.map(() => '---').join('|')}|\n`;

  const variantTotals = Object.fromEntries(variants.map(v => [v, []]));

  for (const tc of testCases) {
    const cells = variants.map(v => {
      const runs = grouped[tc]?.[v] ?? [];
      if (runs.length === 0) return '—';
      const score = avg(runs.map(r => r.score));
      variantTotals[v].push(score);
      return score.toFixed(3);
    });
    md += `| ${tc} | ${cells.join(' | ')} |\n`;
  }

  const avgCells = variants.map(v => {
    const scores = variantTotals[v];
    return scores.length > 0 ? `**${avg(scores).toFixed(3)}**` : '—';
  });
  md += `| **Average** | ${avgCells.join(' | ')} |\n`;

  return md;
}

// --- Dimension Averages ---

function buildDimAverages() {
  let md = '## Dimension Averages\n\n';

  md += `| Dimension | ${variants.join(' | ')} |\n`;
  md += `|---|${variants.map(() => '---').join('|')}|\n`;

  for (const dim of DIMS) {
    const cells = variants.map(v => {
      const scores = [];
      for (const tc of testCases) {
        for (const r of (grouped[tc]?.[v] ?? [])) {
          const s = r.gradingResult?.namedScores?.[dim];
          if (typeof s === 'number') scores.push(s);
        }
      }
      if (scores.length === 0) return '—';
      // Judge dims are stored as 0-1, display as x/5; conciseness is 0-1 ratio
      return dim === 'conciseness'
        ? avg(scores).toFixed(2)
        : (avg(scores) * 5).toFixed(1);
    });
    md += `| ${dim} | ${cells.join(' | ')} |\n`;
  }

  return md;
}

// --- Bullet Stats ---

function analyseBullets(text) {
  const lines = text.split('\n');
  const bulletLines = lines.filter(l => /^\s*- /.test(l));
  const bulletWordCounts = bulletLines.map(l => wordCount(l.replace(/^\s*- /, '')));
  return {
    totalWords: wordCount(text),
    numBullets: bulletLines.length,
    avgWords: bulletWordCounts.length > 0 ? avg(bulletWordCounts) : 0,
    medWords: median(bulletWordCounts),
    maxWords: bulletWordCounts.length > 0 ? Math.max(...bulletWordCounts) : 0,
  };
}

function buildBulletStats() {
  let md = '## Bullet Stats (per-variant averages)\n\n';

  const hdr = '| Variant | Words | Bullets | Avg w/bullet | Med w/bullet | Max w/bullet |';
  const sep = '|---|---:|---:|---:|---:|---:|';

  for (const tc of testCases) {
    const goldenText = grouped[tc]?.[variants[0]]?.[0]?.vars?.golden
      ?? grouped[tc]?.[variants[0]]?.[0]?.testCase?.vars?.golden ?? '';
    const goldenWords = wordCount(goldenText);
    md += `### ${tc} (golden ${goldenWords}w)\n\n${hdr}\n${sep}\n`;

    for (const v of variants) {
      const runs = grouped[tc]?.[v] ?? [];
      if (runs.length === 0) continue;
      const stats = runs.map(r => analyseBullets(r.response?.output ?? ''));
      const a = (fn) => avg(stats.map(fn));
      md += `| ${v} | ${a(s => s.totalWords).toFixed(0)} | ${a(s => s.numBullets).toFixed(1)} | ${a(s => s.avgWords).toFixed(1)} | ${a(s => s.medWords).toFixed(1)} | ${a(s => s.maxWords).toFixed(0)} |\n`;
    }
    md += '\n';
  }

  // Grand summary
  md += `### Grand Summary\n\n${hdr}\n${sep}\n`;
  for (const v of variants) {
    const allStats = [];
    for (const tc of testCases) {
      for (const r of (grouped[tc]?.[v] ?? [])) {
        allStats.push(analyseBullets(r.response?.output ?? ''));
      }
    }
    if (allStats.length === 0) continue;
    const a = (fn) => avg(allStats.map(fn));
    md += `| ${v} | ${a(s => s.totalWords).toFixed(0)} | ${a(s => s.numBullets).toFixed(1)} | ${a(s => s.avgWords).toFixed(1)} | ${a(s => s.medWords).toFixed(1)} | ${a(s => s.maxWords).toFixed(0)} |\n`;
  }
  md += '\n';

  return md;
}

// --- Per-test-case details ---

function extractDimReasoning(r) {
  // componentResults[0] is the judge assertion; its componentResults are per-dim
  const dimResults = r.gradingResult?.componentResults?.[0]?.componentResults ?? [];
  const map = {};
  for (const dr of dimResults) {
    const name = dr.assertion?.value;
    if (name) map[name] = { score: dr.score, reason: dr.reason };
  }
  return map;
}

function buildTestCaseDetails(tc) {
  let md = `# ${tc}\n\n`;

  for (const v of variants) {
    const runs = grouped[tc]?.[v] ?? [];
    if (runs.length === 0) continue;

    const avgScore = avg(runs.map(r => r.score));
    md += `## ${v} — ${avgScore.toFixed(3)}\n\n`;

    for (let i = 0; i < runs.length; i++) {
      const r = runs[i];
      if (runs.length > 1) md += `### Run ${i + 1}\n\n`;

      // Dimension scores summary line
      const ns = r.gradingResult?.namedScores ?? {};
      const dimLine = JUDGE_DIMS
        .map(d => `${d}=${typeof ns[d] === 'number' ? (ns[d] * 5).toFixed(0) : '?'}`)
        .join(' ');

      const outputText = r.response?.output ?? '';
      const goldenText = r.vars?.golden ?? r.testCase?.vars?.golden ?? '';
      const ow = wordCount(outputText);
      const gw = wordCount(goldenText);

      const bs = analyseBullets(outputText);
      const gs = analyseBullets(goldenText);
      md += `**Scores:** ${dimLine} | ${ow}w ${bs.numBullets}b ${bs.avgWords.toFixed(1)}w/b (golden ${gw}w ${gs.numBullets}b ${gs.avgWords.toFixed(1)}w/b)\n\n`;

      // Problems / fatal flaw
      const reason = r.gradingResult?.componentResults?.[0]?.reason
        ?? r.gradingResult?.reason ?? '';
      if (reason.startsWith('Fatal flaw:')) {
        md += `**Fatal:** ${reason}\n\n`;
      } else if (reason.startsWith('Tagging gate')) {
        md += `**Tagging gate failure:** ${reason}\n\n`;
      } else if (reason && reason !== 'No problems found' && reason !== 'All assertions passed') {
        md += `**Problems:** ${reason}\n\n`;
      }

      // Per-dimension reasoning
      const dimMap = extractDimReasoning(r);
      const reasonedDims = JUDGE_DIMS.filter(d => dimMap[d]?.reason);
      if (reasonedDims.length > 0) {
        md += '**Reasoning:**\n';
        for (const d of reasonedDims) {
          md += `- **${d}** (${(dimMap[d].score * 5).toFixed(0)}/5): ${dimMap[d].reason}\n`;
        }
        md += '\n';
      }

      // Model output
      md += '**Output:**\n\n';
      md += '````markdown\n';
      md += outputText.trim();
      md += '\n````\n\n';
    }
  }

  return md;
}

// --- Assemble ---

mkdirSync(RESULTS_DIR, { recursive: true });

const timestamp = data.results?.timestamp ?? new Date().toISOString();

// Summary file (score matrix + dimensions + bullet stats)
let summary = `# Eval Summary — ${timestamp}\n\n`;
summary += buildScoreMatrix() + '\n';
summary += buildDimAverages() + '\n';
summary += buildBulletStats();

writeFileSync(SUMMARY_PATH, summary);
const summaryKB = (Buffer.byteLength(summary) / 1024).toFixed(1);

// Per-test-case detail files
let totalDetailsKB = 0;
for (const tc of testCases) {
  const details = buildTestCaseDetails(tc);
  const detailPath = join(RESULTS_DIR, `${tc}.md`);
  writeFileSync(detailPath, details);
  const kb = Buffer.byteLength(details) / 1024;
  totalDetailsKB += kb;
  console.log(`  ${tc}.md (${kb.toFixed(1)} KB)`);
}

console.log(`\nWritten to ${RESULTS_DIR}/`);
console.log(`  summary.md (${summaryKB} KB)`);
console.log(`  ${testCases.length} detail files (${totalDetailsKB.toFixed(1)} KB total)`);
console.log(`  ${testCases.length} tests × ${variants.length} variants × ${repeatCount} repeats`);
