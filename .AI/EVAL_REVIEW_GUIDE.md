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

**Partially fixed (Round 19):** Root cause identified as suppressive constraints ("Default is nothing", "User's notes are canonical") that are irrelevant for no-notes cases. Deterministic prompt swap (removing these for no-notes cases) improved no-notes-complex to 0.730 — the highest score ever for this case. Trade-off: no-notes-personal regresses modestly (0.941 → 0.900) from over-extraction at 1.74x golden word count. Round 21 variants remain below 0.6 on this case (0.489–0.569) — it continues to be the hardest case in the suite.

### Interview editorializing from reasoning step
On interview-format meetings where the user is the interviewer, the reasoning step encourages analytical framing that produces editorial judgments in the notes rather than observational notes. v6 on dense-interview (0.700) adds evaluative content like "standard but not distinctive", "Most original idea" and a low-value section about the interviewer's own explanation to the candidate. It also misses the entire "His questions" section from the golden. **Partially fixed (Round 7):** actions-remove recovered dense-interview to 0.810 (+0.118 over v6) by removing "Action Items" from the list of prohibited section types, which let the model capture the candidate's questions and concrete commitments naturally.

### Bullet proliferation under compression constraints
Explicit per-bullet word limits ("aim for 10 words or fewer") cause the model to generate more bullets rather than fewer total words. The combined-compress variant averaged 49.7 bullets (vs gate's 25.3) with roughly the same total content. The constraint operates at the wrong level — it compresses individual lines but doesn't reduce selectivity. Total output length is driven by how many topics the model decides to include, not how many words per bullet.

### Prompt register contradiction (em-dashes)
The production prompt contains 12+ em-dashes in its instructions while simultaneously instructing: "If a bullet needs a semicolon or em-dash to chain ideas, split it into separate bullets." The prompt models heavy em-dash usage while telling the model not to use them. Principle #13 (instruction register primes output register) predicts the concrete exposure overrides the splitting instruction. Round 9 confirmed: split-example (which demonstrated splitting in Example 2) did not reduce chain_bullets (chain rate 41% vs baseline's 38%). The in-prompt examples already demonstrate 4-6 w/b fragments, yet the model produces 15 w/b. The prompt's own verbose register (full sentences, em-dashes, 15+ w/line in instruction text) may be the dominant register signal, outweighing the short examples.

**Partially addressed (Round 21):** clean-all (removing em-dashes from prompt text) reduced chains from +4.9 to +1.8 vs golden AND reduced w/b from 1.44x to 1.36x — confirming that prompt punctuation patterns drive output structural habits (principle #36). Instructing the model to split chains (style-guide) doesn't work — it consolidates instead. Removing the em-dashes from the prompt itself is more effective than telling the model not to use them.

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

Variants: v1-v4. All write 1-3 sentences before `---NOTES---`. v2 won (+0.025) but not promoted — voice dropped to 3.7. Key finding: reasoning that *characterizes* meeting nature calibrates register; reasoning that *lists* content creates a checklist the model exhaustively covers. Third-person reasoning primes analyst mode.

### Round 6: first-person reasoning fix (v5, v6)

Fixed Round 5's voice regression with first-person framing + anti-listing language. **v6 won (+0.038)** — "What would sting to forget? Write your thinking — not a list." Voice recovered to 4.0, large sparse/no-notes gains. Cost: dense-interview −0.061. **Promoted.**

### Round 7: action items structure (actions-remove)

Removed "Action Items" from the recap-section prohibition (kept "Key Decisions" ban). **actions-remove won (+0.024)** — fixed Round 6's dense-interview regression (+0.118). actions-explicit (instructing a Next Steps section) was worse. **Promoted.**

### Rounds 8-9: calibrate + compress + split-example

Tested removing numeric caps ("2-3 things"), adding compression examples, and modifying Example 2 to demonstrate bullet splitting. **calibrate failed** — confirms Round 1: numeric ceiling is load-bearing. **compress failed** — single YES/NO example can't override RLHF verbosity. **split-example won (+0.027)** — large sparse gains, no dense regressions. Chain bullets didn't improve despite splitting example. **Promoted.**

### Round 10: terse-register + clean-emdash (prompt register test)

Tested whether prompt linguistic style drives output w/b. terse-register (full rewrite in fragment style) was null — w/b unchanged. clean-emdash (replacing em-dashes with periods) was null. **Established principle #15: w/b is invariant to prompt register.** An RLHF-trained default, not prompt-driven.

### Round 11: no-notes-frame + clean-emdash-v2

Removed "senior analyst" frame break and "8-12" numeric cap from no-notes section. **no-notes-frame won (+0.008)** — no-notes-complex improved 0.567→0.626. Em-dash removal null for the second time — **closed as strategy.** **Promoted.**

### Round 12: full-example + split-notes (worked example, deterministic switching)

**full-example failed (−0.051)** — dense-business worked example biased toward that register, catastrophic on sparse cases. Taught selectivity but over-applied it. **split-notes failed (−0.027)** — deterministic prompt switching (separate no-notes prompt) didn't help. Model handles conditional instructions fine. Established principles #17-19: examples from one register bias toward it; deterministic switching is neutral; the model's compression mechanism is bullet-count not bullet-length.

### Round 13: temp, no-tags, compress-pass, gemini

Non-prompt interventions after 12 rounds failed to move w/b. **temp-0.3 promising (+0.017)** — quality lever, not compression lever. **no-tags breakthrough on w/b** (1.50x→1.20x) but tags are core to product UX. **compress-pass mixed** — achieves target w/b but damages voice. **gemini failed (−0.164)** — prompt is Claude-tuned. Established principles #20-23: tags drive chaining; temp is a quality lever; two-pass compression damages voice; cross-model prompts don't transfer.

### Round 14a: tagging experiments (tag-strip, asymmetric, light, no-tags)

Controlled follow-up to R13's no-tags breakthrough. **tag-strip** ruled out judge bias against tags. **asymmetric-tags failed** — model can't reliably tag only user-sourced lines. **light-tags failed** — tagging instructions are structural scaffolding. **no-tags replicated** w/b improvement but voice/readability drop. Established principles #27-28: [ai] tag drives verbosity (behavioral, not mechanical); tags are load-bearing scaffolding. **Tagging as a lever closed** — all configurations tested.

### Round 14b: reasoning architecture variants

Tested structured-reason, section-scaffold, fast-reason. All null or failed on w/b. **section-scaffold catastrophic (−0.307)** — Haiku headers bleed corporate framing. fast-reason had best-ever voice (4.1) and conciseness but cut too much content. Established principles #24-26: w/b invariant to reasoning architecture; two-call architectures don't justify complexity; register decoupling trades content for voice.

### Round 15: conditional tagging

No-tags prompt for no-notes, baseline for notes-present. **Null (+0.003).** Removing classification pressure also reduces content generation on cases that already under-generate. **Closed:** no-notes-complex below 0.6 across 15 rounds, w/b locked at ~1.5x, prompt-level improvement space exhausted.

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

**Result: failed round.** No variant cleared the +0.015 promotion threshold on clean data. anti-helpful was closest at +0.018 but driven by sparse-short gains; excluding that case it's +0.003.

| Variant | Avg | Delta | Verdict |
|---|---|---|---|
| anti-helpful | 0.804 | +0.018 | PROMISING — best conciseness (0.88, 1.25x words), no dense regressions |
| prompt-artifact | 0.790 | +0.004 | NULL — confirms principle #15 for third time |
| verb-flag | 0.785 | -0.001 | NULL — "flag" doesn't beat "jot" |
| vibes | 0.778 | -0.008 | FAILED — narrative hurts no-notes cases (−0.054 complex, −0.119 personal) |
| delta-frame | 0.766 | -0.020 | FAILED — verbosity bomb (1.70x words, conciseness 0.68) |
| stripped | 0.751 | -0.035 | FAILED — guidelines are net positive |

33. **Guidelines carry load that examples can't replace.** stripped (−0.035) proves the guidelines are net positive. Voice preservation ("canonical notes"), selectivity ("default is nothing"), and no-notes handling are load-bearing — the examples don't implicitly teach them.
34. **Framing exclusion as value works; framing inclusion emotionally doesn't.** anti-helpful's "thorough = useless" is directionally opposite to Round 4's "sting" ("what would sting to forget?"). Sting broadened inclusion. Anti-helpful narrows it (best word count, best conciseness). Emotional framing about what to INCLUDE licenses comprehensiveness; about what to EXCLUDE licenses selectivity.
35. **Analytical task reframing drives verbosity.** delta-frame's "what changed?" made the model cover MORE topics to enumerate deltas, not fewer — same mechanism as Round 4's sting. Task frames that require comprehensive assessment before filtering produce more output, not less.

### Rounds 21–22: em-dash chain reduction (style-guide, clean-all, regex-clean)

Targeted the em-dash chaining problem identified in principle #15/#16. Three approaches in Round 21: instructional style guide, broad prompt punctuation cleanup, and post-processing regex. Round 22 confirmed clean-all with n=8 (4 additional repeats merged with Round 21 data).

- **style-guide** — Added explicit style guide section to user prompt: "If a bullet chains two ideas with a semicolon or em-dash, split into separate bullets. Each bullet = one idea."
- **clean-all** — Removed em-dashes and semicolons from the prompt text itself (system + user prompt), replacing with periods or restructuring. Tests whether the model's chaining habit is mimicked from prompt punctuation.
- **regex-clean** — Post-processing pass replacing ` — ` and `;` in output with `. ` via regex.

Round 21 results (n=4):

| Variant | Avg | Delta | w/b | Verdict |
|---|---|---|---|---|
| style-guide | 0.815 | +0.021 | 1.50x | FAILED — chains reduced by consolidation (fewer, longer bullets), not splitting. w/b increased from 1.44x to 1.50x |
| clean-all | 0.807 | +0.013 | 1.36x | PROMISING |
| regex-clean | 0.797 | +0.003 | 1.39x | FAILED — artifacts in ~half of replacements (broken headers, mid-sentence periods, damaged quotes) |

**style-guide** clears the +0.015 threshold numerically (+0.021) but the mechanism is wrong. Bullet count drops to 0.82x golden while w/b rises to 1.50x — the model absorbs chained ideas into single longer bullets instead of splitting them. This is consolidation, not compression.

**regex-clean** produces visible artifacts: periods in headers ("### Deployed Design. Context Setting"), broken mid-sentence ("When pushed for specifics. On LSEG redesign"), damaged quotes. Context-unaware replacement is not viable.

Round 22 confirmation (n=8, merged with Round 21):

| Test Case | baseline | clean-all | delta |
|---|---|---|---|
| dense-business | 0.794 | 0.887 | +0.093 |
| dense-interview | 0.734 | 0.756 | +0.022 |
| dense-review-q1 | 0.877 | 0.869 | -0.008 |
| dense-review-q4 | 0.910 | 0.892 | -0.017 |
| no-notes-complex | 0.552 | 0.580 | +0.028 |
| no-notes-personal | 0.930 | 0.946 | +0.016 |
| sparse-feedback | 0.732 | 0.833 | +0.101 |
| sparse-interview | 0.748 | 0.674 | -0.074 |
| sparse-short | 0.861 | 0.875 | +0.014 |
| **Average** | **0.793** | **0.812** | **+0.019** |

**clean-all confirmed and promoted.** +0.019 at n=8, above the +0.015 threshold. Wins 6 of 9 cases. Bullet stats confirm the mechanism: w/b drops 14.4 → 13.8, chains drop 11.7 → 8.8, bullet count roughly flat (+0.4). Genuine split-and-compress behavior. dense-business is notably more stable under clean-all (spread 0.110 vs baseline's 0.494).

**sparse-interview regression is real** (−0.074 at n=8). Score distributions barely overlap — clean-all clusters 0.588–0.784 vs baseline's 0.675–0.877. The case's editorial voice relies on dashes and fragments; removing em-dashes from the prompt dampens that register. Accepted as a trade-off given the 6-case improvement and overall +0.019 delta.

36. **Prompt punctuation patterns affect output structural habits.** Em-dash removal from prompt text reduces output chaining (clean-all: chains 11.7 → 8.8) even though linguistic register doesn't affect w/b (principle #15). The mechanism is behavioral mimicry: the model reproduces structural patterns it sees in instructions. This is distinct from register priming (#13) — it's about punctuation structure, not word choice or tone.
37. **HOW chains are replaced matters more than WHETHER they're reduced.** Instructional chain-splitting (style-guide) causes consolidation — fewer, longer bullets, w/b increases. Prompt punctuation cleanup (clean-all) causes genuine splitting — more, shorter bullets, w/b decreases. The instruction "split chained bullets" is interpreted as "merge the ideas into one comprehensive bullet" rather than "make two short bullets." Modeling the desired structure in the prompt itself is more effective than describing it.

### Ideas for future rounds

- **sparse-interview recovery.** clean-all's regression on this case (−0.074) is the main known weakness. Could test whether adding an em-dash back into the examples (specifically Example 2 or a new interview-style example) recovers the editorial register without reintroducing chaining elsewhere.
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
