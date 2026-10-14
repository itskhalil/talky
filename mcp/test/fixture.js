import { DatabaseSync } from "node:sqlite";

/**
 * Build a throwaway sessions.db with the same schema Talky's migrations produce
 * (src-tauri/src/managers/session.rs), so the server can be exercised without a
 * real Talky install.
 */
export function createFixtureDb(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      folder_id TEXT REFERENCES folders(id),
      environment_id TEXT,
      transcript_wiped_at INTEGER
    );
    CREATE TABLE transcript_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      text TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'mic',
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE meeting_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL UNIQUE,
      summary TEXT, action_items TEXT, decisions TEXT,
      user_notes TEXT, enhanced_notes TEXT,
      enhanced_notes_edited INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE folders (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT);
    CREATE TABLE session_tags (
      session_id TEXT NOT NULL, tag_id TEXT NOT NULL,
      PRIMARY KEY (session_id, tag_id)
    );
    CREATE TABLE session_attachments (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, filename TEXT NOT NULL,
      file_path TEXT NOT NULL, mime_type TEXT NOT NULL, file_size INTEGER NOT NULL,
      extracted_text TEXT, created_at INTEGER NOT NULL
    );
  `);

  const at = (iso) => Math.floor(new Date(iso).getTime() / 1000);

  db.exec(`
    INSERT INTO folders (id, name, color, sort_order, created_at)
      VALUES ('f1', 'Client work', '#3b82f6', 0, ${at("2026-01-05T09:00:00Z")});
    INSERT INTO tags (id, name, color) VALUES ('t1', 'pricing', NULL);

    INSERT INTO sessions (id, title, started_at, ended_at, status, folder_id)
      VALUES ('s1', 'Pricing review', ${at("2026-03-02T10:00:00Z")}, ${at("2026-03-02T10:45:00Z")}, 'ended', 'f1');
    INSERT INTO session_tags (session_id, tag_id) VALUES ('s1', 't1');
    INSERT INTO meeting_notes (session_id, user_notes, enhanced_notes, enhanced_notes_edited, created_at, updated_at)
      VALUES ('s1', 'ask about the enterprise tier', 'The team agreed to raise the enterprise tier to $40 per seat.', 1, ${at("2026-03-02T10:50:00Z")}, ${at("2026-03-02T11:00:00Z")});
    INSERT INTO transcript_segments (session_id, text, source, start_ms, end_ms, created_at)
      VALUES ('s1', 'So on the enterprise tier.', 'mic', 1000, 3000, ${at("2026-03-02T10:00:01Z")}),
             ('s1', 'Forty per seat works for us.', 'speaker', 4000, 7000, ${at("2026-03-02T10:00:04Z")});
    INSERT INTO session_attachments (id, session_id, filename, file_path, mime_type, file_size, extracted_text, created_at)
      VALUES ('a1', 's1', 'proposal.pdf', '/tmp/proposal.pdf', 'application/pdf', 1024, 'Proposed rate card', ${at("2026-03-02T09:55:00Z")});

    INSERT INTO sessions (id, title, started_at, ended_at, status, transcript_wiped_at)
      VALUES ('s2', 'Sensitive one-to-one', ${at("2026-04-11T14:00:00Z")}, ${at("2026-04-11T14:30:00Z")}, 'ended', ${at("2026-04-11T14:35:00Z")});
    INSERT INTO meeting_notes (session_id, user_notes, enhanced_notes, enhanced_notes_edited, created_at, updated_at)
      VALUES ('s2', 'private', 'Agreed next steps.', 0, ${at("2026-04-11T14:31:00Z")}, ${at("2026-04-11T14:31:00Z")});
    INSERT INTO transcript_segments (session_id, text, source, start_ms, end_ms, created_at)
      VALUES ('s2', 'this row should never be returned', 'mic', 1000, 2000, ${at("2026-04-11T14:00:01Z")});
  `);

  db.close();
}
