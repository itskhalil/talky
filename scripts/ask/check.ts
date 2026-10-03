/**
 * Exercise src/lib/ask.ts outside the app, against a Talky database.
 *
 *   npx esbuild scripts/ask/check.ts --bundle --platform=node --format=esm \
 *     --outfile=/tmp/ask-check.mjs --alias:@=./src && \
 *   node /tmp/ask-check.mjs "<data dir>" ["question", ...]
 *
 * First checks the environment boundary with no model involved, then asks
 * each question with the data directory's first AI environment.
 * Point it at a demo data directory (scripts/demo/seed.py), not real notes.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ask,
  acrossNotesPrompt,
  buildModel,
  noteTools,
  type NoteSource,
} from "@/lib/ask";

const dir = process.argv[2];
const questions = process.argv.slice(3);
const db = new DatabaseSync(join(dir, "sessions.db"), { readOnly: true });
type Row = {
  id: string;
  title: string;
  started_at: number;
  environment_id: string | null;
};
const toNote = (r: Row) => ({
  id: r.id,
  title: r.title,
  startedAt: r.started_at,
  environmentId: r.environment_id,
});

const source: NoteSource = {
  async search(query) {
    const like = `%${query.split(/\s+/)[0]}%`;
    const rows = db
      .prepare(
        `SELECT DISTINCT s.* FROM sessions s
       LEFT JOIN meeting_notes m ON m.session_id = s.id
       LEFT JOIN transcript_segments t ON t.session_id = s.id
       WHERE s.title LIKE ? OR m.user_notes LIKE ? OR m.enhanced_notes LIKE ? OR t.text LIKE ?
       ORDER BY s.started_at DESC`,
      )
      .all(like, like, like, like) as Row[];
    return rows.map((r) => ({ ...toNote(r), snippet: "" }));
  },
  async list() {
    return (
      db
        .prepare("SELECT * FROM sessions ORDER BY started_at DESC")
        .all() as Row[]
    ).map(toNote);
  },
  async get(id) {
    const r = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
      | Row
      | undefined;
    return r ? toNote(r) : null;
  },
  async read(id) {
    const m = db
      .prepare(
        "SELECT user_notes, enhanced_notes FROM meeting_notes WHERE session_id = ?",
      )
      .get(id) as
      | { user_notes: string | null; enhanced_notes: string | null }
      | undefined;
    const segs = db
      .prepare(
        "SELECT source, text FROM transcript_segments WHERE session_id = ? ORDER BY start_ms",
      )
      .all(id) as Array<{ source: string; text: string }>;
    return {
      userNotes: m?.user_notes ?? "",
      enhancedNotes: m?.enhanced_notes ?? "",
      transcript: segs.map((s) => `[${s.source}] ${s.text}`).join("\n"),
    };
  },
};

const settings = JSON.parse(
  readFileSync(join(dir, "settings_store.json"), "utf8"),
);
const s = settings.settings ?? settings;
const env = s.model_environments[0];
const defaultEnvId: string | null = s.default_environment_id ?? null;

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error("FAIL", msg);
    process.exitCode = 1;
  } else console.log("ok  ", msg);
}

// The boundary: pretend the newest note belongs to another environment.
const all = await source.list();
const secret = all[0];
const fenced: NoteSource = {
  ...source,
  async search(q) {
    return (await source.search(q)).map((n) =>
      n.id === secret.id ? { ...n, environmentId: "other-env" } : n,
    );
  },
  async list() {
    return (await source.list()).map((n) =>
      n.id === secret.id ? { ...n, environmentId: "other-env" } : n,
    );
  },
  async get(id) {
    const n = await source.get(id);
    return n && n.id === secret.id ? { ...n, environmentId: "other-env" } : n;
  },
};
const tools = noteTools(fenced, env.id, defaultEnvId);
const opts = { toolCallId: "t", messages: [] };
const listed = (await tools.search_notes.execute!({ query: "" }, opts)) as {
  notes: Array<{ id: string }>;
};
assert(
  !listed.notes.some((n) => n.id === secret.id),
  "search_notes never lists another environment's note",
);
const word =
  secret.title.split(/\W+/).find((w) => w.length > 3) ?? secret.title;
const searched = (await tools.search_notes.execute!({ query: word }, opts)) as {
  notes?: Array<{ id: string }>;
};
assert(
  !(searched.notes ?? []).some((n) => n.id === secret.id),
  `searching '${word}' doesn't surface it either`,
);
const read = (await tools.read_note.execute!({ id: secret.id }, opts)) as {
  error?: string;
};
assert(read.error, "read_note refuses it by id");
const own = (await tools.read_note.execute!({ id: all[1].id }, opts)) as {
  title?: string;
};
assert(
  own.title === all[1].title,
  "read_note returns a note in the environment",
);

for (const q of questions) {
  const t0 = Date.now();
  const steps: string[] = [];
  const answer = await ask({
    model: buildModel({
      baseUrl: env.base_url,
      apiKey: env.api_key,
      model: env.chat_model,
    }),
    system: acrossNotesPrompt(s.user_name),
    messages: [{ role: "user", content: q }],
    tools: noteTools(source, env.id, defaultEnvId),
    onText: () => {},
  });
  void steps;
  console.log(
    `\n> ${q}  (${((Date.now() - t0) / 1000).toFixed(1)}s)\n${answer}`,
  );
}
