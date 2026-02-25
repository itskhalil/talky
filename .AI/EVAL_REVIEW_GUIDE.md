# Eval Review Guide

Instructions for reviewing `enhance_notes` prompt evaluation results.

## What this system does

The `enhance_notes` prompt takes a user's rough meeting notes + a transcript and produces completed notes that feel like the user wrote them. The output is NOT a summary — it's the user's own notes, enhanced with things they missed.

The gold standard: a reviewer should believe the user wrote it themselves. If the reaction is "this is thorough" — the prompt is failing. If the reaction is "this is exactly what I would have written" — it's working.

The core concept is **ghostwriting** — the model is the user's second pair of hands, the attention they couldn't give the transcript because they were present in the room. The model writes AS the user, not FOR them. The output is what the user would have written if they'd caught everything.

This framing handles the calibration problem without rules:
- **Dense user notes** → "they've got this, I'm patching tiny gaps"
- **Sparse user notes** → "they were heads-down in an intense conversation, I need to reconstruct what they'd have written in their voice"

Sparse notes almost always mean the user was too engaged to write, NOT that they didn't find the meeting worth noting. This distinction is critical — it determines whether the model adds 2 bullets or reconstructs 15-20 lines of substantive notes.

## How to run and view evals

```bash
npm run eval          # run all variants × all test cases (also generates summary)
npm run eval:summary  # regenerate summary from existing results (no re-run)
npm run eval:view     # open results in browser
```

Results are written to `.AI/results.json`. The summary is generated automatically into `.AI/results/` and split into separate files:

- `.AI/results/summary.md` — score matrix, dimension averages, bullet stats (~5KB, one-shot readable)
- `.AI/results/<Test Case>.md` — per-run scores (including word count, bullet count, avg words/bullet), judge reasoning, problems, and full model outputs for each test case (~70-130KB each)

Start your review from `results/summary.md`, then drill into individual test case files as needed. Use `results.json` only if you need raw data the summary doesn't cover.

## File layout

- `.AI/promptfooconfig.yaml` — which variants to test
- `.AI/prompt-variants/<name>/system.txt` — system prompt for each variant
- `.AI/prompt-variants/<name>/user.txt` — user prompt for each variant
- `.AI/prompts/<name>.mjs` — prompt function (loads txt files, adds production injections)
- `.AI/Examples/<name>/` — test cases (transcript, notes, enhanced golden files)
- `.AI/regression evals/` — regression reference outputs (before/after/enhanced)
- `.AI/scorers/judge.mjs` — LLM judge configuration
- `.AI/tests/cases.mjs` — test case loader

## Test cases

There are two categories:

**Dense notes** (dense-business, dense-review-q1, dense-review-q4, dense-interview): User wrote substantial notes. These test whether the model preserves the user's notes, adds selectively, and stays concise.

**Sparse notes** (sparse-feedback, sparse-short, sparse-interview): User wrote 1-2 lines or a reaction paragraph for a long meeting. These test whether the model exercises judgment about what to include, writes in the user's voice, follows chronological order, and doesn't over-anchor on the sparse notes.

- sparse-interview is an interview with sparse reaction-paragraph notes (not structured notes) — tests whether the model can produce appropriately-detailed interview notes from a user brain-dump rather than treating it as "user has it covered."

**No notes** (no-notes-personal, no-notes-complex): User provided no notes at all — everything must be generated from the transcript. These test whether the model can produce personal-feeling notes without any user voice to calibrate from.

- no-notes-personal is a deeply personal 1-on-1 conversation — tests emotional/personal register without user voice.
- no-notes-complex is a long operational conversation with a colleague about management issues, staffing process problems, and personal disruptions — tests whether the model can handle a complex, multi-threaded conversation and produce notes that feel personal rather than like a structured briefing.

## What to check in every eval review

### 1. Scores — but scores are not enough

The judge scores on 6 dimensions (voice, density, clarity, readability, additions, tagging) plus a computed conciseness score and verbosity penalty. Read the scores to identify outliers, but **always read the judge reasoning and the actual model outputs**. A score of 0.75 can mean very different things depending on what the judge flagged.

### 2. Judge reasoning

In the per-test-case files (`results/<Test Case>.md`), each run includes:
- **Problems** — problems list and any verbosity penalty
- **Reasoning** — per-dimension scores and reasoning text

Read the reasoning text for every sparse-notes case. For dense-notes cases, read the reasoning for any score below 0.85 or any failure.

### 3. Actual model outputs

The most important thing. In the per-test-case files (`results/<Test Case>.md`), each run's full model output is included under **Output**. Read these, especially for sparse-notes cases. Ask yourself:

- **Would the user believe they wrote this?** If it reads like a briefing doc or AI summary, it's failing regardless of scores.
- **Is anything addressed to "you/your"?** Notes are written BY the user, not TO them. "You should follow up with the client" is wrong; "I need to follow up with the client" or "follow up with [person] about the delay" is right.
- **Is the chronological order correct?** Topics should appear in the order they were discussed. If the user wrote one note mid-meeting, it should appear mid-output, not promoted to the top.
- **Are the right things omitted?** Omitting *something* is fine and expected. The failure is omitting things that actually matter while including things that don't. The referenceability test: would the user come back to find this next week? They come back for decisions, commitments, open items, action items. For emotional/consequential meetings (like a conversation about leaving a company), the drivers, arguments, and key framing ARE substance — not just the final decision.
- **Are action items framed correctly?** Watch for action items that are too narrow. "Send the revised proposal by Friday" is a discrete task; "keep the client informed on timeline changes, especially with the launch approaching" is an ongoing responsibility. The second is more useful.
- **Is the register natural?** Watch for AI-speak: "exhibited reluctance regarding the proposed timeline", "acknowledged suboptimal resource allocation", "facilitated", "comprehensive." The user writes things like "he doesn't think we can hit the deadline" or "we're understaffed on this." A good test: read a bullet aloud. Would a real person say this to a colleague, or does it sound like a management consultant wrote it?
- **Are user notes preserved verbatim?** The user's own words should never be paraphrased. If they wrote "why didn't we catch this sooner?" it should appear as `[noted] why didn't we catch this sooner?` — not `[noted] Raised concerns about the delayed identification of the issue`.
- **Does the output use compressed note fragments?** The register should always be compressed notes — terse fragments, not full sentences — regardless of whether user notes are dense or sparse. This is consistent: the user's register doesn't change based on how much they wrote.

### 4. Bullet stats — MUST INCLUDE IN EVERY REVIEW

The summary auto-generates **Bullet Stats** tables (per-test-case with golden reference row, plus Grand Summary) and **Ratios vs Golden** tables (Word Count, Bullet Count, Words per Bullet, Chain Bullets — each with an **Average** row). Include the ratio tables in your review. **Every numeric table in a review must have an average row.**

The four ratio tables:
1. **Word count ratios vs golden** — output words / golden words. Flag >1.5x (verbose) or <0.7x (too terse).
2. **Bullet count ratios vs golden** — output bullets / golden bullets. Flag >1.3x (proliferation) or <0.5x (under-generating).
3. **Words per bullet vs golden** — avg w/b ratio. The model consistently writes 1.3-2x golden w/b — track whether variants improve this.
4. **Chain bullets vs golden** — bullets containing `;` or ` — `. Tracks whether chaining instructions are effective.

Use these to spot:
- **Verbosity shifts** — word count climbing vs golden or vs baseline variant
- **Bullet bloat** — avg words per bullet increasing means bullets are becoming sentences instead of fragments
- **Structural changes** — bullet count dropping sharply (e.g., 14 → 3) may indicate the model switched to prose-style output instead of bulleted notes
- **Inflation source** — compare bullet count ratio to word count ratio. If words grow faster than bullets, bullets are getting longer. If bullets grow faster than words, the model is splitting content into more lines (proliferation).

### 5. Run-to-run consistency

Each case runs twice. If a variant scores 0.83 on run 1 and 0.58 on run 2 for the same case, that's a red flag — the prompt is producing inconsistent behavior. Look at what changed between runs (structure, content selection, voice).

### 6. Regression on dense cases

Any change targeting sparse-notes behavior must not regress on dense cases. Key metrics to watch:
- **Conciseness** — previous failed variants (sf-frame, sf-both, sf-plain) exploded to 2-3x the golden's word count. Anything above 1.5x is concerning.
- **Density score** — should stay at 0.8+. A drop to 0.4-0.6 means the output is becoming a meeting summary rather than enhanced notes.
- **Voice** — should stay at 0.8+ for dense cases. The model should preserve the user's vocabulary and shorthand.

## Known failure modes

