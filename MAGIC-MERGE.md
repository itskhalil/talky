# Magic Merge Design

## Vision

After a meeting, you click "Enhance" and get back **the notes you would have taken if you'd been fully attentive the whole time** - in your voice, using your terminology, preserving your structure where you took notes, and filling in the rest seamlessly.

## Requirements

### R1: Notes as a Lens

User notes teach the AI how to interpret the entire meeting:

- **Vocabulary**: If you wrote "SHIVA", use that spelling even if the transcript heard "shiba"
- **Style**: Match your level of detail, tone (terse vs verbose, formal vs casual)
- **Importance**: Topics you noted are important; use that signal for the whole meeting
- **Propagation**: Context from notes at minute 5 informs interpretation of minute 45

### R2: Chronological Unified Output

The output is one coherent document in chronological order:

- Your notes appear at their natural points in the meeting timeline
- Content you didn't capture is generated and woven in at the appropriate points
- No separate sections, no seams - reads as one continuous set of notes

Example output:
```
- [+] Meeting opened, team availability check
- pricing discussed - $45k base + $10k/month agreed, proposal by Friday
- [+] Bob raised Q2 invoice delays, Alice following up with finance
- Q3 timeline - end of Q3 target, depends on SHIVA deployment
- SHIVA blocker - security review pending, Alice escalating today
- [+] Holiday schedules discussed, team updating shared calendar
```

### R3: Visual Distinction

Users should know what's theirs vs what's generated:

| Content | Styling |
|---------|---------|
| User's notes (enhanced with details) | Black text |
| AI-generated content | Grey text |

### R4: Toggle View

Users can switch between:
- **Full meeting**: Everything (user notes + generated content)
- **My notes only**: Just their notes, enhanced

### R5: Hidden Timestamps on Notes

To place notes correctly in the timeline:

- Every line (headers and bullets) gets a timestamp when created
- Timestamps are metadata only - not shown in the UI
- Used by the system to order notes within the transcript

### R6: Graceful Partial Coverage

Works well regardless of how much the user captured:

| Scenario | Behavior |
|----------|----------|
| Took notes throughout | Mostly enhancement, minimal generation |
| Stopped halfway | First half enhanced, second half generated |
| Only a few bullets | Those bullets enhanced, rest generated |
| No notes at all | Fully generated summary (all grey) |

### R7: Transcript Terminology Correction

The transcript contains speech-to-text errors, especially for:
- Project codenames (SHIVA → "shiba")
- People's names (Henderson → "Anderson")
- Technical jargon (OKRs → "oh-kayers")

User notes are the authority. The AI corrects transcript terminology based on notes.

### R8: Deterministic Structure, LLM Language

Division of labor:

| Task | Handled by |
|------|------------|
| Ordering notes and transcript by timestamp | Code |
| Placing notes in the timeline | Code |
| Enhancing notes with transcript details | LLM |
| Summarizing gaps (transcript with no nearby notes) | LLM |
| Applying vocabulary and style | LLM |

This makes the output reliable and predictable for structure, while leveraging the LLM for what it's good at.

### R9: Structured Notes Support

User notes may include headers and nested bullets:

```markdown
## Pricing
- base rate discussed
  - mentioned competitor rates
- proposal timeline

## Technical
- SHIVA blocker
  - security review pending
```

Requirements:
- All lines (headers and bullets at any level) get timestamps when created
- Structure is preserved in the prompt to the LLM
- Generated content matches user's structural pattern:
  - If user uses headers → generated content uses headers for new topics
  - If user uses nested bullets → generated content can use nesting
  - If user uses flat bullets → generated content is flat
- Enhanced bullets preserve their nesting level

## Data Flow

```
User types notes during meeting (with structure)
         │
         ▼
Each line (header/bullet) gets hidden timestamp
         │
         ▼
Meeting ends, user clicks "Enhance"
         │
         ▼
Code merges notes + transcript by timestamp
         │
         ▼
Pre-interleaved timeline sent to LLM
         │
         ▼
LLM enhances notes, summarizes gaps, applies vocabulary
         │
         ▼
Output parsed: [+] prefix → grey styling
         │
         ▼
Unified chronological notes displayed
```

## Example Prompt

This is the format sent to the LLM after code has pre-interleaved the timeline.

The LLM infers gaps from the structure - any transcript section without a nearby `[NOTE]` is content that needs summarizing.

