---
name: eval-review
description: Review the latest enhance_notes eval results with scoring analysis, qualitative output review, and recommendations
user-invocable: true
---

# Eval Review

Review the latest eval results and produce a structured analysis.

## Setup

1. Read `.AI/EVAL_REVIEW_GUIDE.md` for context — focus on: test case descriptions, known failure modes, research principles, and history of what's been tried.
2. Read `.AI/results/summary.md` for the score matrix, dimension averages, bullet stats, and ratio tables.

## Review Checklist

Work through each of these, then produce a written review.

### 1. Score Overview

From `summary.md`:

- Include the full score matrix table
- Include dimension averages table
- Include all four ratio-vs-golden tables (word count, bullet count, words per bullet, chain bullets)
- Flag any variant that beats baseline by >0.015 (potential winner) or trails by >0.015 (potential failure)
- Flag any test case where a variant scores <0.6 (likely fatal flaw)

### 2. Per-Case Deep Dives

Read `results/<Test Case>.md` for:

- **Every sparse/no-notes case** (sparse-feedback, sparse-short, sparse-interview, no-notes-complex, no-notes-personal) — read judge reasoning AND model outputs
- **Any case where a variant scores <0.85** — read judge reasoning
- **Any case with >0.15 spread between runs** — flag inconsistency

For each output you read, ask:

- Would the user believe they wrote this?
- Any "you/your" perspective slips?
- Is chronological order correct?
- Are the right things omitted (decisions/commitments kept, reasoning/detail cut)?
- Is the register natural (not AI-speak)?
- Are user notes preserved verbatim?
- Are bullets compressed fragments, not sentences?

### 3. Bullet Stats Analysis

From the ratio tables:

- Word count: flag >1.5x (verbose) or <0.7x (too terse)
- Bullet count: flag >1.3x (proliferation) or <0.5x (under-generating)
- Words per bullet: track vs 1.5x baseline (RLHF floor — improvement here would be notable)
- Chain bullets: track vs baseline (lower diff = better splitting)

Compare bullet growth vs word growth: if words grow faster than bullets, bullets are getting longer; if bullets grow faster, the model is proliferating.

### 4. Run-to-Run Consistency

Flag any case where the same variant's scores differ by >0.15 across runs. Read both outputs to understand what changed.

### 5. Regression Check

Any new variant must not regress on dense cases:

- Conciseness must hold (not >1.5x golden word count)
- Density score must hold at 3.7+
- Voice must hold at 3.8+

### 6. Verdict

For each non-baseline variant, classify as:

- **WINNER** — consistent improvement, no regressions, promote
- **PROMISING** — shows improvement but needs more data or has a concerning regression
- **NULL** — no meaningful difference from baseline
- **FAILED** — regression or no improvement, abandon

## Output Format

Structure your review as:

1. **Round N Eval Review** (title)
2. **Score Summary** — tables + high-level observations
3. **Variant Analysis** — per-variant verdict with evidence
4. **Bullet Stats** — ratio tables + analysis
5. **Qualitative Review** — per-case observations from reading outputs
6. **Key Findings** — what we learned
7. **Recommendations** — what to promote, what to try next

## Privacy

**NEVER include personal details in any git-tracked output** (including `EVAL_REVIEW_GUIDE.md`). No real names, meeting content, transcript excerpts, or company-specific context. Keep references abstract — e.g. "a recurring standup" not the specific meeting name, "a management thread" not the people involved.