These are patterns we've identified through multiple eval rounds:

### The verbosity trap
Any instruction that loosens the selectivity constraint ("complete their notes", "add what's missing") causes the model to over-generate. The production prompt uses "the 2-3 things you'd kick yourself for forgetting" as a hard ceiling. Variants that soften this consistently blow up density.

### Notes-as-scaffold for sparse notes
The guideline "When user notes are present, their ordering is the scaffold" causes the model to anchor on sparse notes as the structural backbone. For one-line notes, this means the entire output is organized around that one line. This is the correct behavior for dense notes but wrong for sparse notes.

### "You/your" perspective
The model sometimes writes TO the user ("You need to reschedule the demo", "Your budget request") instead of AS them ("I need to reschedule the demo", "My budget request"). This was caused by the original analyst/principal frame. The current frame ("You just came out of a meeting... your rough notes...") mostly fixes this but slips can occur, especially on no-notes cases (no notes to calibrate voice from).

### AI-speak register
The model defaults to consultant language: "exhibited reluctance regarding the timeline", "acknowledged suboptimal resource allocation", "catalyzed by." The user writes casually. The frame helps but doesn't fully prevent this. Watch for it especially in [ai] additions.

### Softening raw honesty
When the model writes as the user (frame variant), it tends to be more diplomatic than the user actually was. E.g., the user said "we dropped the ball on this, full stop" but the model writes "the timeline wasn't met due to resource constraints." The verbatim version is more useful — it captures the user's actual assessment, the thing you'd want to remember when discussing accountability.

### Meeting-type blindness
The model should calibrate what matters based on the type of meeting. In a simple business decision call, only the decisions and actions matter. In an emotional, consequential conversation (like deciding to leave a company, or receiving difficult feedback about your behavior), the drivers, arguments, and framing ARE the substance. A prompt that cuts all reasoning and only keeps decisions would fail on these meetings.

### The no-notes complex conversation gap (no-notes-complex)
When the user provides no notes AND the conversation is emotionally/contextually dense (not a simple business meeting), the model struggles. Gate scores 0.438-0.453 in early rounds. Inline reasoning improved this (v6 to 0.664, actions-remove to 0.561) but it remained below 0.8 through Round 17 (0.531 with generate-then-tag).

**Partially fixed (Round 19):** Root cause identified as suppressive constraints ("Default is nothing", "User's notes are canonical") that are irrelevant for no-notes cases. Deterministic prompt swap (removing these for no-notes cases) improved no-notes-complex to 0.730 — the highest score ever for this case. Trade-off: no-notes-personal regresses modestly (0.941 → 0.900) from over-extraction at 1.74x golden word count.

### Interview editorializing from reasoning step
On interview-format meetings where the user is the interviewer, the reasoning step encourages analytical framing that produces editorial judgments in the notes rather than observational notes. v6 on dense-interview (0.700) adds evaluative content like "standard but not distinctive", "Most original idea" and a low-value section about the interviewer's own explanation to the candidate. It also misses the entire "His questions" section from the golden. **Partially fixed (Round 7):** actions-remove recovered dense-interview to 0.810 (+0.118 over v6) by removing "Action Items" from the list of prohibited section types, which let the model capture the candidate's questions and concrete commitments naturally.

