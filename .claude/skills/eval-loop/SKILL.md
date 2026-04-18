---
name: eval-loop
description: Run a full iteration of the enhance_notes prompt improvement loop — hypothesize, design, test, review
user-invocable: true
---

# Eval Loop

Run one full iteration of the prompt improvement loop.

## The Loop

1. **Review** — Understand current state
2. **Hypothesize** — Generate ideas for improvement
3. **Check** — Validate against research and history
4. **Design** — Create prompt variants
5. **Test** — Run eval
6. **Analyze** — Review results
7. **Decide** — Promote, iterate, or abandon

## Step 1: Review

Read the eval guide and latest results:

- `.AI/EVAL_REVIEW_GUIDE.md` — focus on: research principles, known failure modes, history (especially recent rounds)
- `.AI/results/summary.md` — current scores, gaps, problem areas
- Production prompts: `src-tauri/resources/prompts/enhance_notes.txt` (system) and `enhance_notes_user.txt` (user)

Identify the biggest remaining gaps. What test cases score lowest? What qualitative problems recur? Where is the most room for improvement?

## Step 2: Hypothesize

Generate 2-4 hypotheses for what could improve results. Each hypothesis should:

- Target a specific problem (not "make it better")
- Have a testable mechanism ("changing X should affect Y because Z")
- Be grounded in the research principles

## Step 3: Check Against History

For each hypothesis, check:

- Has something similar been tried before? (History section of the guide)
- Does it contradict any research principle?
- Does it risk a known failure mode?

Discard hypotheses that repeat past failures. Refine ones that are similar-but-different from past attempts.

## Step 4: Design Variants

Pick 1-3 hypotheses to test. For each:

1. Create the variant: `.AI/new-variant.sh <name>`
2. Edit `system.txt` and/or `user.txt` in `.AI/prompt-variants/<name>/`
3. Create the prompt loader: copy an existing `.AI/prompts/*.mjs` file and change the variant directory path
4. Add to `.AI/promptfooconfig.yaml`

**Variant design principles:**

- Change one thing per variant (isolate variables)
- Prefer replacing text over adding text (prompt length signals output length)
- Check for conflicts with existing instructions
- Consider whether an example would teach better than a rule
- Think about regression risk on dense cases

**Baseline rule:** Never edit the baseline variant directly. Its files are symlinks to the production prompts. All changes go into new variant directories.

## Step 5: Self-Review

Before running, review each variant as the user would:

- Does this hypothesis make sense given the research?
- Is the change minimal and targeted?
- Could this cause regressions? On which cases?
- Is the variant properly configured (config, prompt loader, files)?

## Step 6: Run Eval

```bash
npm run eval
```

This runs all variants x all test cases x 4 repeats (default), then generates the summary.

## Step 7: Review Results

Review the results following the `/eval-review` skill checklist:

- Read `results/summary.md`
- Check score matrix, dimension averages, bullet stats, ratio tables
- Deep dive into per-case files for sparse/no-notes cases and any scores <0.85
- Check run-to-run consistency
- Check for dense-case regressions

Classify each variant: WINNER, PROMISING, NULL, or FAILED.

## Step 8: Decide & Document

Based on the review:

- **WINNER:** Recommend promotion. To promote: copy variant's `system.txt` and `user.txt` to `src-tauri/resources/prompts/enhance_notes.txt` and `enhance_notes_user.txt`. The baseline symlinks automatically pick up the changes. Update config.
- **PROMISING:** Recommend another round with refinements.
- **NULL/FAILED:** Document what was learned.

Update `.AI/EVAL_REVIEW_GUIDE.md`:

- Add the round to the History section with full results table
- Update research principles if anything was confirmed/refuted
- Add new failure modes if discovered
- **NEVER include personal details** — no real names, meeting content, transcript excerpts, or company-specific context. The guide is a git-tracked file. Keep writeups abstract (e.g. "a recurring standup" not "the SHIVA standup", "a management thread" not "the Rene coaching thread").

## Output

Present findings to the user:

1. What you hypothesized and why
2. What variants you created
3. Results summary
4. Variant verdicts with evidence
5. What you learned (new principles, confirmed/refuted hypotheses)
6. Recommendation (promote / iterate / new direction)
