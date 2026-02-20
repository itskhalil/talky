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

**Sparse notes** (sparse-feedback, sparse-short): User wrote 1-2 lines for a long meeting. These test whether the model exercises judgment about what to include, writes in the user's voice, follows chronological order, and doesn't over-anchor on the sparse notes.

**No notes** (no-notes-personal, no-notes-complex): User provided no notes at all — everything must be generated from the transcript. These test whether the model can produce personal-feeling notes without any user voice to calibrate from.

- no-notes-personal is a deeply personal 1-on-1 conversation — tests emotional/personal register without user voice.
- no-notes-complex is a long operational conversation with a colleague about management issues, staffing process problems, and personal disruptions — tests whether the model can handle a complex, multi-threaded conversation and produce notes that feel personal rather than like a structured briefing.

## What to check in every eval review

### 1. Scores — but scores are not enough

The judge scores on 6 dimensions (voice, density, clarity, readability, additions, tagging) plus a computed conciseness score and verbosity penalty. Read the scores to identify outliers, but **always read the judge reasoning and the actual model outputs**. A score of 0.75 can mean very different things depending on what the judge flagged.

### 2. Judge reasoning

In `results-summary.md`, each run includes:
- **Problems** — problems list and any verbosity penalty
- **Reasoning** — per-dimension scores and reasoning text

Read the reasoning text for every sparse-notes case. For dense-notes cases, read the reasoning for any score below 0.85 or any failure.

### 3. Actual model outputs

The most important thing. In `results-summary.md`, each run's full model output is included under **Output**. Read these, especially for sparse-notes cases. Ask yourself:

- **Would the user believe they wrote this?** If it reads like a briefing doc or AI summary, it's failing regardless of scores.
- **Is anything addressed to "you/your"?** Notes are written BY the user, not TO them. "You should apologize" is wrong; "I need to apologize" or "talk to [person] and apologize" is right.
- **Is the chronological order correct?** Topics should appear in the order they were discussed. If the user wrote one note mid-meeting, it should appear mid-output, not promoted to the top.
- **Are the right things omitted?** Omitting *something* is fine and expected. The failure is omitting things that actually matter while including things that don't. The referenceability test: would the user come back to find this next week? They come back for decisions, commitments, open items, action items. For emotional/consequential meetings (like a conversation about leaving a company), the drivers, arguments, and key framing ARE substance — not just the final decision.
- **Are action items framed correctly?** Watch for action items that are too narrow. "Apologize to [person]" is a discrete task; "make her feel welcome and valued, especially with the promotion coming" is an ongoing responsibility. The second is more useful.
- **Is the register natural?** Watch for AI-speak: "perceives favoritism", "correctly sensed low regard", "catalyzed by", "facilitate", "comprehensive." The user writes things like "she thinks we're too close" or "I didn't really respect her." A good test: read a bullet aloud. Would a real person say this to a colleague, or does it sound like a management consultant wrote it?
- **Are user notes preserved verbatim?** The user's own words should never be paraphrased. If they wrote "Do you have regrets?" it should appear as `[noted] Do you have regrets?` — not `[noted] Asked directly whether they have regrets about the conscious trade-offs`.
- **Does the output use compressed note fragments?** The register should always be compressed notes — terse fragments, not full sentences — regardless of whether user notes are dense or sparse. This is consistent: the user's register doesn't change based on how much they wrote.

### 4. Bullet stats — MUST INCLUDE IN EVERY REVIEW

The **Bullet Stats** section in the summary shows per-variant averages for each test case: word count, bullet count, avg/median/max words per bullet. **Always present three tables in your review:**

1. **Word count ratios vs golden** — output words / golden words for each case × variant. Flag anything >1.5x (verbose) or <0.7x (too terse).
2. **Bullet count ratios vs golden** — output bullets / golden bullets. Flag >1.3x (bullet proliferation) or <0.5x (under-generating structure).
3. **Words per bullet vs golden** — avg w/b for each case × variant alongside the golden's w/b. This reveals whether bullets are compressed fragments (golden-like) or near-sentences (model tendency). The model consistently writes 1.3-2x the golden's w/b across variants — track whether new variants improve or worsen this.

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
The model sometimes writes TO the user ("You should apologize", "Your promotion") instead of AS them ("I need to apologize", "My promotion"). This was caused by the original analyst/principal frame. The current frame ("You just came out of a meeting... your rough notes...") mostly fixes this but slips can occur, especially on no-notes cases (no notes to calibrate voice from).