### Bullet proliferation under compression constraints
Explicit per-bullet word limits ("aim for 10 words or fewer") cause the model to generate more bullets rather than fewer total words. The combined-compress variant averaged 49.7 bullets (vs gate's 25.3) with roughly the same total content. The constraint operates at the wrong level — it compresses individual lines but doesn't reduce selectivity. Total output length is driven by how many topics the model decides to include, not how many words per bullet.

### Prompt register contradiction (em-dashes)
The production prompt contains 12+ em-dashes in its instructions while simultaneously instructing: "If a bullet needs a semicolon or em-dash to chain ideas, split it into separate bullets." The prompt models heavy em-dash usage while telling the model not to use them. Principle #13 (instruction register primes output register) predicts the concrete exposure overrides the splitting instruction. Round 9 confirmed: split-example (which demonstrated splitting in Example 2) did not reduce chain_bullets (chain rate 41% vs baseline's 38%). The in-prompt examples already demonstrate 4-6 w/b fragments, yet the model produces 15 w/b. The prompt's own verbose register (full sentences, em-dashes, 15+ w/line in instruction text) may be the dominant register signal, outweighing the short examples.

### Emotional framing as verbosity license
The "sting" framing ("What from this meeting would sting to have forgotten?") was intended to increase selectivity. Instead, it broadened inclusion — most of a meeting transcript contains things that "might sting." The model interprets the emotional frame as a mandate to be thorough rather than selective. Density collapsed to 2.9/5, the worst in the eval. This validates research principle #6 (models default to verbosity due to RLHF) — emotional appeals don't counteract this bias.

### Reasoning-as-topic-listing (the characterize vs. list distinction)
When a pre-writing reasoning step *lists* meeting content ("the three things that matter are X, Y, Z"), it creates a checklist the model exhaustively covers. When it *characterizes* the meeting's nature ("this is a deeply personal conversation"), it calibrates register without creating inclusion pressure. The difference is stark: v4's topic-listing reasoning produced 1075w on dense-review-q1 (0.310 score); v4's characterizing reasoning produced 0.938 on no-notes-personal. Any future reasoning gate must explicitly prevent topic listing.

**Partial fix (Round 6):** v6's explicit anti-listing constraint ("not a list of what was covered") largely prevents checklist reasoning. dense-review-q1 recovered from v2's 0.773 to 0.906. The reasoning still technically lists topics on some runs, but the framing shifts from "what the meeting was about" to "what to capture" — and the 1-2 sentence limit prevents elaboration. The constraint is effective but not watertight.

### Analytical tone bleed from reasoning preamble
A pre-writing reasoning step sets an analytical register that bleeds into the notes. The model shifts from first-person notes to third-person analyst mode: "[User]'s reasons for leaving" instead of "My reasons", analyst headers like "[Person]'s counter-arguments", meta-descriptions like "Senior leader's framing." This is especially bad when the reasoning text itself uses the user's name in third person, which primes the model. The shorter the reasoning, the less bleed — v3's 1-sentence reasoning had voice 4.0 vs v4's 3.6.

**Partial fix (Round 6):** Using "Write your thinking/thought" instead of "Write your analysis" produces first-person reasoning text, which prevents the third-person priming. v6 recovered voice to 4.0 (from v2's 3.6). However, the fix doesn't fully prevent slips on no-notes cases where there's no user voice to anchor first-person register.

## Research principles to keep in mind

These are from the prompting research (`.AI/research.txt`) that guided the current prompt design. Read the full file for depth — these are the most operationally relevant findings:

1. **Context beats instructions.** If the frame is right, rules become unnecessary. If the frame is wrong, rules can't fix it. Prioritize frame-level changes over adding more guidelines. The breakthrough insight was treating the model like "an intern on their first day" — smart but lacking context. You give an intern enough context to exercise judgment, not a rulebook.

2. **Examples are the single highest-leverage variable.** (Schulhoff, analysis of 1,500+ papers) Examples outperform instructions more than any other technique — capable of improving accuracy from 0% to 90%. Examples are "pictures worth a thousand words."

3. **When abstract instructions compete with concrete structural apparatus, the concrete wins.** "Be brief" loses to "add sections for significant topics." The model executes the concrete structure and treats brevity as aspirational. This is why adding rules often fails — they're abstract, while the formatting and structural instructions are concrete.

4. **The prompt's own length signals expected output length.** Adding more text to the prompt tends to make the output longer. Don't add words carelessly. A shorter prompt that says the right thing produces more calibrated output than a longer prompt with every edge case covered.

5. **Rules compensating for a weak frame create brittleness.** If you need a rule like "never use you/your," the frame might be the real problem. We tested this directly: a `rules` variant (adding explicit "no you/your" and "chronological order for sparse notes" rules) performed worse than baseline. The `frame` variant (changing the underlying relationship) fixed both problems without any rules.

6. **Models default to verbosity because of RLHF.** Human evaluators during training consistently preferred longer answers. This creates a training signal that rewards comprehensiveness even when brevity would serve better. You have to actively counteract this — it won't self-correct. The "2-3 things you'd kick yourself for forgetting" ceiling in the system prompt is the main mechanism for this.

7. **Examples must model confident omission.** The most important example behavior is showing things being LEFT OUT. A real meeting has 20 minutes of discussion that produces zero additions. Without this modeled, the model has never seen restraint. Short, clean synthetic examples show format, not judgment.

8. **Negative instructions can backfire.** (Anthropic guidance) "Don't be verbose" can sometimes produce the opposite effect. Prefer positive framing: "use concise, direct prose."

9. **The completeness trap.** Any instruction that implies "process everything" overrides selectivity. "A good analyst doesn't stop because the person they're supporting did" was a line in an earlier prompt that acted as a direct license to keep generating. Watch for anything that implies exhaustiveness.

10. **Tagging creates implicit comprehensiveness pressure.** When every line must be tagged [noted] or [ai], the model can experience this as "account for everything in the transcript." Tags should identify additions, not create a reconciliation obligation.

11. **The core question is "would they have written this down?"** Not "is this in the transcript?" Not "is this true?" Not "is this important?" — would the specific user, with their priorities and their level of detail, have noted this? This is what the ghostwriter frame enables.

12. **Characterize, don't list.** (Discovered in Round 5) When asking the model to reason about what matters, *characterizing* the meeting's nature ("this is a deeply personal conversation") calibrates without creating inclusion pressure. *Listing* content ("the three things that matter are X, Y, Z") creates a checklist the model exhaustively covers. This applies to any meta-reasoning, system prompt framing, or structural instruction that references meeting content — always describe the nature of the thing, never enumerate its parts. Explicit anti-listing constraints ("not a list of what was covered") are effective at preventing this (Round 6).

13. **Instruction register primes output register.** (Discovered in Round 6) The word choices in meta-instructions prime the model's output register. "Write your analysis" produces third-person analytical text; "Write your thinking" produces first-person reflective text. This is why v2's voice dropped to 3.6 (its reasoning text used the user's name in third person, priming analyst mode) while v6 recovered to 4.0 (its "Write your thinking" instruction produced first-person reasoning that didn't contaminate the notes). The instruction's register is contagious — it sets the voice for everything that follows.

14. **Anti-listing constraints work better than pro-characterization instructions.** (Discovered in Round 6) v6's negative constraint ("not a list of what was covered") was more effective at preventing topic-listing than v5's positive instruction to characterize ("what kind of meeting this was and what that means"). v6 held dense-review-q1 at 0.906 while v5 slipped to 0.817. Negative constraints operate as filters on the model's default behavior; positive instructions compete with the model's default behavior. When the default is to list, telling it what NOT to do is more reliable than telling it what to do instead.

15. **Prompt register does not affect output register.** The model's w/b is invariant to prompt linguistic style — terse fragment instructions, em-dash removal, and full rewrites all produce the same ~1.5x w/b (Rounds 10-11). Principle #13 (instruction register primes output register) holds for *framing keywords* ("analysis" vs "thinking" affecting voice/perspective, "jot" vs "write" affecting density) but does NOT extend to *linguistic style* (full sentences vs fragments, em-dashes vs periods). Terser prompt instructions can actually increase verbosity by causing bullet proliferation.

16. **Words-per-bullet is driven by tag-induced elaboration, not RLHF alone.** Prompt-level text changes (word limits, compression examples, register changes, em-dash removal) don't move w/b (confirmed across Rounds 4-15). But generation architecture does: separating content generation from tag classification (generate-then-tag, Round 17) reduces w/b from ~1.5x to 1.26x golden. Frame verb changes ("jot" vs "write") also help (~1.52x → 1.40x). The mechanism is autoregressive priming — when `[ai]` precedes content tokens, the model elaborates. When content is generated first and classified separately, it writes naturally terse fragments. The residual gap (1.26x vs 1.00x) may be RLHF-related.

## The golden references

Each test case has an `enhanced` file in `.AI/Examples/` that serves as the golden reference. The judge scores relative to these goldens.

For the sparse-notes cases (sparse-feedback, sparse-short), the goldens were hand-crafted through detailed discussion about what ideal enhanced notes look like. The process involved asking the user specific questions about what they'd come back for, what register they wanted, and where their notes should appear chronologically. The goldens represent:
- Chronological ordering (user's note placed where it fell in the meeting, not promoted to top)
- First-person voice (no "you/your")
- Compressed note fragments (same terse style regardless of note density)
- Selective coverage (~20 lines for a 46-min meeting, ~15 lines for a 15-min meeting)
- Raw honesty preserved (verbatim quotes where they matter for accountability)
- Action items framed as ongoing responsibilities where appropriate, not just discrete tasks
- Confident omission (large sections of transcript producing zero output — tangential anecdotes, extended arguments on side topics, and detailed negotiation minutiae were all cut because they don't pass the "would you come back for this?" test)
- For emotional/consequential meetings: the reasoning and framing captured alongside decisions (conscious trade-off framing, key arguments, and honest admissions are all substance, not filler)

The regression evals folder also contains `before` and `after` files showing what the OLD production prompt produced vs the PREVIOUS production prompt. These are useful for understanding the history of the problem.

## Judge configuration

The judge (`scorers/judge.mjs`) has:
- **Weights**: voice (1.5x), density (1.5x), clarity (1.0x), readability (1.0x), additions (1.5x), tagging (binary gate)
- **Length penalty (asymmetric)**: penalizes deviations from golden word count in both directions. Terse is penalized much harder than verbose because the golden is already maximally compressed.
  - Verbose: 30% tolerance, rate 0.15 per 10% deviation, cap -0.25
  - Terse: 5% tolerance, rate 0.50 per 10% deviation, cap -0.25
- **Fatal flaw gate**: caps score at 0.4 if a fundamental failure is detected
- **Tagging gate**: fails the test if tagging score < 3/5
- **Pass threshold**: 0.6

Fatal flaws include:
- Sounds like a Zoom/Copilot summary
- Ignores user's notes and rewrites from transcript
- Drowns user's notes in AI content
- Anchors on sparse notes and misses important topics

## History of what we've tried

Understanding what failed and why prevents repeating mistakes.

### Round 1: sf-* variants (task description changes)

Variants: sf-frame, sf-both, sf-plain, sf-gate. Changed task from "scan for 2-3 gaps" to "complete their notes." All variants exploded in verbosity (2-3x golden). **Lesson:** The "2-3 things" phrasing is load-bearing — loosening it removes the verbosity ceiling.

### Round 2: frame, example, rules variants

Tested three levers independently. **frame** (model IS the user, not an analyst) won decisively: +5pp overall, +9pp on sparse cases, fixed "you/your" perspective. **rules** (explicit "no you/your", "chronological order") didn't work — rules can't patch a frame problem. **example** helped but didn't fix chronological ordering.

### Round 3: chronology experiments

Variants: no-scaffold, catch-up, multi-topic-qualifier, no-scaffold+catch-up. Targeted the remaining front-loading issue. **Root cause:** two concrete structural instructions ("their ordering is the scaffold", "use the user's own topic names as headers") override the abstract "follow the meeting's order." Concrete beats abstract.

### Round 4: gate variants + alternative framings

Tested gate-ex3 (enhanced examples), combined-compress (per-bullet word limits), combined-ex3 (removed Example 3), sting (emotional framing). **Winner: gate-ex3 (+2pp)** — better examples improved sparse/no-notes cases. Key lessons: emotional framing licenses verbosity (sting density 2.9/5); per-bullet limits cause bullet proliferation not selectivity (49.7 bullets vs 25.3); Example 3 is load-bearing for sparse-notes restraint.

### Round 5: reasoning gates (inline reasoning before notes)

Variants: reason-inline (v1), reason-inline-v2, reason-inline-v3, reason-inline-v4. All write 1-3 sentences before `---NOTES---`. **Winner: v2 (+0.025 over gate)** but not promoted — voice dropped to 3.7, conciseness to 0.74. Key finding: reasoning that *characterizes* meeting nature calibrates register; reasoning that *lists* content creates a checklist the model exhaustively covers (v4 scored 0.938 on no-notes-personal but 0.310 on dense-review-q1). Third-person reasoning text primes analyst mode in the notes. **Direction:** anti-listing constraint + first-person framing + 1-2 sentence limit.

### Round 6: first-person reasoning fix (v5, v6)

Acted on Round 5's recommendation. Both variants add 1-2 sentence reasoning with first-person framing ("Write your thought/thinking") and anti-listing language. 4 variants (gate, v2, v5, v6), 8 test cases, 2 runs each.

- **v5** — Nature characterization: "what kind of meeting this was... what makes this one different. Write your thought"
- **v6** — Importance calibration + anti-listing: "What would sting to forget? Are conclusions enough, or does reasoning matter? Write your thinking — not a list of what was covered."

| Variant | Avg | dense-bus | no-notes-pers | dense-int | dense-q1 | dense-q4 | sparse-short | sparse-fb | no-notes-cplx |
|---|---|---|---|---|---|---|---|---|---|
| gate | 0.791 | 0.909 | 0.775 | 0.761 | 0.931 | 0.910 | 0.805 | 0.823 | 0.416 |
| v2 | 0.787 | 0.858 | 0.908 | 0.738 | 0.773 | 0.929 | 0.800 | 0.678 | 0.609 |
| v5 | 0.802 | 0.888 | 0.878 | 0.736 | 0.817 | 0.877 | 0.900 | 0.732 | 0.588 |
| **v6** | **0.829** | 0.883 | 0.931 | 0.700 | 0.906 | 0.898 | 0.862 | 0.793 | 0.664 |

**Winner: v6 (+0.038 over gate).** Best average across all rounds. Voice 4.0 (from v2's 3.6), conciseness 0.87 (from v2's 0.78), ~20% more words than gate (512w vs 413w) with similar bullet density (15.4 w/bullet vs 15.9). dense-review-q1 essentially solved (0.906, only -0.025 vs gate). Large sparse/no-notes gains: no-notes-complex +0.248, no-notes-personal +0.156, sparse-short +0.057. Main cost: dense-interview -0.061 (editorializing on interview-format meetings).

v6 was promoted to production. v5's nature characterization is slightly better on emotional/feedback cases (sparse-short 0.900 vs 0.862) but less robust overall.

### Round 7: action items structure (actions-remove, actions-explicit)

Variants: actions-remove, actions-explicit. Small edit to v6's user prompt Structure guideline. v6 prohibited "Action Items" sections alongside "Key Decisions"; actions-remove drops "Action Items" from the prohibition (just bans recap sections like "Key Decisions", "Key Takeaways"). actions-explicit goes further and explicitly instructs a `### Next steps` section for concrete commitments. 4 variants (gate, v6, actions-remove, actions-explicit), 8 test cases, 3 runs each.

| Variant | Avg | dense-bus | no-notes-pers | dense-int | dense-q1 | dense-q4 | sparse-short | sparse-fb | no-notes-cplx |
|---|---|---|---|---|---|---|---|---|---|
| gate | 0.756 | 0.880 | 0.756 | 0.735 | 0.903 | 0.817 | 0.749 | 0.775 | 0.438 |
| v6 | 0.791 | 0.871 | 0.880 | 0.692 | 0.831 | 0.923 | 0.791 | 0.786 | 0.553 |
| **actions-remove** | **0.815** | 0.864 | 0.890 | 0.810 | 0.833 | 0.908 | 0.821 | 0.834 | 0.561 |
| actions-explicit | 0.793 | 0.843 | 0.897 | 0.713 | 0.824 | 0.908 | 0.828 | 0.771 | 0.563 |

**Winner: actions-remove (+0.024 over v6, +0.059 over gate).** Fixed the dense-interview regression from Round 6: 0.810 vs v6's 0.692 (+0.118). Also improved sparse-feedback: 0.834 vs v6's 0.786. Voice held at 4.0, additions jumped to 4.4. Conciseness slightly lower (0.84 vs v6's 0.86). actions-explicit was worse (0.793) — explicitly instructing a "Next steps" section was less effective than simply removing the prohibition.

**actions-remove was promoted to production.** Open issues: no-notes-complex still below 0.8 (0.561), third-person voice slips on no-notes cases.

### Round 8: calibrate + compress (interview coverage, bullet compression)

Two independent variants targeting issues found in eval-8 (interview — sparse reaction-paragraph notes for a clear-reject interview):

**Problem 1 — Output too short for interviews.** The model treated the user's reaction paragraph as "user has it covered" and produced ~160w. For interviews, the referenceable surface area is larger (hiring decisions, feedback write-ups, candidate comparisons). Root cause: the "2-3 things" / "3 topics" numeric ceiling in the system prompt.

**Problem 2 — Bullets too long.** Individual bullets use formal noun phrases instead of casual shorthand. The prompt says "write fragments" and "compress every bullet" but the model doesn't match.

- **calibrate** — system prompt only. Removes numeric caps ("2-3 things" → "The things", "3 topics" → "the substance"), adds "How much did your notes actually cover?" to reasoning step. Tests whether the selectivity frame alone (without numeric ceiling) is sufficient.
- **compress** — user prompt only. Adds a second compression YES/NO example showing register-level compression (formal noun phrases → casual shorthand). Tests whether a better compression example teaches shorter bullets.

New test case: `sparse-interview` — interview with sparse reaction-paragraph notes (not structured notes). Tests whether the model can produce appropriately-detailed interview notes from a user brain-dump.

### Round 9: calibrate + compress + split-example

Three variants tested independently. 9 test cases (added sparse-interview), 3 repeats each.

- **calibrate** — system prompt. Removes numeric caps ("2-3 things" → "The things"), adds "How much did your notes actually cover?" to reasoning step.
- **compress** — user prompt. Adds YES/NO compression example (formal noun phrases → casual shorthand).
- **split-example** — user prompt. Example 2 modified so transcript tempts semicolon chaining, output demonstrates correct split. Goldens updated: chained bullets split in 4 goldens. Judge updated: deterministic `chain_bullets` metric added.

| Variant | Avg | dense-bus | dense-int | dense-q1 | dense-q4 | no-cplx | no-pers | sp-fb | sp-int | sp-short |
|---|---|---|---|---|---|---|---|---|---|---|
| baseline | 0.788 | 0.820 | 0.764 | 0.847 | 0.928 | 0.534 | 0.985 | 0.808 | 0.613 | 0.795 |
| calibrate | 0.746 | 0.771 | 0.667 | 0.691 | 0.881 | 0.741 | 0.874 | 0.576 | 0.696 | 0.818 |
| compress | 0.750 | 0.718 | 0.713 | 0.823 | 0.846 | 0.530 | 0.925 | 0.838 | 0.523 | 0.829 |
| **split-example** | **0.815** | 0.799 | 0.738 | 0.878 | 0.913 | 0.603 | 0.938 | 0.847 | 0.730 | 0.885 |

**calibrate (0.746, -0.042) — FAILED.** Conciseness collapsed to 0.64, word count ballooned 45% (708w avg vs 487w). sparse-feedback exploded to 2.64x golden. Only no-notes-complex improved (0.741 vs 0.534). **Confirms Round 1: the numeric ceiling is load-bearing.**

**compress (0.750, -0.038) — FAILED.** Avg w/b unchanged (15.2 vs 15.1). sparse-interview regressed from tagging gate failures. A single YES/NO compression example is insufficient to override RLHF-trained verbosity.

**split-example (0.815, +0.027) — WINNER.** Large sparse/no-notes gains: sparse-interview +0.117, sparse-short +0.090, no-notes-complex +0.069. No meaningful dense-case regression. Voice improved to 4.1, clarity to 4.8. However, chain_bullets did NOT decrease (chain rate 41% vs baseline's 38%). The splitting example didn't reduce chaining. The prompt's own heavy em-dash usage likely overrides both the instruction and the example (see Known failure modes: Prompt register contradiction).

Avg w/b across all variants: baseline 1.50x golden, split-example 1.56x golden. The w/b gap remains the most persistent unsolved problem.

**split-example promoted to production.**

### Round 10: terse-register + clean-emdash (prompt register test)

Two variants testing whether the prompt's linguistic style drives output w/b. 4 variants (baseline, split-example, terse-register, clean-emdash), 9 test cases, 4 repeats each (144 runs).

- **terse-register** — Full rewrite of instruction text in terse fragment style. 25% fewer words in user prompt. All em-dashes removed. Same semantic content.
- **clean-emdash** — Only em-dashes and semicolons replaced with periods/colons. No restructuring. Minimal intervention.

| Variant | Avg | dense-bus | dense-int | dense-q1 | dense-q4 | no-cplx | no-pers | sp-fb | sp-int | sp-short |
|---|---|---|---|---|---|---|---|---|---|---|
| baseline | 0.791 | 0.803 | 0.698 | 0.871 | 0.931 | 0.556 | 0.910 | 0.799 | 0.661 | 0.892 |
| split-example | **0.810** | 0.841 | 0.758 | 0.875 | 0.909 | 0.553 | 0.909 | 0.840 | 0.745 | 0.856 |
| terse-register | 0.790 | 0.843 | 0.713 | 0.862 | 0.886 | 0.546 | 0.892 | 0.799 | 0.705 | 0.865 |
| clean-emdash | 0.791 | 0.867 | 0.730 | 0.758 | 0.915 | 0.548 | 0.913 | 0.820 | 0.692 | 0.874 |

**terse-register (0.790, -0.001) — FAILED.** w/b unchanged (1.55x vs baseline's 1.52x). Verbosity actually INCREASED (+10% word count) from bullet proliferation — the model wrote more fragments, not shorter ones. Conciseness dropped to 0.80. Voice dropped to 3.9. A shorter prompt did NOT produce shorter output.

**clean-emdash (0.791, =baseline) — NULL RESULT.** w/b: 1.50x (≈baseline). Chain bullets: +4.1 (slightly better than baseline's +4.5 but within noise). The model doesn't care about the prompt's punctuation. dense-review-q1 regressed to 0.758 (density 2-3 from over-enrichment), but this is run variance, not a systematic effect.

**split-example confirmed at 0.810 (+0.019 over baseline).** With 4 repeats, consistent with Round 9's +0.027. sparse-short regressed slightly (additions 5→4, missing "pattern of exclusion" framing) but gains on sparse-interview/feedback outweigh.

**Key finding: principle #15 refuted.** The model's ~15 w/b (1.5x golden) is invariant to prompt register. This is an RLHF-trained default, not a prompt-driven behavior. All prompt-level attempts to reduce w/b have now failed (Rounds 4, 9, 10). w/b should be treated as a fixed model constraint.

**Key metrics:** avg w/b ratio vs golden (target: <1.3x, currently 1.50x), chain_bullets rate (currently ~40%), density score (must hold at 3.7+).

**Regression risk:** Low. Semantic content is unchanged. The risk is that terser instructions are harder for the model to parse, which could hurt on edge cases. Watch for tagging errors and structural problems.

### Round 11: no-notes-frame + clean-emdash-v2

Two variants. 3 variants (baseline, no-notes-frame, clean-emdash-v2), 9 test cases, 4 repeats each (108 runs).

- **no-notes-frame** — user prompt only. Changes the "If no notes are provided" section: removes "senior analyst" (frame break with ghostwriter), removes "8–12" numeric cap, stays in second-person ("Write what you'd have taken"). Targets no-notes-complex (0.553 persistent low).
- **clean-emdash-v2** — system + user prompt. Rebases the Round 10 clean-emdash changes on the new baseline (split-example). Tests whether em-dash removal has any effect when combined with the split example.

| Variant | Avg | dense-bus | dense-int | dense-q1 | dense-q4 | no-cplx | no-pers | sp-fb | sp-int | sp-short |
|---|---|---|---|---|---|---|---|---|---|---|
| baseline | 0.794 | 0.863 | 0.730 | 0.930 | 0.873 | 0.567 | 0.900 | 0.743 | 0.690 | 0.852 |
| **no-notes-frame** | **0.802** | 0.843 | 0.754 | 0.853 | 0.892 | 0.626 | 0.902 | 0.721 | 0.760 | 0.868 |
| clean-emdash-v2 | 0.787 | 0.813 | 0.725 | 0.871 | 0.879 | 0.607 | 0.929 | 0.728 | 0.709 | 0.823 |

**no-notes-frame (0.802, +0.008) — PROMISING.** Target case no-notes-complex improved from 0.567 to 0.626 (+0.059), the highest score for this case outside of the failed calibrate variant. Model generated more bullets (14.3 vs 11.8) and more words (354 vs 335) — moving toward the golden's 30b/438w. no-notes-personal held at 0.902 but word count inflated from 1.14x to 1.42x golden (419w vs 336w). Notes-present cases were unchanged (same prompt text) — any movement is run variance. The mechanism works: removing the "senior analyst" frame break and "8–12" cap allows more content on no-notes cases. But the no-notes-personal inflation is a yellow flag.

**clean-emdash-v2 (0.787, -0.007) — NULL.** Chain bullets improved on dense-review-q1 (+6.5 → -8.5) but worsened on dense-review-q4 (+16.3 → +22.0). Average chain diff +3.7 (vs baseline's +4.6) is inconsistent across cases. This is the second null result for em-dash removal (Round 10 was the first). **Em-dash removal as a strategy is closed** — the model's chaining behavior is not driven by the prompt's punctuation.

**Key finding:** The "senior analyst" phrasing in the no-notes section IS a frame break. Removing it and the "8–12" cap allows the model to generate more content for complex no-notes conversations without breaking simpler no-notes cases. However, the improvement is modest (+0.059) and no-notes-personal inflation needs monitoring. Worth iterating: a version with a softer selectivity anchor (replacing the numeric cap with a qualitative one) could maintain gains while controlling inflation.

**no-notes-frame promoted to production.** Em-dash removal closed as a strategy after two null results (Rounds 10, 11).

**Open issues:** no-notes-complex still at 0.626 (below 0.8 target), dense-interview at 0.730-0.754, sparse-feedback volatile (0.721-0.743). Words-per-bullet remains at ~1.5x golden (RLHF floor). Chain bullets remain at ~+4 vs golden across all variants.

### Round 12: full-example + split-notes (worked example, deterministic switching)

Two variants targeting the persistent w/b ratio and no-notes coverage. 3 variants (baseline, full-example, split-notes), 8 test cases (dense-business excluded — used as the in-prompt example), 4 repeats each (96 runs).

**Research context:** Deep research (Tasks #14, #16) identified: (A) the model has a fixed "output budget" — it distributes total words into fewer, longer bullets rather than many short ones (Round 4 confirmed: word limits caused proliferation at same total word count); (B) Granola.AI achieves terse fragments with off-the-shelf frontier models, proving the problem IS solvable at the prompt level; (C) short synthetic examples (3-4 lines) teach format but not judgment at scale (principle #7); (D) deterministic prompt switching eliminates 6 conditional instructions the model reads regardless of mode.

- **full-example** — user prompt. Adds a third worked example: complete 1,800-word real transcript segment (dense-business lines 70-109) + sparse user notes + 13-bullet golden at 6.5 w/b (7 [ai] + 6 [noted]). The transcript includes ~70% irrelevant content (Microsoft analogy, Perplexity dinner anecdote, mishearing confusion) that the golden correctly omits, teaching confident omission at scale. Tests whether a full worked example can teach both compression AND judgment.
- **split-notes** — user prompt + custom loader. Two separate user.txt files selected by `hasNotes` flag. Notes-present prompt removes "If no notes are provided" section. No-notes prompt is a complete rewrite: simplified tagging (all [ai]), one adapted example, removed notes-specific guidelines ("user's notes are canonical", "Default is nothing", conflict handling). Tests whether eliminating irrelevant instructions improves each mode.

| Variant | Avg | dense-int | dense-q1 | dense-q4 | no-cplx | no-pers | sp-fb | sp-int | sp-short |
|---|---|---|---|---|---|---|---|---|---|
| baseline | 0.778 | 0.730 | 0.864 | 0.912 | 0.582 | 0.930 | 0.808 | 0.742 | 0.654 |
| full-example | 0.727 | 0.746 | 0.846 | 0.915 | 0.582 | 0.904 | 0.700 | 0.680 | 0.443 |
| split-notes | 0.751 | 0.738 | 0.830 | 0.908 | 0.500 | 0.894 | 0.815 | 0.675 | 0.646 |

**full-example (0.727, -0.051) — FAILED.** The dense-business example biased the model toward that register. Catastrophic on sparse cases: sparse-short 0.443 (-0.211), sparse-feedback 0.700 (-0.108), sparse-interview 0.680 (-0.062). The model learned "be brief" but expressed it by cutting bullets entirely (0.73x golden bullet count) rather than shortening them. w/b ratio unchanged (1.46x vs baseline's 1.47x). One positive signal: total word count dropped to 1.17x golden (from 1.31x) and conciseness improved to 0.89 (from 0.84). The example taught selectivity but over-applied it.

**split-notes (0.751, -0.027) — FAILED.** The separate no-notes prompt didn't help no-notes cases — no-notes-complex actually worsened (0.500 vs 0.582). Small win on sparse-feedback (0.815 vs 0.808) but losses everywhere else. Removing the conditional instructions had no measurable benefit. The model doesn't seem confused by seeing instructions for the other mode.

**Key findings:**

17. **Full worked examples teach selectivity, not compression.** The dense-business example successfully made the model more selective (fewer bullets, lower word count, better conciseness scores). But it over-corrected on sparse cases — it learned "cut aggressively" from a case where the user had dense notes, then applied that to cases where the user needs MORE content. A worked example from ONE register biases toward that register. Any future full-example attempt would need examples from multiple registers (dense + sparse + no-notes), which would make the prompt very long (principle #4: prompt length signals output length).

18. **Deterministic prompt switching is neutral.** The model handles conditional instructions fine — removing them doesn't help. The no-notes problem is about content generation depth, not instruction confusion. This closes the hypothesis that conditional instructions degrade performance.

19. **The model's compression mechanism is bullet-count, not bullet-length.** Across 12 rounds, every attempt to influence w/b has failed. But the model CAN and DOES adjust total output by changing how many bullets it generates. The full-example variant proved this: conciseness 0.89, word ratio 1.17x — but at 0.73x bullet count. The model has a "verbosity dial" but it operates on bullet count, not bullet length. Per-bullet w/b appears to be a fixed property of the model.

**Open issues:** no-notes-complex remains the weakest case (0.500-0.582). w/b ratio locked at ~1.45x golden across all 12 rounds. sparse-interview and dense-interview both below 0.75. The fundamental challenge: making the model produce MORE bullets that are each SHORTER — the opposite of its natural tendency.

### Round 13: temp, no-tags, compress-pass, gemini (parameter + format experiments)

Five variants testing non-prompt-level interventions after 12 rounds of prompt changes failed to move w/b. 5 variants (baseline, temp-0.3, no-tags, compress-pass, gemini), 8 test cases, 4 repeats each (160 runs).

**Research context:** Deep research (Task #a7ee0fd) identified: (A) Anthropic explicitly trains against short bullet points ("NEVER output a series of overly short bullet points"); (B) Granola uses plain text without bullet tags; (C) [noted]/[ai] tagging creates completeness pressure (principle #10); (D) API parameters (temperature, max_tokens) had never been tested; (E) two-pass compression (post-pass) solves TTFT concerns of the earlier pre-pass approach.

- **temp-0.3** — temperature 0.3 via `__config` passthrough. Same prompt. Tests whether lower temperature improves consistency.
- **no-tags** — user prompt. Removed entire Tagging section, removed all [noted]/[ai] tags from examples, changed format to `- content` instead of `- [tag] content`, removed tag references from guidelines. Tests whether tags create completeness pressure.
- **compress-pass** — two-pass. Pass 1: generate notes normally (callLLM direct). Pass 2: provider executes compression prompt ("compress each bullet to under 10 words, keep structure and tags"). Tests post-hoc compression.
- **gemini** — model override to gemini-3-pro-preview via same Helsing proxy. Same prompt. Tests whether w/b floor is Claude-specific (Anthropic training signal hypothesis).

| Variant | Avg | dense-int | dense-q1 | dense-q4 | no-cplx | no-pers | sp-fb | sp-int | sp-short |
|---|---|---|---|---|---|---|---|---|---|
| baseline | 0.783 | 0.746 | 0.896 | 0.901 | 0.557 | 0.858 | 0.726 | 0.698 | 0.884 |
| **temp-0.3** | **0.800** | 0.685 | 0.898 | 0.906 | 0.578 | 0.919 | 0.825 | 0.738 | 0.851 |
| **no-tags** | **0.795** | 0.773 | 0.823 | 0.909 | 0.533 | 0.946 | 0.843 | 0.666 | 0.869 |
| compress-pass | 0.749 | 0.687 | 0.885 | 0.874 | 0.513 | 0.915 | 0.775 | 0.605 | 0.742 |
| gemini | 0.619 | 0.619 | 0.749 | 0.613 | 0.396 | 0.716 | 0.536 | 0.707 | 0.613 |

**temp-0.3 (0.800, +0.017) — PROMISING.** Best overall score. Large gains on sparse/no-notes cases (sparse-feedback +0.099, no-notes-personal +0.061, sparse-interview +0.040). w/b ratio essentially unchanged (1.46x vs 1.50x). This is a quality/consistency lever, not a compression lever. Clarity dropped 4.8 → 4.5 (possible formulaic language from low temperature). Needs qualitative review of actual outputs to determine if the score improvement reflects genuine quality or just reduced variance.

**no-tags (0.795, +0.012) — BREAKTHROUGH ON W/B.** First variant in 13 rounds to meaningfully move w/b: 1.50x → 1.20x (−20%). Also improved bullet count (0.83x → 0.89x golden), chain bullets (+5.1 → −0.7), density (3.6 → 3.9), conciseness (0.83 → 0.90), and voice (3.9 → 4.0). Dense-review-q1 regressed (0.896 → 0.823) due to structural formatting breakdown — without tags the model loses the consistent `- [tag] content` pattern and outputs bare text under headings. Additions slightly lower (4.2 → 4.0). **However, tags are core to the product UX** — cannot simply remove them without understanding what specifically drives the improvement and whether it can be achieved while keeping tags.

**Unresolved question:** Does the judge score no-tags higher partly because untagged output *looks* more natural to the judge LLM? The w/b metric is mechanically affected (tag tokens add ~1 word per bullet, accounting for ~30% of the w/b gap). A controlled test is needed: strip tags from baseline output before judging, compare scores. This would isolate judge bias from genuine behavioral improvement.

**compress-pass (0.749, -0.034) — MIXED.** Same w/b as no-tags (1.20x) but voice dropped to 3.6 (compression strips tone) and clarity dropped to 4.5 (compression can make bullets ambiguous). Word count nearly perfect (0.97x golden) but over-compresses some cases. Chain bullets unchanged (+5.3). Conciseness excellent (0.94). The mechanism works (brute-force post-hoc compression) but the quality cost is too high in current form.

**gemini (0.619, -0.164) — FAILED.** Catastrophic quality drop across all dimensions: voice 3.0, clarity 3.8, additions 3.1. Bullet count 0.66x golden (massive under-generation). The prompt is tuned for Claude's behavior patterns and Gemini cannot follow it. Not viable without a separate prompt. Does confirm Gemini has lower w/b (1.28x) but this is from under-generating, not better compression.

**Key findings:**

20. **Tags are the primary driver of over-chaining.** no-tags eliminated excess chain bullets (+5.1 → −0.7) while compress-pass didn't help at all (+5.3). When tagging every line, the model creates long runs of [ai] bullets exploring topics. Without tags, it naturally produces more focused groupings.

21. **Temperature 0.3 is a quality lever, not a compression lever.** Improves score (+0.017) without affecting w/b. Useful for stacking with other changes but doesn't solve the core problem.

22. **Two-pass compression achieves target w/b but damages voice.** compress-pass proves the w/b IS achievable (1.20x) while keeping tags, but the compression step strips natural tone (voice 3.6 vs 4.0). A better compression prompt that preserves voice could recover this.

23. **Gemini cannot use Claude-optimized prompts.** The prompt is deeply tuned for Claude's instruction-following patterns. Cross-model testing requires per-model prompt optimization.

### Round 14b: reasoning architecture variants (structured-reason, section-scaffold, fast-reason)

Three variants testing whether decoupling reasoning from note-writing reduces w/b ratio and analytical tone bleed. 4 variants (baseline, structured-reason, section-scaffold, fast-reason), 9 test cases, 3 repeats each (108 runs).

- **structured-reason** — system prompt. Replaces free-form reasoning with structured fields (`Meeting:`, `Register:`, `Capture:`) before `---NOTES---`. Single call, no latency change.
- **section-scaffold** — two calls. Haiku generates section headers with characterizations of what to capture (not what was discussed). Main model fills in notes under each section.
- **fast-reason** — two calls. Haiku generates casual 2-3 sentence characterization ("Hey, the big thing from that call was..."). Main model reads this as context from a "colleague."

| Variant | Avg | dense-bus | dense-int | dense-q1 | dense-q4 | no-cplx | no-pers | sp-fb | sp-int | sp-short |
|---|---|---|---|---|---|---|---|---|---|---|
| baseline | 0.799 | 0.835 | 0.748 | 0.891 | 0.923 | 0.535 | 0.882 | 0.834 | 0.774 | 0.766 |
| structured-reason | 0.805 | 0.877 | 0.752 | 0.921 | 0.921 | 0.540 | 0.928 | 0.716 | 0.738 | 0.851 |
| section-scaffold | 0.492 | 0.463 | 0.267 | 0.407 | 0.543 | 0.584 | 0.655 | 0.383 | 0.529 | 0.596 |
| fast-reason | 0.778 | 0.894 | 0.725 | 0.880 | 0.913 | 0.502 | 0.897 | 0.703 | 0.741 | 0.750 |

**section-scaffold (0.492, -0.307) — FAILED.** Catastrophic. Haiku's section headers bleed corporate framing into the final output ("Performance feedback — specific examples and perception concerns"). Over-fragments into 5-8 sections. Word count 2.23x golden, bullet proliferation 1.40x. Voice 2.8, density 2.3.

**structured-reason (0.805, +0.006) — NULL.** Marginal average improvement. The structured fields work mechanically (Register field correctly identifies user's style) and prevent analytical tone bleed (voice 4.0). But w/b ratio unchanged (1.48x vs 1.51x). sparse-feedback regressed to 0.716 (-0.118) — the Capture field encourages comprehensive coverage on emotionally complex cases. sparse-short improved to 0.851 (+0.085) from better section structure.

**fast-reason (0.778, -0.021) — NULL.** Best conciseness (1.08x word ratio) and voice (4.1) of any variant ever tested. The casual colleague note successfully prevents analytical register. But additions drop to 4.0 (vs 4.3) — the model interprets casual context as license to be terse, cutting too much.

**Key findings:**

24. **w/b ratio is invariant to reasoning architecture.** Three different reasoning decoupling strategies all land at 1.48-1.60x, same as baseline's 1.51x. Combined with Rounds 4, 9, 10, 12 (prompt-level attempts), the ~1.5x floor is confirmed across both prompt text and prompt architecture. No prompt-level approach has moved this metric.

25. **Two-call architectures don't justify their complexity.** Both section-scaffold and fast-reason add latency and Haiku cost for results that are equivalent to or worse than baseline. The Haiku pre-pass either over-structures (scaffold) or under-primes (fast-reason).

26. **Register decoupling works for voice but hurts content.** fast-reason achieves 4.1 voice and 0.89 conciseness — best ever — but at the cost of additions (4.0). The model treats casual context as permission to omit.

### Round 14a: tagging experiments (tag-strip, asymmetric-tags, light-tags, no-tags)

Controlled follow-up to R13's no-tags w/b breakthrough (1.50x→1.20x). Tests judge bias, partial tagging, and replication. 5 variants, 9 test cases (dense-business restored), 2 repeats each (90 runs).

- **tag-strip** — Same prompt as baseline. Provider strips tags from output before judging. Controls for judge bias.
- **asymmetric-tags** — Only `[noted]` on user-sourced lines. AI additions untagged.
- **light-tags** — Both tags, tagging instructions reduced to a single line.
- **no-tags** — R13 variant rerun with all 9 cases.

| Variant | Avg | dense-bus | dense-int | dense-q1 | dense-q4 | no-cplx | no-pers | sp-fb | sp-int | sp-short |
|---|---|---|---|---|---|---|---|---|---|---|
| baseline | 0.798 | 0.815 | 0.791 | 0.842 | 0.905 | 0.664 | 0.846 | 0.783 | 0.661 | 0.877 |
| tag-strip | 0.781 | 0.802 | 0.650 | 0.784 | 0.872 | 0.572 | 0.938 | 0.832 | 0.682 | 0.900 |
| asymmetric-tags | 0.778 | 0.784 | 0.638 | 0.822 | 0.848 | 0.589 | 0.892 | 0.797 | 0.684 | 0.946 |
| light-tags | 0.751 | 0.830 | 0.695 | 0.822 | 0.862 | 0.477 | 0.898 | 0.726 | 0.700 | 0.750 |
| no-tags | 0.798 | 0.800 | 0.774 | 0.849 | 0.903 | 0.533 | 0.954 | 0.813 | 0.632 | 0.923 |

**tag-strip (0.781, −0.017) — NULL.** Judge is NOT biased against tags — scored below baseline. w/b difference (1.50x→1.43x) is mechanical (tag tokens ~0.07x).

**asymmetric-tags (0.778, −0.020) — FAILED.** Model can't reliably implement asymmetric tagging — mistagged lines in both directions. dense-interview 0.638.

**light-tags (0.751, −0.047) — FAILED.** Worst overall. no-notes-complex 0.477. Tagging instructions are structural scaffolding — reducing them hurts across the board.

**no-tags (0.798, =baseline) — NULL (confirms R13).** w/b 1.21x replicates, but voice (3.6), readability (4.3), additions (3.8) all drop. Lateral move, not improvement.

**Key findings:**

27. **[ai] tag drives verbosity.** w/b decomposes: baseline 1.50x → tag-strip 1.43x (mechanical) → no-tags 1.21x (behavioral). Judge bias ruled out by tag-strip control.

28. **Tags are load-bearing scaffolding.** Reducing (light-tags) or removing (no-tags) tags trades w/b for voice/readability. The tagging instructions guide the model's note-writing approach, not just classification.

**Tagging as a lever is closed.** All configurations tested — none improve overall quality.

**Open issues after R14:** no-notes-complex still below 0.6. w/b locked at ~1.5x (RLHF floor). sparse-feedback volatile.

### Round 15: conditional tagging (conditional-tags)

No-tags prompt for no-notes cases, baseline for notes-present. 2 variants, 9 cases, 4 repeats (72 runs).

**conditional-tags (0.800, +0.003) — NULL.** no-notes-personal held (0.923) with better w/b (1.54x vs 1.94x), but no-notes-complex regressed (0.503, −0.082) — removing classification pressure also reduces content generation on a case that already under-generates.

**Open issues after R15:** no-notes-complex below 0.6 across 15 rounds. w/b locked at ~1.5x. Prompt-level improvement space exhausted.

### Round 16: suffix-tags, jot-frame, first-token (tag position + frame verb)

Three variants testing whether tag position and frame-level keywords affect w/b. 4 variants (baseline, suffix-tags, jot-frame, first-token), 9 test cases, 4 repeats each.

- **suffix-tags** — Tags moved from prefix to suffix: `- content [ai]` instead of `- [ai] content`. Hypothesis: model generates content BEFORE encountering classification token, avoiding elaboration priming.
- **jot-frame** — System prompt only. "Write what you'd have written" → "Jot down what you'd have jotted." Frame verb change (not register change).
- **first-token** — User prompt. Added "Start every bullet with a proper noun, number, or action verb. Never start with: The, A, An, They, It, There, We, This."

| Variant | Avg | w/b ratio |
|---|---|---|
| baseline | 0.799 | 1.52x |
| suffix-tags | 0.778 | 1.41x |
| **jot-frame** | **0.800** | **1.40x** |
| first-token | 0.758 | 1.49x |

**suffix-tags (0.778, −0.021) — FAILED.** w/b improved (1.41x) but voice regressed (3.8). Root cause: suffix position causes content merging — model combines user+AI content into single lines then tags `[noted]`, sometimes fabricating detail and tagging it `[noted]`. Structural flaw intrinsic to suffix positioning.

**jot-frame (0.800, +0.001) — WINNER.** w/b improved from 1.52x to 1.40x without any regression. "Jot" primes terse fragment generation at the conceptual level (principle #13 — frame keywords affect output register). All quality gates pass.

**first-token (0.758, −0.041) — NOISE.** No w/b effect. Constraint too rigid for varied content.

**jot-frame promoted to production.** Single word change with measurable w/b improvement.

29. **Frame verbs prime output density.** "Jot" vs "write" is a conceptual-level keyword change that affects generation behavior. Unlike register changes (Round 10 terse-register, null), frame verb changes operate on the model's understanding of the task, not its linguistic style.

### Round 17: generate-then-tag (two-pass architecture)

Two-pass approach: Pass 1 generates terse untagged notes (reuses proven no-tags prompt, 1.21x w/b). Pass 2 adds [noted]/[ai] prefix tags via classification-only prompt — explicitly forbidden from changing content. 2 variants (baseline, generate-then-tag), 9 test cases, 4 repeats each.

| Variant | Avg | w/b ratio |
|---|---|---|
| baseline | 0.798 | 1.44x |
| **generate-then-tag** | **0.790** | **1.26x** |

**generate-then-tag (0.790, −0.008) — WINNER.** w/b dropped from 1.44x to 1.26x — **the first variant in 17 rounds to break the ~1.5x floor while maintaining quality.** All gates pass. Two regressions: no-notes-complex (0.531, −0.116 from length penalty — too terse at 0.64x golden words) and sparse-interview (−0.098, marginal voice loss). The mechanism works: separating generation from classification removes the tag-driven elaboration pressure identified in R14a.

30. **Generation sequence, not prompt wording, drives tag-driven elaboration.** The ~0.22x w/b gap attributed to [ai] priming (R14a finding #27) is a generation sequence effect — when `[ai]` precedes content, the model elaborates. When content precedes classification (or classification happens in a separate pass), the model writes naturally terse fragments. This refines principle #16: the w/b floor is NOT an unsolvable RLHF property — it's tag-driven and addressable via architecture.

### Round 18: no-notes prompt swap (loosening constraints for no-notes cases)

Generate-then-tag's no-notes-complex regression (0.531) was caused by suppressive constraints ("Default is nothing", "User's notes are canonical") that are irrelevant when no notes exist. Tested deterministic prompt swap: detect `vars.notes?.trim()` and route no-notes cases to a loosened prompt variant. 3 variants, 9 test cases, 4 repeats each.

- **gtt-baseline** — No swap (same prompt for all cases).
- **gtt-capture** — No-notes cases use variant with "Default is nothing" and "User's notes are canonical" removed; system prompt drops "2-3" quantifier.
- **gtt-example** — Same removals + Example 2 swapped to a no-notes example.

| Variant | Avg | no-notes-complex | no-notes-personal |
|---|---|---|---|
| gtt-baseline | 0.788 | 0.531 | 0.940 |
| **gtt-capture** | **0.807** | **0.710** (+0.179) | 0.862 (−0.078) |
| gtt-example | 0.798 | 0.710 (+0.179) | 0.896 (−0.044) |

Has-notes cases use identical prompts across all three variants — score differences on those cases are pure run variance (~0.04 per case).

### Round 19: 2x2 suppression × example (isolating the mechanism)

Round 18 confounded suppression removal with the example swap. Full factorial design on no-notes cases only, 4 repeats.

- **gtt-baseline** — No changes.
- **gtt-suppress** — Suppression removal only (no example).
- **gtt-example-only** — Example swap only (no suppression removal).
- **gtt-both** — Both changes.

| | No example | Example |
|---|---|---|
| **No suppression removal** | 0.597 / 0.941 | 0.510 / 0.914 |
| **Suppression removal** | **0.730** / 0.900 | 0.719 / 0.888 |

(format: complex / personal)

**Suppression removal is the entire mechanism.** It improves no-notes-complex by +0.133 regardless of example condition. The example alone HURTS no-notes-complex (−0.087) by calibrating toward short output. The example adds nothing on top of suppression (gtt-suppress 0.815 > gtt-both 0.804).

**gtt-suppress is the winner.** The no-notes-personal regression (0.941 → 0.900, −0.041) is acceptable given the 3:1 gain-to-loss ratio on no-notes-complex.

31. **Suppressive constraints are mode-specific.** "Default is nothing" and "User's notes are canonical" are load-bearing for notes-present cases but actively harmful for no-notes cases. When no notes exist, these constraints suppress content generation on transcripts that need full coverage. Deterministic prompt switching (based on notes presence) allows mode-specific constraint tuning without cross-mode regression.

32. **In-prompt examples calibrate density, not just format.** The no-notes example (6 concise bullets for a simple transcript) taught the model to be brief on ALL no-notes cases, including complex ones that need more coverage. Examples set density expectations from their output length, independent of their instructions. This extends principle #17 (full-example taught selectivity that over-corrected on sparse cases).

### Round 20: vibes over rules (frame quality vs rule quantity)

Six variants testing whether the prompt's mode of instruction matters more than its content. Motivated by the observation that frame-level changes (Round 16's "jot" verb, Round 17's generate-then-tag) produced larger improvements than any rule-based change across 19 rounds.

Core hypothesis: the 530-word structured Guidelines section in the user prompt pulls the model out of the ghostwriter frame established by the system prompt. The model switches from "being a person at their desk" to "parsing a requirements document." Replacing or removing the guidelines should improve output by keeping the model in-frame.

**Variants:**
- **vibes** — Guidelines replaced with ~200-word natural-language narrative about how the user relates to their notes. Tests: does giving the model a mental model of the user (vibes) beat giving it rules?
- **stripped** — Guidelines removed entirely. Tests: were the guidelines net-positive at all? (Subtraction control)
- **delta-frame** — System prompt reframed as "what changed?" instead of "what would you have jotted?" Tests: does task framing drive selectivity?
- **verb-flag** — "Jot" → "Flag" in system prompt. Tests: is there a better embodied verb? (Follows Round 16's "jot" breakthrough)
- **prompt-artifact** — Guidelines rewritten as terse bullet fragments (prompt register matches output register). Tests: does density-level register matching work? (Note: Round 10 terse-register was null, but this uses note-style bullets vs terse prose)
- **anti-helpful** — System prompt appends: "thorough notes feel productive when you write them and useless when you read them." Tests: does explicitly inverting the helpfulness gradient toward selectivity work? (Differs from Round 4 "sting" — that framed inclusion emotionally; this frames exclusion emotionally)

**Expected signals:** vibes and stripped are the key comparison — if both beat baseline, subtraction is the mechanism. If vibes beats stripped, the narrative adds value. delta-frame and verb-flag test orthogonal system-prompt hypotheses. prompt-artifact tests against principle #15. anti-helpful tests a new emotional framing direction.

### Ideas for future rounds

- **Production implementation of generate-then-tag.** The two-pass architecture needs to be implemented in the Rust backend (currently single-pass). See production discussion below.
- **No-notes-personal tuning.** The suppression removal causes ~1.74x golden word count on personal conversations. Could be addressed by adding a softer restraint to the no-notes variant, or may be acceptable as-is.

## The eval loop

Prompt improvement follows an iterative loop. Each round tests specific hypotheses and produces evidence that feeds the next round. The `/eval-loop` skill automates this workflow.

1. **Review** — Read the eval guide (principles, failure modes, history) and latest results. Identify the biggest remaining gaps: lowest-scoring test cases, recurring qualitative problems, room for improvement.
2. **Hypothesize** — Generate 2-4 ideas for improvement. Each must target a specific problem, have a testable mechanism ("changing X should affect Y because Z"), and be grounded in the research principles.
3. **Check against history** — For each hypothesis, verify it hasn't been tried before and doesn't contradict a research principle or risk a known failure mode. Discard repeats; refine similar-but-different ideas.
4. **Design variants** — Create 1-3 prompt variants, each testing one hypothesis. Change one thing per variant to isolate variables.
5. **Test** — Run eval (`npm run eval`). Default is 4 repeats per variant per case.
6. **Analyze** — Review results using the `/eval-review` skill. Classify each variant as WINNER, PROMISING, NULL, or FAILED.
7. **Decide** — Promote winners to production, iterate on promising results, document and abandon failures. Update this guide's history and research principles.

The loop is designed to prevent two failure modes: repeating past experiments (check step) and shipping regressions (analyze step). Each round should produce at least one new finding, even if no variant wins.

## Baseline and promotion

**The baseline variant is symlinked to the production prompts.** `prompt-variants/baseline/system.txt` and `user.txt` are symlinks to `src-tauri/resources/prompts/enhance_notes.txt` and `enhance_notes_user.txt`. Never edit baseline directly — all changes go into new variant directories, get tested, and only become production when promoted.

To promote a winning variant:
1. Copy the variant's `system.txt` → `src-tauri/resources/prompts/enhance_notes.txt`
2. Copy the variant's `user.txt` → `src-tauri/resources/prompts/enhance_notes_user.txt`
3. The baseline symlinks automatically pick up the changes — no separate copy needed
4. Clean up `promptfooconfig.yaml` (remove old variants, update description)

## Designing new experiments

When proposing prompt changes, think about:

1. **Is this a frame problem or a rule problem?** If the model is doing something wrong across many cases, the frame is likely the issue. If it's one specific behavior, a targeted change might work.
2. **Am I adding or replacing?** Adding text to the prompt increases its length, which signals longer output. Prefer replacing existing text or removing text over adding.
3. **Does this create a conflict with existing instructions?** Check whether your new instruction contradicts something already in the prompt. The concrete instruction will win.
4. **Can an example teach this instead?** Before adding a rule, consider whether a well-chosen example would demonstrate the desired behavior more effectively.
5. **What's the regression risk?** Any change that helps sparse cases might hurt dense cases. Always check both.

## Creating new variants

```bash
.AI/new-variant.sh <name>
# Edit .AI/prompt-variants/<name>/system.txt and user.txt
# Add to .AI/promptfooconfig.yaml
# Run: npm run eval
```

The script copies from baseline and includes production injections (USER IDENTITY, SPEAKER CONTEXT). If you want to base a variant on a different prompt, copy its system.txt and user.txt into the new variant directory after creation.

## Adding new test cases

Create a directory in `.AI/Examples/<name>/` with:
- `<name> - transcript` — the raw transcript
- `<name> - notes` — the user's notes (omit if no notes)
- `<name> - enhanced` — the golden reference output

The case loader (`tests/cases.mjs`) picks up any directory with a transcript and enhanced file automatically.

When adding cases, think about what gap they fill. The current suite has dense-notes, sparse-notes, and no-notes cases. Consider adding: very long meetings, multi-party meetings, highly technical meetings, meetings where the user's notes are wrong (testing the conflict-handling instruction).
