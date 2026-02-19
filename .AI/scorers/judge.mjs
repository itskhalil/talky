import { callLLM } from '../providers/talky.mjs';

const JUDGE_SYSTEM = `You evaluate AI-enhanced meeting notes. The goal is notes that feel like the USER wrote them—enhanced, not replaced.

**The test:** Does this read like the user's own notes with helpful additions? Or like an AI summary of the transcript?

**Use the GOLDEN REFERENCE as your benchmark.** If the output is substantially longer or more verbose than the golden, that's a density failure. If the golden preserved the user's shorthand and the output paraphrased it into neutral language, that's a voice failure. Score relative to the golden, not to some abstract ideal.

Before scoring, identify any FATAL flaws — output that fundamentally fails the task regardless of other qualities. A fatal flaw means the output should not pass even if individual dimensions score okay. Examples:

- Sounds like a Zoom/Copilot summary rather than personal notes
- Completely ignores the user's notes and rewrites from transcript
- Adds so much AI content it drowns out what the user cared about

Then score 1-5 on each dimension:

1. **Voice** — Does it sound like the user?
   - 5: Same vocabulary, tone, and style as user's notes — their shorthand and phrasing preserved
   - 3: Some AI-ification of language or phrasing
   - 1: Sounds like a different person wrote it entirely
   - PENALIZE: paraphrasing the user's own words into neutral summary language, replacing shorthand with full sentences

2. **Density** — Terse bullets, not prose?
   - 5: Compressed facts, scannable — you could skim this in 10 seconds
   - 3: Some verbose sections
   - 1: Essay-style paragraphs
   - PENALIZE HARD: meta-descriptions ("talked about X", "discussed X", "covered X" — just say X), "the team", full sentences, recapping context the user already knows, using more words than the golden to convey the same information

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
  "fatal": null,
  "problems": ["...", "..."],
  "voice": { "score": N, "reasoning": "..." },
  "density": { "score": N, "reasoning": "..." },
  "clarity": { "score": N, "reasoning": "..." },
  "readability": { "score": N, "reasoning": "..." },
  "additions": { "score": N, "reasoning": "..." },
  "tagging": { "score": N, "reasoning": "..." }
}

Set "fatal" to a short string describing the flaw, or null if none.`;

// Voice and density get extra weight — they're the soul of "Granola magic"
const WEIGHTS = {
  voice: 1.5,
  density: 1.5,
  clarity: 1.0,
  readability: 1.0,
  additions: 1.0,
  tagging: 0.0, // treated as a binary gate, not folded into the score
};

const SCORED_DIMS = ['voice', 'density', 'clarity', 'readability', 'additions'];
const ALL_DIMS = [...SCORED_DIMS, 'tagging'];

const TAGGING_PASS_THRESHOLD = 3; // below this → fail with tagging reason, skip score
const VERBOSITY_RATIO_MAX = 1.4; // output can be up to 40% longer than golden before penalty kicks in
const VERBOSITY_PENALTY_RATE = 0.15; // score deducted per unit of ratio above threshold
const VERBOSITY_PENALTY_CAP = 0.25; // never deduct more than this from verbosity alone
const PASS_THRESHOLD = 0.6;
const FATAL_SCORE_CAP = 0.4;

function buildJudgeMessage(userNotes, transcript, golden, output) {
  return `## USER'S ORIGINAL NOTES
${userNotes ?? '(no notes taken)'}

## TRANSCRIPT (first 3000 chars)
${transcript.slice(0, 3000)}

## GOLDEN REFERENCE
${golden}

## MODEL OUTPUT TO JUDGE
${output}`;
}

const wordCount = (s) => s.split(/\s+/).filter(Boolean).length;