### AI-speak register
The model defaults to consultant language: "perceives favoritism", "correctly sensed low regard", "catalyzed by." The user writes casually. The frame helps but doesn't fully prevent this. Watch for it especially in [ai] additions.

### Softening raw honesty
When the model writes as the user (frame variant), it tends to be more diplomatic than the user actually was. E.g., the user said "I didn't really respect her, is the honest answer" but the model writes "I wasn't impressed with her work." The verbatim quote is more useful — it's the thing that makes an apology meaningful, the thing you'd want your notes to remind you of before a difficult conversation.

### Meeting-type blindness
The model should calibrate what matters based on the type of meeting. In a simple business decision call, only the decisions and actions matter. In an emotional, consequential conversation (like deciding to leave a company, or receiving difficult feedback about your behavior), the drivers, arguments, and framing ARE the substance. A prompt that cuts all reasoning and only keeps decisions would fail on these meetings.

### The no-notes complex conversation gap (no-notes-complex)
When the user provides no notes AND the conversation is emotionally/contextually dense (not a simple business meeting), the model struggles. Gate scores 0.438-0.453 across rounds. Inline reasoning variants improved this (v6 to 0.664 in Round 6, actions-remove to 0.561 in Round 7) but it remains the lowest-scoring case across all rounds, consistently below 0.8. The model still misses key details and quotes that make the golden effective, and still produces outputs that are too short vs golden's 428w. The reasoning step helps calibrate register but doesn't solve the content-selection gap.

### Interview editorializing from reasoning step
On interview-format meetings where the user is the interviewer, the reasoning step encourages analytical framing that produces editorial judgments in the notes rather than observational notes. v6 on dense-interview (0.700) adds evaluative content like "standard but not distinctive", "Most original idea" and a low-value section about the interviewer's own explanation to the candidate. It also misses the entire "His questions" section from the golden. **Partially fixed (Round 7):** actions-remove recovered dense-interview to 0.810 (+0.118 over v6) by removing "Action Items" from the list of prohibited section types, which let the model capture the candidate's questions and concrete commitments naturally.

### Bullet proliferation under compression constraints
Explicit per-bullet word limits ("aim for 10 words or fewer") cause the model to generate more bullets rather than fewer total words. The combined-compress variant averaged 49.7 bullets (vs gate's 25.3) with roughly the same total content. The constraint operates at the wrong level — it compresses individual lines but doesn't reduce selectivity. Total output length is driven by how many topics the model decides to include, not how many words per bullet.

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

### Round 7: action items structure (actions-remove, actions-explicit) — current

Variants: actions-remove, actions-explicit. Small edit to v6's user prompt Structure guideline. v6 prohibited "Action Items" sections alongside "Key Decisions"; actions-remove drops "Action Items" from the prohibition (just bans recap sections like "Key Decisions", "Key Takeaways"). actions-explicit goes further and explicitly instructs a `### Next steps` section for concrete commitments. 4 variants (gate, v6, actions-remove, actions-explicit), 8 test cases, 3 runs each.

| Variant | Avg | dense-bus | no-notes-pers | dense-int | dense-q1 | dense-q4 | sparse-short | sparse-fb | no-notes-cplx |
|---|---|---|---|---|---|---|---|---|---|
| gate | 0.756 | 0.880 | 0.756 | 0.735 | 0.903 | 0.817 | 0.749 | 0.775 | 0.438 |
| v6 | 0.791 | 0.871 | 0.880 | 0.692 | 0.831 | 0.923 | 0.791 | 0.786 | 0.553 |
| **actions-remove** | **0.815** | 0.864 | 0.890 | 0.810 | 0.833 | 0.908 | 0.821 | 0.834 | 0.561 |
| actions-explicit | 0.793 | 0.843 | 0.897 | 0.713 | 0.824 | 0.908 | 0.828 | 0.771 | 0.563 |

**Winner: actions-remove (+0.024 over v6, +0.059 over gate).** Fixed the dense-interview regression from Round 6: 0.810 vs v6's 0.692 (+0.118). Also improved sparse-feedback: 0.834 vs v6's 0.786. Voice held at 4.0, additions jumped to 4.4. Conciseness slightly lower (0.84 vs v6's 0.86). actions-explicit was worse (0.793) — explicitly instructing a "Next steps" section was less effective than simply removing the prohibition.

**actions-remove was promoted to production.** Open issues: no-notes-complex still below 0.8 (0.561), third-person voice slips on no-notes cases.

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
