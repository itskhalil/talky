import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BUNDLE_ID = "com.khalil.talky";

/**
 * Talky's default data directory, matching `get_user_data_dir` in src-tauri/src/lib.rs:
 * Tauri's app data dir for the bundle identifier, unless the user set a custom
 * `data_directory` in settings (handled by resolveDbPath below).
 */
function defaultAppDir() {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", BUNDLE_ID);
  }
  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(appData, BUNDLE_ID);
  }
  // Linux isn't a shipping target, but the dev build lands here.
  const dataHome =
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(dataHome, BUNDLE_ID);
}

/**
 * Find sessions.db. Order: explicit TALKY_DB_PATH, then the custom data
 * directory recorded in settings_store.json, then Talky's default app dir.
 */
export function resolveDbPath() {
  if (process.env.TALKY_DB_PATH) return process.env.TALKY_DB_PATH;

  const appDir = defaultAppDir();
  const settingsPath = join(appDir, "settings_store.json");
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      const custom = settings?.data_directory;
      if (typeof custom === "string" && custom.length > 0) {
        return join(custom, "sessions.db");
      }
    } catch {
      // A malformed settings file just means we fall through to the default.
    }
  }

  return join(appDir, "sessions.db");
}

/**
 * Open sessions.db read-only. Talky runs the database in WAL mode
 * (managers/session.rs), so this reads a live database without blocking the app
 * — and read-only means this server can never write to it.
 */
export function openDb(dbPath = resolveDbPath()) {
  if (!existsSync(dbPath)) {
    throw new Error(
      `No Talky database at ${dbPath}. Open Talky once to create it, or set TALKY_DB_PATH.`,
    );
  }
  return new DatabaseSync(dbPath, { readOnly: true });
}

const SESSION_COLUMNS = `s.id, s.title, s.started_at, s.ended_at, s.status,
  s.folder_id, s.environment_id, s.transcript_wiped_at`;

function isoOrNull(epochSeconds) {
  if (epochSeconds === null || epochSeconds === undefined) return null;
  return new Date(epochSeconds * 1000).toISOString();
}

function shapeSession(row) {
  return {
    id: row.id,
    title: row.title,
    startedAt: isoOrNull(row.started_at),
    endedAt: isoOrNull(row.ended_at),
    status: row.status,
    folderId: row.folder_id ?? null,
    // A sealed note had its transcript permanently cleared in Talky. The
    // transcript is gone and this server must never imply otherwise.
    sealedAt: isoOrNull(row.transcript_wiped_at),
  };
}

/** Build the shared WHERE clause for folder / tag / date filters. */
function buildFilters({ folderId, tagIds, startedAfter, startedBefore }) {
  const clauses = [];
  const params = [];
  let joins = "";

  const tags = (tagIds ?? []).filter(Boolean);
  if (tags.length > 0) {
    joins += " INNER JOIN session_tags st ON st.session_id = s.id";
    clauses.push(`st.tag_id IN (${tags.map(() => "?").join(", ")})`);
    params.push(...tags);
  }
  if (folderId) {
    clauses.push("s.folder_id = ?");
    params.push(folderId);
  }
  if (startedAfter) {
    clauses.push("s.started_at >= ?");
    params.push(Math.floor(new Date(startedAfter).getTime() / 1000));
  }
  if (startedBefore) {
    clauses.push("s.started_at <= ?");
    params.push(Math.floor(new Date(startedBefore).getTime() / 1000));
  }

  return { joins, clauses, params };
}

export function listNotes(db, { limit = 20, ...filters } = {}) {
  const { joins, clauses, params } = buildFilters(filters);
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const sql = `SELECT DISTINCT ${SESSION_COLUMNS} FROM sessions s${joins}${where}
    ORDER BY s.started_at DESC LIMIT ?`;
  return db
    .prepare(sql)
    .all(...params, limit)
    .map(shapeSession);
}

/**
 * Excerpt around the first match, so a search result shows why it matched.
 * Talky's own search does the same thing in Rust (managers/session.rs).
 */
function snippet(text, query, radius = 90) {
  if (!text) return "";
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at === -1) return "";
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + query.length + radius);
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}

export function searchNotes(db, { query, limit = 20, ...filters } = {}) {
  const { joins, clauses, params } = buildFilters(filters);
  const trimmed = (query ?? "").trim();

  if (trimmed) {
    clauses.push(
      "(s.title LIKE ? OR mn.user_notes LIKE ? OR mn.enhanced_notes LIKE ?)",
    );
    const pattern = `%${trimmed}%`;
    params.push(pattern, pattern, pattern);
  }

  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const sql = `SELECT DISTINCT ${SESSION_COLUMNS}, mn.user_notes, mn.enhanced_notes
    FROM sessions s
    LEFT JOIN meeting_notes mn ON mn.session_id = s.id${joins}${where}
    ORDER BY s.started_at DESC LIMIT ?`;

  return db
    .prepare(sql)
    .all(...params, limit)
    .map((row) => {
      const session = shapeSession(row);
      if (!trimmed) return { ...session, matchedField: null, snippet: "" };

      const candidates = [
        ["title", row.title],
        ["notes", row.user_notes],
        ["enhanced_notes", row.enhanced_notes],
      ];
      for (const [field, text] of candidates) {
        const excerpt = snippet(text, trimmed);
        if (excerpt)
          return { ...session, matchedField: field, snippet: excerpt };
      }
      return { ...session, matchedField: "title", snippet: "" };
    });
}

export function getNote(db, id, { includeTranscript = false } = {}) {
  const row = db
    .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions s WHERE s.id = ?`)
    .get(id);
  if (!row) return null;

  const session = shapeSession(row);

  const notes = db
    .prepare(
      `SELECT user_notes, enhanced_notes, enhanced_notes_edited, updated_at
       FROM meeting_notes WHERE session_id = ?`,
    )
    .get(id);

  const tags = db
    .prepare(
      `SELECT t.name FROM tags t
       INNER JOIN session_tags st ON st.tag_id = t.id
       WHERE st.session_id = ? ORDER BY t.name`,
    )
    .all(id)
    .map((r) => r.name);

  const folder = session.folderId
    ? db.prepare("SELECT name FROM folders WHERE id = ?").get(session.folderId)
        ?.name
    : null;

  const attachments = db
    .prepare(
      `SELECT filename, mime_type, extracted_text
       FROM session_attachments WHERE session_id = ? ORDER BY created_at`,
    )
    .all(id)
    .map((r) => ({
      filename: r.filename,
      mimeType: r.mime_type,
      extractedText: r.extracted_text ?? null,
    }));

  // A sealed note's transcript was deliberately destroyed. Refuse the request
  // rather than returning an empty transcript that reads like "nothing was said".
  let transcript = null;
  if (includeTranscript && !session.sealedAt) {
    transcript = db
      .prepare(
        `SELECT text, source, start_ms FROM transcript_segments
         WHERE session_id = ? ORDER BY start_ms`,
      )
      .all(id)
      .map((r) => ({ text: r.text, source: r.source, startMs: r.start_ms }));
  }

  return {
    ...session,
    folder,
    tags,
    notes: notes?.user_notes ?? null,
    enhancedNotes: notes?.enhanced_notes ?? null,
    enhancedNotesEdited: Boolean(notes?.enhanced_notes_edited),
    attachments,
    transcript,
  };
}

export function listFolders(db) {
  return db
    .prepare("SELECT id, name FROM folders ORDER BY sort_order, name")
    .all();
}

export function listTags(db) {
  return db.prepare("SELECT id, name FROM tags ORDER BY name").all();
}
