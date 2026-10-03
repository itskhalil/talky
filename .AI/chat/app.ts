/**
 * The chat eval's view of the app: runs one case through src/lib/ask.ts
 * exactly as useGlobalChat does, against the fictional notes in
 * fixtures.mjs. Bundled by `npm run eval:chat` (esbuild resolves `@/`).
 *
 * The one stand-in is the note store. Search mirrors the Rust
 * `search_sessions`: an FTS5 index with the same tokenizer and one row per
 * field (title, user notes, enhanced notes without [ai]/[noted] markers,
 * each transcript segment), every term required, the last one as a prefix,
 * newest first, one hit per note keeping the strongest field.
 */
import { DatabaseSync } from "node:sqlite";
import {
  acrossNotesPrompt,
  ask,
  buildModel,
  noteTools,
  oneNoteContent,
  oneNotePrompt,
  type AskRun,
  type NoteSource,
} from "@/lib/ask";
import { materialise } from "./fixtures.mjs";

type Note = ReturnType<typeof materialise>[number];

const ENV_ID = "env-default";
// The eval's user; a fictional name, as the app passes the settings name.
const USER_NAME = "Alex";

const FIELD_RANK: Record<string, number> = {
  title: 0,
  user_notes: 1,
  enhanced_notes: 2,
  transcript: 3,
};

const stripMarkers = (s: string) =>
  s.replace(/\[noted\] /g, "").replace(/\[ai\] /g, "").replace(/\[noted\]|\[ai\]/g, "");

/** Same rule as the Rust `to_fts_query`. */
function toFtsQuery(input: string): string | null {
  const tokens = input.split(/[^\p{L}\p{N}']+/u).filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens
    .map((t, i) => {
      const cleaned = t.replace(/"/g, "");
      return i === tokens.length - 1 ? `"${cleaned}"*` : `"${cleaned}"`;
    })
    .join(" ");
}

export function fixtureSource(notes: Note[]): NoteSource {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE VIRTUAL TABLE search_index USING fts5(
       body, session_id UNINDEXED, field UNINDEXED,
       tokenize = 'unicode61 remove_diacritics 2')`,
  );
  const insert = db.prepare(
    "INSERT INTO search_index (body, session_id, field) VALUES (?, ?, ?)",
  );
  for (const n of notes) {
    insert.run(n.title, n.id, "title");
    if (n.userNotes) insert.run(n.userNotes, n.id, "user_notes");
    if (n.enhancedNotes)
      insert.run(stripMarkers(n.enhancedNotes), n.id, "enhanced_notes");
    for (const s of n.segments) insert.run(s.text, n.id, "transcript");
  }
  const byId = new Map(notes.map((n) => [n.id, n]));
  const summary = (n: Note) => ({
    id: n.id,
    title: n.title,
    startedAt: n.startedAt,
    environmentId: n.environmentId,
  });
  const search = db.prepare(
    `SELECT session_id, field, snippet(search_index, 0, '', '', '…', 14) AS snip
     FROM search_index WHERE search_index MATCH ?`,
  );

  return {
    async search(query) {
      const fts = toFtsQuery(query);
      if (!fts) {
        return notes
          .slice()
          .sort((a, b) => b.startedAt - a.startedAt)
          .map((n) => ({ ...summary(n), snippet: "" }));
      }
      const best = new Map<string, { field: string; snippet: string }>();
      for (const row of search.all(fts) as Array<{
        session_id: string;
        field: string;
        snip: string;
      }>) {
        const snippet = row.field === "title" ? "" : row.snip;
        const prev = best.get(row.session_id);
        if (!prev || FIELD_RANK[row.field] < FIELD_RANK[prev.field])
          best.set(row.session_id, { field: row.field, snippet });
      }
      return [...best.entries()]
        .map(([id, hit]) => ({ ...summary(byId.get(id)!), snippet: hit.snippet }))
        .sort((a, b) => b.startedAt - a.startedAt);
    },
    async list() {
      return notes
        .slice()
        .sort((a, b) => b.startedAt - a.startedAt)
        .map(summary);
    },
    async get(id) {
      const n = byId.get(id);
      return n ? summary(n) : null;
    },
    async read(id) {
      const n = byId.get(id)!;
      return {
        userNotes: n.userNotes,
        enhancedNotes: n.enhancedNotes,
        transcript: n.segments.map((s) => `[${s.source}] ${s.text}`).join("\n"),
      };
    },
  };
}

/** NoteView's getTranscriptText, which the one-note chat reads. */
function noteViewTranscript(n: Note): string {
  const formatMs = (ms: number) => {
    const total = Math.floor(ms / 1000);
    return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, "0")}`;
  };
  return n.segments
    .map((s) => {
      const label = s.source === "mic" ? "[User]" : "[Other]";
      return `[${formatMs(s.startMs)}] ${label}: ${s.text}`;
    })
    .join("\n");
}

export interface EvalCase {
  id: string;
  mode: "across" | "note";
  note?: string;
  question: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface CaseRun {
  output: string;
  system: string;
  run: AskRun | null;
}

/** Ask one case's question the way the app would. */
export async function runCase(
  c: EvalCase,
  endpoint: { baseUrl: string; apiKey: string; model: string },
  notes: Note[],
): Promise<CaseRun> {
  let system: string;
  let tools: ReturnType<typeof noteTools> | undefined;
  if (c.mode === "note") {
    const n = notes.find((x) => x.key === c.note);
    if (!n) throw new Error(`case ${c.id}: no fixture note '${c.note}'`);
    system = oneNotePrompt(
      {
        title: n.title,
        date: new Date(n.startedAt * 1000).toLocaleDateString(),
        userNotes: n.userNotes,
        content: oneNoteContent(n.enhancedNotes, noteViewTranscript(n)),
      },
      USER_NAME,
    );
  } else {
    system = acrossNotesPrompt(USER_NAME);
    tools = noteTools(fixtureSource(notes), ENV_ID, ENV_ID);
  }
  let run: AskRun | null = null;
  let output = "";
  try {
    output = await ask({
      model: buildModel(endpoint),
      system,
      messages: [...(c.history ?? []), { role: "user", content: c.question }],
      tools,
      onText: () => {},
      onFinish: (r) => {
        run = r;
      },
    });
  } catch (e) {
    // Keep the billed run on the error so the runner can count its usage.
    (e as { askRun?: AskRun | null }).askRun = run;
    throw e;
  }
  return { output, system, run };
}

export { materialise };
