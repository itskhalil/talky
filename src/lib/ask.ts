/**
 * Asking questions of your notes.
 *
 * Two modes:
 * - One note: the note's content goes in the prompt and the model answers
 *   from it. No tools, one call.
 * - Across notes: the model gets two tools, `search_notes` and `read_note`,
 *   and works in a short loop (search, read what looks relevant, answer).
 *
 * The confidentiality rule lives in the tools, not the prompt: every note a
 * tool returns is checked against the environment the question was asked
 * in, so a model can never see another environment's notes however it asks.
 *
 * This module has no React or Tauri imports; the app passes in its commands
 * (`NoteSource`).
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { hermesToolMiddleware } from "@ai-sdk-tool/parser";
import {
  stepCountIs,
  streamText,
  tool,
  wrapLanguageModel,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type StepResult,
  type ToolSet,
} from "ai";
import * as chrono from "chrono-node";
import { z } from "zod";

export interface NoteSummary {
  id: string;
  title: string;
  startedAt: number; // unix seconds
  environmentId: string | null;
}

export interface NoteBody {
  userNotes: string;
  enhancedNotes: string;
  transcript: string;
}

/** Where notes come from. The app implements this with Tauri commands. */
export interface NoteSource {
  /** Full-text search over titles, notes and transcripts, newest first. */
  search(query: string): Promise<Array<NoteSummary & { snippet: string }>>;
  /** Every note, newest first. */
  list(): Promise<NoteSummary[]>;
  get(id: string): Promise<NoteSummary | null>;
  read(id: string): Promise<NoteBody>;
}

export interface Endpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Notes with no environment belong to the default one. */
function inEnvironment(
  note: NoteSummary,
  envId: string,
  defaultEnvId: string | null,
): boolean {
  return (note.environmentId ?? defaultEnvId) === envId;
}

