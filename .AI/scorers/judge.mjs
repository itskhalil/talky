import { callLLM } from '../providers/talky.mjs';

const JUDGE_SYSTEM = `You evaluate AI-enhanced meeting notes. The goal is notes that feel like the USER wrote them—enhanced, not replaced.

**The test:** Does this read like the user's own notes with helpful additions? Or like an AI summary of the transcript?

**Use the GOLDEN REFERENCE as your benchmark.** If the output is substantially longer or more verbose than the golden, that's a density failure. If the output omits important topics the golden covered, that's an additions failure. If the golden preserved the user's shorthand and the output paraphrased it into neutral language, that's a voice failure. Score relative to the golden, not to some abstract ideal.

Before scoring, identify any FATAL flaws — output that fundamentally fails the task regardless of other qualities. A fatal flaw means the output should not pass even if individual dimensions score okay. Examples:

- Sounds like a Zoom/Copilot summary rather than personal notes
- Completely ignores the user's notes and rewrites from transcript
- Adds so much AI content it drowns out what the user cared about
- Anchors on the user's sparse notes and misses important topics from the meeting (decisions, commitments, action items that the golden covered)

Then score 1-5 on each dimension:

1. **Voice** — Does it sound like the user?
   - 5: Same vocabulary, tone, and style as user's notes — their shorthand and phrasing preserved
   - 3: Some AI-ification of language or phrasing
   - 1: Sounds like a different person wrote it entirely
   - PENALIZE: paraphrasing the user's own words into neutral summary language, replacing shorthand with full sentences, addressing the user as "you/your" (notes are written BY the user not TO them), reordering topics away from the meeting's chronological flow when the user's notes don't impose a different structure

2. **Density** — Terse bullets, not prose?
   - 5: Compressed facts, scannable — you could skim this in 30 seconds
   - 3: Some verbose sections
   - 1: Essay-style paragraphs
   - PENALIZE HARD: meta-descriptions ("talked about X", "discussed X", "covered X" — just say X), "the team", full sentences, recapping context the user already knows, using more words than the golden to convey the same information
   - NOTE: Short output is not the same as dense output. If the output is significantly shorter than the golden, it's omitting content, not compressing it. Score density based on how efficiently information is conveyed, not on raw word count.

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
   - 5: Surfaces the important things the user would want but missed — compare against the golden
   - 3: Mix of useful and filler, or misses important topics the golden covered
   - 1: Obvious, redundant, or omits important substance from the meeting
   - NOTE: Omitting *something* is fine and expected — the failure is omitting things that actually matter (decisions, commitments, action items, key arguments) while including things that don't

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

// Voice, density, and additions get extra weight — core quality signals
const WEIGHTS = {
  voice: 1.5,
  density: 1.5,
  clarity: 1.0,
  readability: 1.0,
  additions: 1.5,
  tagging: 0.0, // treated as a binary gate, not folded into the score
};

const SCORED_DIMS = ['voice', 'density', 'clarity', 'readability', 'additions'];
const ALL_DIMS = [...SCORED_DIMS, 'tagging'];

const TAGGING_PASS_THRESHOLD = 3; // below this → fail with tagging reason, skip score
// Length penalty — golden is the target; shorter is worse than longer (golden is already terse)
const LENGTH_TOLERANCE_OVER = 0.3; // 30% slack for being longer (legitimate [ai] additions)
const LENGTH_TOLERANCE_UNDER = 0.05; // 5% slack for being shorter (golden is the floor)
const LENGTH_PENALTY_RATE_OVER = 0.15; // verbose: score deducted per 10% deviation beyond tolerance
const LENGTH_PENALTY_RATE_UNDER = 0.5; // terse: much steeper — golden is already minimal
const LENGTH_PENALTY_CAP = 0.25; // never deduct more than this
const PASS_THRESHOLD = 0.6;
const FATAL_SCORE_CAP = 0.4;

function buildJudgeMessage(userNotes, transcript, golden, output) {
  return `## USER IDENTITY
The user is Khalil, the person who recorded this meeting. Their microphone audio is labeled [Mic] in the transcript. [Other] is the other speaker. The notes should read as if written by Khalil.

## USER'S ORIGINAL NOTES
${userNotes ?? '(no notes taken)'}

## TRANSCRIPT (first 3000 chars)
${transcript.slice(0, 3000)}

## GOLDEN REFERENCE
${golden}

## MODEL OUTPUT TO JUDGE
${output}`;
}

const wordCount = (s) => s.split(/\s+/).filter(Boolean).length;

function bulletStats(text) {
  const lines = text.split('\n');
  const bullets = lines.filter(l => l.trim().match(/^- /));
  const wordCounts = bullets.map(b => b.trim().replace(/^- /, '').split(/\s+/).filter(Boolean).length);
  const total = wordCounts.length;
  if (total === 0) return { avg_bullet_words: 0, long_bullet_pct: 0, bullet_count: 0 };
  const avg = wordCounts.reduce((a, b) => a + b, 0) / total;
  const longCount = wordCounts.filter(w => w > 20).length;
  return {
    avg_bullet_words: Math.round(avg * 10) / 10,
    long_bullet_pct: Math.round((longCount / total) * 100) / 100,
    bullet_count: total,
  };
}

export default async function (output, context) {
  const { vars } = context;

  // Strip inline reasoning (before ---NOTES--- delimiter) if present
  const notesDelimiter = '---NOTES---';
  if (output.includes(notesDelimiter)) {
    output = output.split(notesDelimiter).pop().trim();
  }

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

  // — conciseness & bullet metrics (computed early so all return paths include them) —
  const outputWords = wordCount(output);
  const goldenWords = wordCount(vars.golden);
  const conciseness = goldenWords > 0 ? Math.min(1, goldenWords / outputWords) : 1;
  const bullets = bulletStats(output);

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
        ...bullets,
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
        ...bullets,
      },
      componentResults: buildComponentResults(scores),
    };
  }

  // — weighted score —
  const weightedAvg = computeWeightedAvg(scores, SCORED_DIMS);

  // — length penalty (deterministic, asymmetric: tight floor, loose ceiling) —
  const wordRatio = goldenWords > 0 ? outputWords / goldenWords : 1;
  const isOver = wordRatio >= 1.0;
  const tolerance = isOver ? LENGTH_TOLERANCE_OVER : LENGTH_TOLERANCE_UNDER;
  const rate = isOver ? LENGTH_PENALTY_RATE_OVER : LENGTH_PENALTY_RATE_UNDER;
  const deviation = Math.abs(wordRatio - 1.0);
  const lengthPenalty = deviation > tolerance
    ? Math.min((deviation - tolerance) * rate, LENGTH_PENALTY_CAP)
    : 0;

  const finalScore = Math.max(0, weightedAvg - lengthPenalty);

  const problems = scores.problems ?? [];
  if (lengthPenalty > 0) {
    const direction = wordRatio > 1 ? 'verbose' : 'terse';
    problems.push(`Length penalty −${lengthPenalty.toFixed(2)} (${direction}: ${outputWords}w vs ${goldenWords}w golden, ${wordRatio.toFixed(2)}x)`);
  }

  return {
    pass: finalScore >= PASS_THRESHOLD,
    score: finalScore,
    reason: problems.length > 0 ? problems.join('; ') : 'No problems found',
    namedScores: {
      ...buildNamedScores(scores),
      conciseness,
      ...bullets,
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