### Example: Flat Notes

```markdown
## USER'S NOTES

These teach you vocabulary, style, and what the user finds important.
Use their terminology throughout.

[02:45] pricing discussed
[12:30] SHIVA blocker
[25:00] Q3 timeline

## MEETING TIMELINE

[TRANSCRIPT 00:00-02:30]
Alice: Welcome everyone, thanks for joining the Monday sync.
Bob: Happy to be here. Should we start with the pricing update?

[NOTE 02:45] pricing discussed

[TRANSCRIPT 02:30-12:30]
Alice: So we're looking at forty-five K base plus ten K monthly retainer.
Bob: That works. I'll send the formal proposal by Friday.
Alice: Moving on to the shiba deployment...
Bob: The blocker is still the security review.
Alice: I'll escalate that today.

[NOTE 12:30] SHIVA blocker

[TRANSCRIPT 12:30-25:00]
Bob: What about the Q3 timeline?
Alice: We're targeting end of quarter, but it depends on the deployment.

[NOTE 25:00] Q3 timeline

[TRANSCRIPT 25:00-45:00]
Alice: Last thing - holiday schedules. Everyone update the shared calendar.
Bob: Will do. Thanks everyone.

## TASK

Create unified chronological meeting notes:

1. For each NOTE: Output the user's text, enhanced with specifics from surrounding transcript
2. For transcript sections without nearby notes: Generate 1-3 bullets summarizing key points
3. Use vocabulary from user's notes throughout (e.g., "SHIVA" not "shiba")
4. Match the user's writing style (terse/verbose, level of detail)
5. Prefix generated bullets with [+]

## OUTPUT FORMAT

Bullet points in chronological order. Example:

- [+] Meeting opened with status check
- pricing discussed - $45k base + $10k/month retainer agreed, Bob sending proposal Friday
- [+] Team discussed Q2 invoice delays, Alice to follow up with finance
- SHIVA blocker - security review pending, Alice escalating today
- Q3 timeline - targeting end of Q3, contingent on SHIVA deployment
- [+] Holiday schedules reviewed, team to update shared calendar
```

### Example: Structured Notes with Headers

```markdown
## USER'S NOTES

[02:00] ## Pricing
[02:45] - base rate discussed
[03:10]   - competitor rates mentioned
[05:00] - proposal timeline

[12:00] ## Technical
[12:30] - SHIVA blocker
[12:45]   - security review pending

## MEETING TIMELINE

[TRANSCRIPT 00:00-02:00]
Alice: Welcome everyone. Let's dive in.

[NOTE 02:00] ## Pricing

[TRANSCRIPT 02:00-05:30]
Alice: So we're looking at forty-five K base...
Bob: How does that compare to competitors?
Alice: We're about 10% below market...

[NOTE 02:45] - base rate discussed
[NOTE 03:10]   - competitor rates mentioned
[NOTE 05:00] - proposal timeline

[TRANSCRIPT 05:30-12:00]
Alice: Moving on to the shiba deployment...
Bob: What's the blocker there?

[NOTE 12:00] ## Technical

[TRANSCRIPT 12:00-15:00]
Alice: The main issue is the security review.
Bob: I'll escalate that today.

[NOTE 12:30] - SHIVA blocker
[NOTE 12:45]   - security review pending

[TRANSCRIPT 15:00-45:00]
Alice: Any other business? Holiday schedules?
Bob: I'll be out next week.

## TASK

Create unified chronological meeting notes:

1. For each NOTE: Output the user's text (preserving structure), enhanced with specifics
2. For transcript sections without nearby notes: Generate content matching user's structure
3. Use vocabulary from user's notes throughout (e.g., "SHIVA" not "shiba")
4. Match the user's structural pattern (headers, nesting levels)
5. Prefix generated content with [+]

## OUTPUT FORMAT

Match the user's structure. Example:

## Pricing
- base rate discussed - agreed on $45k base + $10k/month retainer
  - competitor rates mentioned - we're ~10% below market average
- proposal timeline - Bob sending formal proposal by Friday

## Technical
- SHIVA blocker - main dependency for Q3 timeline
  - security review pending - Bob escalating today
- [+] deployment targeting end of Q3 if security clears

## [+] Other Business
- [+] Holiday schedules - Bob out next week, team to update shared calendar
```

## Implementation Components

### 1. Timestamp Capture (UI)

Capture timestamp when each line is created:

```typescript
interface NoteLine {
  id: string;
  text: string;
  indent_level: number; // 0 = top-level, 1 = nested, 2 = double-nested
  is_header: boolean;
  timestamp_ms: number; // ms since meeting start, hidden from user
}
```

### 2. Timeline Merger (Code)

Merge notes and transcript into ordered timeline:

```typescript
interface TimelineSegment {
  type: 'transcript' | 'note';
  start_ms: number;
  end_ms?: number; // only for transcript
  content: string;
  indent_level?: number; // only for notes
  is_header?: boolean; // only for notes
}

function buildTimeline(
  transcript: TranscriptSegment[],
  notes: NoteLine[]
): TimelineSegment[]
```

### 3. Prompt Builder (Code)

Build the pre-interleaved prompt:

```typescript
function buildMergePrompt(
  timeline: TimelineSegment[],
  notes: NoteLine[]
): string
```

### 4. Output Parser (Code)

Parse LLM output, identify generated vs enhanced:

```typescript
interface OutputLine {
  text: string;
  indent_level: number;
  is_header: boolean;
  isGenerated: boolean; // true if had [+] prefix
}

function parseOutput(llmOutput: string): OutputLine[]
```

### 5. UI Renderer

- `isGenerated: true` → grey text
- `isGenerated: false` → black text
- Preserve structure (headers, indentation)
- Toggle for "my notes only" view

## Open Questions

1. **Gap threshold**: How much transcript without notes before we generate content? (Proposal: 2-3 minutes)

2. **Very short meetings**: If transcript is <5 minutes, do we still run magic merge or just simple enhancement?

3. **Token limits**: 1-hour meeting ≈ 10k+ words. For MVP, use large context model. Future: consider chunking.

4. **Confidence markers**: Should we mark low-confidence enhancements? (e.g., `[~]` for unclear transcript) - defer to later phase.

5. **Header generation**: When generating content for gaps, when should we create new headers vs flat bullets?

## Success Criteria

- User's notes preserved and enhanced at correct timeline positions
- User's structure (headers, nesting) preserved exactly
- Generated content integrates seamlessly (no "AI section" feel)
- Generated content matches user's structural pattern
- Vocabulary from notes applied throughout
- Visual distinction clear but not jarring
- Works gracefully whether user took notes for whole meeting or stopped halfway

## Evaluation & Iteration Ideas

Ideas to explore when tuning the prompt and evaluating quality:

### Prompt Variations

1. **Explicit gap markers**: Instead of letting LLM infer gaps, explicitly mark `[GAP 05:00-12:00]` sections. Might improve reliability at cost of prompt complexity.

2. **Two-pass approach**: First pass extracts key points from transcript, second pass merges with notes. Might improve quality for long meetings.

3. **Few-shot examples in prompt**: Include 2-3 examples of good enhancement to guide style matching.

4. **Vocabulary extraction step**: Explicitly extract terminology from notes before main prompt, provide as a glossary.

### Output Tuning

5. **Bullet density**: How many generated bullets per minute of gap? Experiment with guidance like "1-2 bullets per 5 minutes of discussion".

6. **Enhancement depth**: How much detail to add to user's bullets? "Add 1-2 specific details" vs "expand significantly".

7. **Quote inclusion**: When to include direct quotes vs paraphrasing? Might need guidance on quote length/frequency.

### Structure Handling

8. **Header inference**: Can LLM infer appropriate headers for generated content based on user's header style?

9. **Nesting consistency**: Does LLM maintain consistent nesting depth with user's style?

10. **Chronological vs topical**: For structured notes, should generated content be strictly chronological or grouped by topic?

### Edge Cases

11. **Very sparse notes**: User writes 2 bullets for 1-hour meeting. How much to generate?

12. **Very dense notes**: User writes 50 bullets. How much enhancement vs leaving alone?

13. **Conflicting information**: Transcript contradicts user's notes. Which wins?

14. **Overlapping topics**: Same topic discussed at minute 5 and minute 45. How to handle when user only noted it once?

### Quality Metrics

15. **Terminology accuracy**: % of domain terms spelled correctly (matching user's notes)

16. **Structure preservation**: Does output structure match input structure?

17. **Chronological accuracy**: Are events in the right order?

18. **Voice consistency**: Blind test - can evaluator distinguish user bullets from generated?

19. **Information density**: Generated content should be concise, not padded