function day(startedAt: number): string {
  return new Date(startedAt * 1000).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

const MAX_TRANSCRIPT_CHARS = 24_000;
const MAX_STEPS = 6;
const TIMEOUT_MS = 120_000;

export function buildModel({
  baseUrl,
  apiKey,
  model,
}: Endpoint): LanguageModel {
  if (baseUrl.includes("anthropic.com")) {
    return createAnthropic({
      apiKey,
      baseURL: baseUrl,
      headers: { "anthropic-dangerous-direct-browser-access": "true" },
    })(model);
  }
  const isOllama = baseUrl.includes("localhost:11434");
  const openai = createOpenAI({
    apiKey: isOllama && !apiKey ? "ollama" : apiKey,
    baseURL: baseUrl,
  })(model);
  // Most OpenAI-compatible servers support tool calls; older local ones
  // only follow a text protocol, which the Hermes middleware handles.
  return baseUrl.includes("openai.com")
    ? openai
    : wrapLanguageModel({ model: openai, middleware: hermesToolMiddleware });
}

/** The two tools for asking across notes, scoped to one environment. */
export function noteTools(
  source: NoteSource,
  envId: string,
  defaultEnvId: string | null,
) {
  return {
    search_notes: tool({
      description:
        "Find notes by meaning-bearing words: people, companies, topics, or words from a meeting title. " +
        "Returns up to 12 notes, newest first, each with its id, title, date and a matching snippet. " +
        "Leave query empty to list the most recent notes. Call it more than once with different words if the first search misses.",
      inputSchema: z.object({
        query: z
          .string()
          .describe(
            "Words to search for, e.g. 'pricing Northwind'. Empty for recent notes.",
          ),
        when: z
          .string()
          .optional()
          .describe(
            "Optional date range in plain words: 'this week', 'yesterday', 'since March 3', 'last month'.",
          ),
      }),
      execute: async ({ query, when }) => {
        const q = query.trim();
        let notes: Array<NoteSummary & { snippet: string }> = q
          ? await source.search(q)
          : (await source.list()).map((n) => ({ ...n, snippet: "" }));
        notes = notes.filter((n) => inEnvironment(n, envId, defaultEnvId));
        if (when) {
          const parsed = chrono.parse(when, new Date(), { forwardDate: false });
          if (parsed.length > 0) {
            const start = parsed[0].start.date();
            start.setHours(0, 0, 0, 0);
            const end = parsed[0].end?.date() ?? new Date();
            if (!parsed[0].end && /^(yesterday|today|on )/i.test(when.trim())) {
              end.setTime(start.getTime());
            }
            end.setHours(23, 59, 59, 999);
            notes = notes.filter((n) => {
              const d = n.startedAt * 1000;
              return d >= start.getTime() && d <= end.getTime();
            });
          }
        }
        if (notes.length === 0)
          return {
            notes: [],
            hint: "No notes found. Try other words or no date.",
          };
        return {
          notes: notes.slice(0, 12).map((n) => ({
            id: n.id,
            title: n.title,
            date: day(n.startedAt),
            snippet: n.snippet,
          })),
        };
      },
    }),
    read_note: tool({
      description:
        "Read one note in full: the user's own notes, the enhanced notes, and the transcript. Use ids from search_notes.",
      inputSchema: z.object({
        id: z.string().describe("A note id from search_notes."),
      }),
      execute: async ({ id }) => {
        const note = await source.get(id);
        if (!note || !inEnvironment(note, envId, defaultEnvId)) {
          return { error: "No note with that id." };
        }
        const body = await source.read(id);
        const transcript =
          body.transcript.length > MAX_TRANSCRIPT_CHARS
            ? `${body.transcript.slice(0, MAX_TRANSCRIPT_CHARS)}\n…(transcript truncated)`
            : body.transcript;
        return {
          title: note.title,
          date: day(note.startedAt),
          userNotes: body.userNotes || "(none)",
          enhancedNotes: stripMarkers(body.enhancedNotes) || "(none)",
          transcript: transcript || "(none)",
        };
      },
    }),
  };
}

function today(): string {
  return new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** How to write an answer: shared by both modes. See .AI/chat/PRINCIPLES.md. */
const ANSWER_STYLE = `How to answer:
- Open with the answer itself. Never describe searching or which notes you read, never restate the question, and skip preambles like "Based on your notes".
- Let the question set the shape. A fact or a decision is one sentence, two at most. A list of things (actions, people, open items) is short bullets. "Prep me" or "summarise" is short bullets, under a heading or two if that helps. Never write prose longer than two sentences; use bullets instead.
- Combine facts into the picture the question asks for rather than retelling the notes in order.
- Include only what answers the question. Don't mention notes or meetings that didn't have it, even a near match. Don't add asides about what the notes don't show unless the question asks. Don't close with an offer to help, in drafts too ("Shout if I've missed anything").
- Every name, number, date and decision must come from the notes. If something was discussed with no outcome, say it's still open.
- If the notes don't cover it, say so in one line. If they cover part of it, give that part and name what's missing in a clause.
- Write to the user as "you" and name everyone else.
- Take the notes at face value; enhanced notes are drawn from the transcript.`;

export function acrossNotesPrompt(userName?: string): string {
  return `You answer questions about the user's meeting notes. Today is ${today()}.${
    userName ? ` The user's name is ${userName}.` : ""
  }

Use search_notes to find relevant notes, then read_note on the ones that matter before answering. Search again with different words if the first search misses. For time words like "yesterday" or "last week", use the when filter and answer only from those meetings.

${ANSWER_STYLE}
- Name where something came from once, where it helps ("in your 1:1 with Sam yesterday"), with relative dates for recent meetings. Don't label every bullet with a meeting title or date.`;
}

export function oneNotePrompt(
  note: { title: string; date: string; userNotes: string; content: string },
  userName?: string,
): string {
  return `You answer questions about one meeting note. Today is ${today()}.${
    userName ? ` The user's name is ${userName}.` : ""
  }

You can only see this note. If asked about another meeting, say in one line that this note doesn't cover it; don't guess.

${ANSWER_STYLE}
- The transcript is the fullest record, and during a live meeting the freshest; look there for details the notes leave out. "What did I miss" means the latest stretch of the meeting, ending with the last thing said.
- Drafts (an email, a summary to paste) are short and specific, with owners and dates, written as the user.

## ${note.title} (${note.date})

### The user's notes
${note.userNotes || "(none)"}

${note.content}`;
}

/** "[ai] " and "[noted] " mark where enhanced lines came from; the model doesn't need them. */
function stripMarkers(notes: string): string {
  return notes.replace(/\[(?:ai|noted)\] ?/g, "");
}

/** The part of a note the one-note prompt shows after the user's notes. */
export function oneNoteContent(
  enhancedNotes: string,
  transcript: string,
): string {
  // Enhanced notes summarise the transcript but leave details out, and lag
  // behind it during a live meeting, so both go in. A long transcript keeps
  // its end: that's where "what did I miss" looks.
  const t =
    transcript.length > MAX_TRANSCRIPT_CHARS
      ? `…(earlier transcript omitted)\n${transcript.slice(-MAX_TRANSCRIPT_CHARS)}`
      : transcript;
  return `### Enhanced notes\n${stripMarkers(enhancedNotes) || "(none)"}\n\n### Transcript\n${t || "(none yet)"}`;
}