export default async function (output, context) {
  const { vars } = context;

  const judgeMsg = buildJudgeMessage(
    vars.notes,
    vars.transcript,
    vars.golden,
    output,
  );

  let raw;
  try {
    raw = await callLLM(
      [
        { role: 'system', content: JUDGE_SYSTEM },
        { role: 'user', content: judgeMsg },
      ],
      process.env.JUDGE_MODEL,
    );
  } catch (err) {
    return {
      pass: false,
      score: 0,
      reason: `Judge API error: ${err.message}`,
    };
  }

  let scores;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    scores = JSON.parse(jsonMatch[0]);
  } catch {
    return {
      pass: false,
      score: 0,
      reason: `Failed to parse judge response: ${raw.slice(0, 200)}`,
    };
  }

  // — conciseness (computed early so all return paths include it) —
  const outputWords = wordCount(output);
  const goldenWords = wordCount(vars.golden);
  const conciseness = goldenWords > 0 ? Math.min(1, goldenWords / outputWords) : 1;

  // — tagging gate —
  // Tagging is correctness, not quality. Handle it separately so a tagging bug
  // doesn't trade off against voice or density scores.
  const taggingScore = scores.tagging?.score;
  if (typeof taggingScore === 'number' && taggingScore < TAGGING_PASS_THRESHOLD) {
    return {
      pass: false,
      score: taggingScore / 5,
      reason: `Tagging gate failed (${taggingScore}/5): ${scores.tagging?.reasoning ?? ''}`,
      namedScores: {
        ...buildNamedScores(scores),
        conciseness,
      },
      componentResults: [{
        pass: false,
        score: taggingScore / 5,
        reason: scores.tagging?.reasoning ?? '',
        assertion: { type: 'javascript', value: 'tagging' },
      }],
    };
  }

  // — fatal flaw gate —
  if (scores.fatal) {
    const rawAvg = computeWeightedAvg(scores, SCORED_DIMS);
    return {
      pass: false,
      score: Math.min(rawAvg, FATAL_SCORE_CAP),
      reason: `Fatal flaw: ${scores.fatal}`,
      namedScores: {
        ...buildNamedScores(scores),
        conciseness,
      },
      componentResults: buildComponentResults(scores),
    };
  }

  // — weighted score —
  const weightedAvg = computeWeightedAvg(scores, SCORED_DIMS);

  // — verbosity penalty (deterministic) —
  const wordRatio = goldenWords > 0 ? outputWords / goldenWords : 1;
  const verbosityPenalty = wordRatio > VERBOSITY_RATIO_MAX
    ? Math.min((wordRatio - VERBOSITY_RATIO_MAX) * VERBOSITY_PENALTY_RATE, VERBOSITY_PENALTY_CAP)
    : 0;

  const finalScore = Math.max(0, weightedAvg - verbosityPenalty);

  const problems = scores.problems ?? [];
  if (verbosityPenalty > 0) {
    problems.push(`Verbosity penalty −${verbosityPenalty.toFixed(2)} (${outputWords}w vs ${goldenWords}w golden, ${wordRatio.toFixed(1)}x)`);
  }

  return {
    pass: finalScore >= PASS_THRESHOLD,
    score: finalScore,
    reason: problems.length > 0 ? problems.join('; ') : 'No problems found',
    namedScores: {
      ...buildNamedScores(scores),
      conciseness,
    },
    componentResults: buildComponentResults(scores),
  };
}

// — helpers —

function computeWeightedAvg(scores, dims) {
  let weightedSum = 0;
  let totalWeight = 0;
  for (const dim of dims) {
    const score = scores[dim]?.score;
    if (typeof score === 'number') {
      const w = WEIGHTS[dim] ?? 1.0;
      weightedSum += (score / 5) * w;
      totalWeight += w;
    }
  }
  return totalWeight > 0 ? weightedSum / totalWeight : 0;
}

function buildNamedScores(scores) {
  const named = {};
  for (const dim of ALL_DIMS) {
    const score = scores[dim]?.score;
    if (typeof score === 'number') named[dim] = score / 5;
  }
  return named;
}

function buildComponentResults(scores) {
  return ALL_DIMS
    .filter((dim) => typeof scores[dim]?.score === 'number')
    .map((dim) => ({
      pass: scores[dim].score >= 3,
      score: scores[dim].score / 5,
      reason: scores[dim].reasoning ?? '',
      assertion: { type: 'javascript', value: dim },
    }));
}