/** "Sat, 3 Oct 2026" → "3 Oct": enough to tell notes apart in a chip. */
function shortDay(date?: string): string {
  return (date ?? "").replace(/^\w+, /, "").replace(/ \d{4}$/, "");
}

/** A note the answer drew on. */
export interface AskSource {
  id: string;
  title: string;
  date: string;
}

/** What one question did and cost: every step, total usage, served model. */
export interface AskRun {
  steps: StepResult<ToolSet>[];
  usage: LanguageModelUsage;
  modelId: string;
  finishReason: string;
}

/**
 * Run one question. Streams the answer through `onText` (the full text so
 * far), reports the notes it drew on through `onSources`, and resolves when
 * it's done. Sources are the notes the model read (or, if it read none, the
 * searched notes named in the answer); they come from the tool calls, not
 * from the model's own formatting. Tool errors, such as a malformed call,
 * go back to the model, which can retry; they never stall the loop.
 * `onFinish` reports the whole run (the chat eval records it); it fires
 * before the empty-answer check so a failed run's usage is still counted.
 */
export async function ask({
  model,
  system,
  messages,
  tools,
  signal,
  onText,
  onSources,
  onFinish,
}: {
  model: LanguageModel;
  system: string;
  messages: ModelMessage[];
  tools?: ReturnType<typeof noteTools>;
  signal?: AbortSignal;
  onText: (text: string) => void;
  onSources?: (sources: AskSource[]) => void;
  onFinish?: (run: AskRun) => void;
}): Promise<string> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const abortSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const result = streamText({
    model,
    system,
    messages,
    tools,
    stopWhen: stepCountIs(MAX_STEPS),
    abortSignal,
  });

  // Only the final step's text is the answer; earlier steps may narrate.
  let text = "";
  let stepText = "";
  const read = new Map<string, AskSource>();
  const seen = new Map<string, AskSource>();
  for await (const part of result.fullStream) {
    switch (part.type) {
      case "tool-result": {
        const out = part.output as {
          title?: string;
          date?: string;
          notes?: AskSource[];
        };
        if (part.toolName === "read_note" && out.title) {
          const id = (part.input as { id: string }).id;
          read.set(id, { id, title: out.title, date: shortDay(out.date) });
        } else if (part.toolName === "search_notes") {
          for (const n of out.notes ?? [])
            seen.set(n.id, { ...n, date: shortDay(n.date) });
        }
        break;
      }
      case "start-step":
        stepText = "";
        break;
      case "text-delta":
        stepText += part.text;
        text = stepText;
        onText(text);
        break;
      case "error":
        throw part.error instanceof Error
          ? part.error
          : new Error(String(part.error));
    }
  }
  if (onFinish) {
    onFinish({
      steps: (await result.steps) as StepResult<ToolSet>[],
      usage: await result.totalUsage,
      modelId: (await result.response).modelId,
      finishReason: await result.finishReason,
    });
  }
  if (!text.trim()) {
    throw new Error("The model finished without an answer. Try asking again.");
  }
  if (onSources) {
    onSources(
      read.size > 0
        ? [...read.values()]
        : [...seen.values()].filter((n) => n.title && text.includes(n.title)),
    );
  }
  return text;
}
