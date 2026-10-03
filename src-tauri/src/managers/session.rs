use crate::utils::MutexExt;
use anyhow::Result;
use chrono::Utc;
use log::{debug, info, warn};
use rusqlite::{params, Connection, OptionalExtension};
use rusqlite_migration::{Migrations, M};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

static SESSION_MIGRATIONS: &[M] = &[
    M::up(
        "CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            ended_at INTEGER,
            status TEXT NOT NULL DEFAULT 'active'
        );",
    ),
    M::up(
        "CREATE TABLE IF NOT EXISTS transcript_segments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            text TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'mic',
            start_ms INTEGER NOT NULL,
            end_ms INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (session_id) REFERENCES sessions(id)
        );",
    ),
    M::up(
        "CREATE TABLE IF NOT EXISTS meeting_notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL UNIQUE,
            summary TEXT,
            action_items TEXT,
            decisions TEXT,
            user_notes TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (session_id) REFERENCES sessions(id)
        );",
    ),
    M::up(
        "CREATE TABLE IF NOT EXISTS audio_recordings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            file_name TEXT NOT NULL,
            channel TEXT NOT NULL DEFAULT 'mixed',
            created_at INTEGER NOT NULL,
            FOREIGN KEY (session_id) REFERENCES sessions(id)
        );",
    ),
    M::up("ALTER TABLE meeting_notes ADD COLUMN enhanced_notes TEXT;"),
    // Migration 5: Create folders table
    M::up(
        "CREATE TABLE IF NOT EXISTS folders (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            color TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        );",
    ),
    // Migration 6: Add folder_id to sessions
    M::up("ALTER TABLE sessions ADD COLUMN folder_id TEXT REFERENCES folders(id);"),
    // Migration 7: Create tags table
    M::up(
        "CREATE TABLE IF NOT EXISTS tags (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            color TEXT
        );",
    ),
    // Migration 8: Create session_tags junction table
    M::up(
        "CREATE TABLE IF NOT EXISTS session_tags (
            session_id TEXT NOT NULL,
            tag_id TEXT NOT NULL,
            PRIMARY KEY (session_id, tag_id),
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
            FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
        );",
    ),
    // Migration 9: Index for faster folder queries
    M::up("CREATE INDEX IF NOT EXISTS idx_sessions_folder ON sessions(folder_id);"),
    // Migration 10: Add enhanced_notes_edited flag to track user edits
    M::up("ALTER TABLE meeting_notes ADD COLUMN enhanced_notes_edited INTEGER NOT NULL DEFAULT 0;"),
    // Migration 11: Add environment_id to sessions for model environments feature
    M::up("ALTER TABLE sessions ADD COLUMN environment_id TEXT;"),
    // Migration 12: Add session_attachments table for document uploads
    M::up(
        "CREATE TABLE IF NOT EXISTS session_attachments (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            filename TEXT NOT NULL,
            file_path TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            file_size INTEGER NOT NULL,
            extracted_text TEXT,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );",
    ),
    // Migration 13: Index for faster attachment queries by session
    M::up("CREATE INDEX IF NOT EXISTS idx_attachments_session ON session_attachments(session_id);"),
    // Migration 14: transcript_wiped_at marks a session as sealed (transcript cleared, recording locked)
    M::up("ALTER TABLE sessions ADD COLUMN transcript_wiped_at INTEGER;"),
    // Migration 15: link a note to the calendar meeting it belongs to.
    //
    // `calendar_event_id` is the server-side external identifier, which every
    // occurrence of a recurring series shares — `calendar_event_start` names
    // the occurrence. `calendar_snapshot` is the full event as JSON, captured
    // at link time: the attendee list has to outlive the calendar entry, which
    // gets edited, cancelled, or ages out of the local store.
    M::up(
        "ALTER TABLE sessions ADD COLUMN calendar_event_id TEXT;
         ALTER TABLE sessions ADD COLUMN calendar_event_start INTEGER;
         ALTER TABLE sessions ADD COLUMN calendar_snapshot TEXT;
         CREATE INDEX IF NOT EXISTS idx_sessions_calendar_event
             ON sessions(calendar_event_id, calendar_event_start);",
    ),
    // Migration 16: full-text search over titles, notes and transcripts.
    //
    // Replaces a LIKE query that could only reach titles and notes, leaving
    // transcripts — the bulk of what Talky records — unsearchable.
    //
    // One row per (session, field), and one per transcript segment so a hit
    // points at the moment it came from. Triggers own the index: `save_meeting_notes`
    // upserts with COALESCE, so only the database knows the resulting text, and
    // a trigger cannot be forgotten the way a call site can.
    //
    // Deletes scan the FTS table because `session_id` is UNINDEXED. At the
    // scale this is built for — thousands of notes — that is well under a
    // millisecond. If the corpus ever reaches a size where it shows up, the
    // fix is the external-content pattern with a real content table, not an
    // index on an FTS column.
    M::up(
        "CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
            body,
            session_id UNINDEXED,
            field UNINDEXED,
            ref_id UNINDEXED,
            tokenize = 'unicode61 remove_diacritics 2'
         );

         CREATE TRIGGER IF NOT EXISTS search_sessions_ai AFTER INSERT ON sessions BEGIN
             INSERT INTO search_index(body, session_id, field, ref_id)
             SELECT new.title, new.id, 'title', NULL WHERE COALESCE(new.title, '') <> '';
         END;

         CREATE TRIGGER IF NOT EXISTS search_sessions_au AFTER UPDATE OF title ON sessions BEGIN
             DELETE FROM search_index WHERE session_id = new.id AND field = 'title';
             INSERT INTO search_index(body, session_id, field, ref_id)
             SELECT new.title, new.id, 'title', NULL WHERE COALESCE(new.title, '') <> '';
         END;

         CREATE TRIGGER IF NOT EXISTS search_sessions_ad AFTER DELETE ON sessions BEGIN
             DELETE FROM search_index WHERE session_id = old.id;
         END;

         CREATE TRIGGER IF NOT EXISTS search_notes_ai AFTER INSERT ON meeting_notes BEGIN
             INSERT INTO search_index(body, session_id, field, ref_id)
             SELECT new.user_notes, new.session_id, 'user_notes', NULL
             WHERE COALESCE(new.user_notes, '') <> '';
             INSERT INTO search_index(body, session_id, field, ref_id)
             SELECT replace(replace(replace(replace(new.enhanced_notes, '[noted] ', ''), '[ai] ', ''), '[noted]', ''), '[ai]', ''), new.session_id, 'enhanced_notes', NULL
             WHERE COALESCE(new.enhanced_notes, '') <> '';
         END;

         CREATE TRIGGER IF NOT EXISTS search_notes_au AFTER UPDATE ON meeting_notes BEGIN
             DELETE FROM search_index
             WHERE session_id = new.session_id AND field IN ('user_notes', 'enhanced_notes');
             INSERT INTO search_index(body, session_id, field, ref_id)
             SELECT new.user_notes, new.session_id, 'user_notes', NULL
             WHERE COALESCE(new.user_notes, '') <> '';
             INSERT INTO search_index(body, session_id, field, ref_id)
             SELECT replace(replace(replace(replace(new.enhanced_notes, '[noted] ', ''), '[ai] ', ''), '[noted]', ''), '[ai]', ''), new.session_id, 'enhanced_notes', NULL
             WHERE COALESCE(new.enhanced_notes, '') <> '';
         END;

         CREATE TRIGGER IF NOT EXISTS search_notes_ad AFTER DELETE ON meeting_notes BEGIN
             DELETE FROM search_index
             WHERE session_id = old.session_id AND field IN ('user_notes', 'enhanced_notes');
         END;

         CREATE TRIGGER IF NOT EXISTS search_segments_ai AFTER INSERT ON transcript_segments BEGIN
             INSERT INTO search_index(body, session_id, field, ref_id)
             SELECT new.text, new.session_id, 'transcript', new.id
             WHERE COALESCE(new.text, '') <> '';
         END;

         CREATE TRIGGER IF NOT EXISTS search_segments_ad AFTER DELETE ON transcript_segments BEGIN
             DELETE FROM search_index WHERE field = 'transcript' AND ref_id = old.id;
         END;

         INSERT INTO search_index(body, session_id, field, ref_id)
             SELECT title, id, 'title', NULL FROM sessions WHERE COALESCE(title, '') <> '';
         INSERT INTO search_index(body, session_id, field, ref_id)
             SELECT user_notes, session_id, 'user_notes', NULL FROM meeting_notes
             WHERE COALESCE(user_notes, '') <> '';
         INSERT INTO search_index(body, session_id, field, ref_id)
             SELECT replace(replace(replace(replace(enhanced_notes, '[noted] ', ''), '[ai] ', ''), '[noted]', ''), '[ai]', ''), session_id, 'enhanced_notes', NULL FROM meeting_notes
             WHERE COALESCE(enhanced_notes, '') <> '';
         INSERT INTO search_index(body, session_id, field, ref_id)
             SELECT text, session_id, 'transcript', id FROM transcript_segments
             WHERE COALESCE(text, '') <> '';",
    ),
];

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct Session {
    pub id: String,
    pub title: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub status: String,
    pub folder_id: Option<String>,
    pub environment_id: Option<String>,
    /// External identifier of the calendar meeting this note covers, when it
    /// is linked to one. The event itself is fetched separately — see
    /// `get_session_calendar_event` — so note lists stay cheap.
    pub calendar_event_id: Option<String>,
    /// Epoch seconds when the raw transcript was cleared. When set, the note is
    /// sealed: recording is locked and the transcript panel shows a placeholder.
    pub transcript_wiped_at: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub sort_order: i32,
    pub created_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct Attachment {
    pub id: String,
    pub session_id: String,
    pub filename: String,
    pub file_path: String,
    pub mime_type: String,
    pub file_size: i64,
    pub extracted_text: Option<String>,
    pub created_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct TranscriptSegment {
    pub id: i64,
    pub session_id: String,
    pub text: String,
    pub source: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub created_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct MeetingNotes {
    pub id: i64,
    pub session_id: String,
    pub summary: Option<String>,
    pub action_items: Option<String>,
    pub decisions: Option<String>,
    pub user_notes: Option<String>,
    pub enhanced_notes: Option<String>,
    pub enhanced_notes_edited: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct SearchHit {
    pub session: Session,
    /// Which column produced the match: "title" | "user_notes" | "enhanced_notes".
    /// When only filters are active and query is empty, this is "title" with an empty snippet.
    pub matched_field: String,
    /// Short excerpt centered on the first match, with markdown noise stripped. Empty when no text match.
    pub snippet: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
pub struct SearchFilters {
    pub folder_id: Option<String>,
    pub tag_ids: Option<Vec<String>>,
    pub started_after: Option<i64>,
    pub started_before: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct TranscriptSegmentEvent {
    pub session_id: String,
    pub segment: TranscriptSegment,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct SessionAmplitudeEvent {
    pub session_id: String,
    pub mic: u16,
    pub speaker: u16,
}

pub struct SessionManager {
    app_handle: AppHandle,
    db_path: PathBuf,
    active_session: Arc<Mutex<Option<String>>>,
    session_start_time: Arc<Mutex<Option<std::time::Instant>>>,
    /// Shared buffer where the speaker capture task accumulates samples
    speaker_buffer: Arc<Mutex<Vec<f32>>>,
    /// Signal to stop the speaker capture task
    speaker_shutdown: Arc<AtomicBool>,
    /// Handle to the speaker capture thread for proper cleanup
    speaker_thread_handle: Arc<Mutex<Option<JoinHandle<()>>>>,
}

impl SessionManager {
    /// Creates a new SessionManager.
    /// If `data_dir` is Some, uses that directory for sessions.db.
    /// Otherwise, uses the default app data directory.
    pub fn new(app_handle: &AppHandle, data_dir: Option<PathBuf>) -> Result<Self> {
        let app_data_dir = app_handle.path().app_data_dir()?;
        // Use custom data directory for the database if provided, otherwise use default
        let db_dir = data_dir.unwrap_or_else(|| app_data_dir.clone());
        let db_path = db_dir.join("sessions.db");

        // Ensure db directory exists
        if !db_dir.exists() {
            fs::create_dir_all(&db_dir)?;
        }

        let manager = Self {
            app_handle: app_handle.clone(),
            db_path,
            active_session: Arc::new(Mutex::new(None)),
            session_start_time: Arc::new(Mutex::new(None)),
            speaker_buffer: Arc::new(Mutex::new(Vec::new())),
            speaker_shutdown: Arc::new(AtomicBool::new(false)),
            speaker_thread_handle: Arc::new(Mutex::new(None)),
        };

        manager.init_database()?;

        Ok(manager)
    }

    fn init_database(&self) -> Result<()> {
        let mut conn = Connection::open(&self.db_path)?;

        // Enable WAL mode for better crash recovery - writes go to a log file first,
        // so the main database file stays intact if we crash mid-write
        conn.pragma_update(None, "journal_mode", "WAL")?;

        let migrations = Migrations::new(SESSION_MIGRATIONS.to_vec());

        #[cfg(debug_assertions)]
        migrations.validate().expect("Invalid session migrations");

        migrations.to_latest(&mut conn)?;
        debug!("Session database initialized");
        Ok(())
    }

    fn get_connection(&self) -> Result<Connection> {
        Ok(Connection::open(&self.db_path)?)
    }

    pub fn start_session(
        &self,
        title: Option<String>,
        default_environment_id: Option<String>,
    ) -> Result<Session> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().timestamp();
        let title = title.unwrap_or_else(|| "New Note".to_string());

        let env_id = default_environment_id.as_deref();

        let conn = self.get_connection()?;
        conn.execute(
            "INSERT INTO sessions (id, title, started_at, status, environment_id) VALUES (?1, ?2, ?3, 'active', ?4)",
            params![id, title, now, env_id],
        )?;

        *self.active_session.lock_or_recover() = Some(id.clone());
        *self.session_start_time.lock_or_recover() = Some(std::time::Instant::now());

        let session = Session {
            id,
            title,
            started_at: now,
            ended_at: None,
            status: "active".to_string(),
            folder_id: None,
            calendar_event_id: None,
            environment_id: default_environment_id,
            transcript_wiped_at: None,
        };

        let _ = self.app_handle.emit("session-started", &session);
        info!("Session started: {}", session.id);

        Ok(session)
    }

    pub fn end_session(&self) -> Result<Option<Session>> {
        let session_id = {
            let mut active = self.active_session.lock_or_recover();
            active.take()
        };

        let Some(session_id) = session_id else {
            return Ok(None);
        };

        *self.session_start_time.lock_or_recover() = None;

        let now = Utc::now().timestamp();
        let conn = self.get_connection()?;
        conn.execute(
            "UPDATE sessions SET ended_at = ?1, status = 'completed' WHERE id = ?2",
            params![now, session_id],
        )?;

        let session = self.get_session(&session_id)?;
        if let Some(ref s) = session {
            let _ = self.app_handle.emit("session-ended", s);
        }

        info!("Session ended: {}", session_id);
        Ok(session)
    }

    pub fn get_active_session_id(&self) -> Option<String> {
        self.active_session.lock_or_recover().clone()
    }

    pub fn add_segment(
        &self,
        session_id: &str,
        text: String,
        source: &str,
        start_ms: i64,
        end_ms: i64,
    ) -> Result<TranscriptSegment> {
        let now = Utc::now().timestamp();
        let conn = self.get_connection()?;

        conn.execute(
            "INSERT INTO transcript_segments (session_id, text, source, start_ms, end_ms, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![session_id, text, source, start_ms, end_ms, now],
        )?;

        let id = conn.last_insert_rowid();

        let segment = TranscriptSegment {
            id,
            session_id: session_id.to_string(),
            text,
            source: source.to_string(),
            start_ms,
            end_ms,
            created_at: now,
        };

        let _ = self.app_handle.emit(
            "transcript-segment",
            TranscriptSegmentEvent {
                session_id: session_id.to_string(),
                segment: segment.clone(),
            },
        );

        Ok(segment)
    }

    /// Search notes by text and filters.
    ///
    /// Text matching goes through the `search_index` FTS5 table, which covers
    /// titles, user notes, enhanced notes and every transcript segment. The
    /// LIKE query this replaced could not reach transcripts at all, and matched
    /// mid-word — "th" inside "with" — which is why it needed a second
    /// word-boundary pass in Rust to throw results away again. FTS5 tokenises
    /// on word boundaries, so that pass is gone.
    ///
    /// Results stay in reverse chronological order rather than switching to
    /// bm25 relevance. Ranking across a five-word title and a sixty-word
    /// transcript segment is its own problem, and worth deciding with the
    /// feature in hand rather than alongside the index that enables it.
    pub fn search_sessions(&self, query: &str, filters: &SearchFilters) -> Result<Vec<SearchHit>> {
        let conn = self.get_connection()?;
        run_search(&conn, query, filters)
    }
}

/// The search query itself, taking a connection so it can be tested against an
/// in-memory database rather than only through a live `SessionManager`.
fn run_search(conn: &Connection, query: &str, filters: &SearchFilters) -> Result<Vec<SearchHit>> {
    {
        let fts_query = to_fts_query(query);

        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

        // The MATCH argument binds before any filter, so it is pushed first.
        let mut sql = if let Some(fts) = &fts_query {
            params_vec.push(Box::new(fts.clone()));
            String::from(
                "SELECT s.id, s.title, s.started_at, s.ended_at, s.status, s.folder_id, \
                        s.environment_id, s.calendar_event_id, s.transcript_wiped_at, \
                        si.field AS field, \
                        snippet(search_index, 0, '', '', '…', 14) AS snip \
                 FROM search_index si \
                 JOIN sessions s ON s.id = si.session_id \
                 WHERE search_index MATCH ?",
            )
        } else {
            String::from(
                "SELECT s.id, s.title, s.started_at, s.ended_at, s.status, s.folder_id, \
                        s.environment_id, s.calendar_event_id, s.transcript_wiped_at, \
                        'title' AS field, '' AS snip \
                 FROM sessions s",
            )
        };

        let mut where_clauses: Vec<String> = Vec::new();

        if let Some(folder_id) = &filters.folder_id {
            if !folder_id.is_empty() {
                where_clauses.push("s.folder_id = ?".to_string());
                params_vec.push(Box::new(folder_id.clone()));
            }
        }

        let tag_ids_vec: Vec<String> = filters
            .tag_ids
            .as_ref()
            .map(|v| v.iter().filter(|t| !t.is_empty()).cloned().collect())
            .unwrap_or_default();

        if !tag_ids_vec.is_empty() {
            // A subquery rather than a join: the FTS side already produces
            // several rows per session, and adding a tag join on top would
            // need a GROUP BY over every selected column.
            let placeholders = vec!["?"; tag_ids_vec.len()].join(",");
            where_clauses.push(format!(
                "s.id IN (SELECT session_id FROM session_tags WHERE tag_id IN ({}) \
                 GROUP BY session_id HAVING COUNT(DISTINCT tag_id) = ?)",
                placeholders
            ));
            for tag_id in &tag_ids_vec {
                params_vec.push(Box::new(tag_id.clone()));
            }
            params_vec.push(Box::new(tag_ids_vec.len() as i64));
        }

        if let Some(after) = filters.started_after {
            where_clauses.push("s.started_at >= ?".to_string());
            params_vec.push(Box::new(after));
        }

        if let Some(before) = filters.started_before {
            where_clauses.push("s.started_at <= ?".to_string());
            params_vec.push(Box::new(before));
        }

        if !where_clauses.is_empty() {
            sql.push_str(if fts_query.is_some() {
                " AND "
            } else {
                " WHERE "
            });
            sql.push_str(&where_clauses.join(" AND "));
        }

        sql.push_str(" ORDER BY s.started_at DESC");

        let mut stmt = conn.prepare(&sql)?;
        let params_ref: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|b| b.as_ref()).collect();

        let rows = stmt.query_map(params_ref.as_slice(), |row| {
            let session = Session {
                id: row.get("id")?,
                title: row.get("title")?,
                started_at: row.get("started_at")?,
                ended_at: row.get("ended_at")?,
                status: row.get("status")?,
                folder_id: row.get("folder_id")?,
                environment_id: row.get("environment_id")?,
                calendar_event_id: row.get("calendar_event_id")?,
                transcript_wiped_at: row.get("transcript_wiped_at")?,
            };
            let field: String = row.get("field")?;
            let snip: String = row.get("snip")?;
            Ok((session, field, snip))
        })?;

        // A session can match in several fields at once. Keep one hit per
        // session, showing the strongest match — a title hit says more about
        // what the note is than a passing mention in the transcript.
        let mut hits: Vec<SearchHit> = Vec::new();
        let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();

        for row in rows {
            let (session, field, snip) = row?;
            // Title matches show no snippet: the title is already on screen.
            let snippet = if field == "title" {
                String::new()
            } else {
                snip
            };

            match seen.get(&session.id) {
                Some(&i) => {
                    if field_rank(&field) < field_rank(&hits[i].matched_field) {
                        hits[i].matched_field = field;
                        hits[i].snippet = snippet;
                    }
                }
                None => {
                    seen.insert(session.id.clone(), hits.len());
                    hits.push(SearchHit {
                        session,
                        matched_field: field,
                        snippet,
                    });
                }
            }
        }

        Ok(hits)
    }
}

impl SessionManager {
    pub fn get_sessions(&self) -> Result<Vec<Session>> {
        let conn = self.get_connection()?;
        let mut stmt = conn.prepare(
            "SELECT id, title, started_at, ended_at, status, folder_id, environment_id, calendar_event_id, transcript_wiped_at FROM sessions ORDER BY started_at DESC",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(Session {
                id: row.get("id")?,
                title: row.get("title")?,
                started_at: row.get("started_at")?,
                ended_at: row.get("ended_at")?,
                status: row.get("status")?,
                folder_id: row.get("folder_id")?,
                environment_id: row.get("environment_id")?,
                calendar_event_id: row.get("calendar_event_id")?,
                transcript_wiped_at: row.get("transcript_wiped_at")?,
            })
        })?;

        let mut sessions = Vec::new();
        for row in rows {
            sessions.push(row?);
        }
        Ok(sessions)
    }

    pub fn get_session(&self, session_id: &str) -> Result<Option<Session>> {
        let conn = self.get_connection()?;
        let session = conn
            .query_row(
                "SELECT id, title, started_at, ended_at, status, folder_id, environment_id, calendar_event_id, transcript_wiped_at FROM sessions WHERE id = ?1",
                params![session_id],
                |row| {
                    Ok(Session {
                        id: row.get("id")?,
                        title: row.get("title")?,
                        started_at: row.get("started_at")?,
                        ended_at: row.get("ended_at")?,
                        status: row.get("status")?,
                        folder_id: row.get("folder_id")?,
                        environment_id: row.get("environment_id")?,
                        calendar_event_id: row.get("calendar_event_id")?,
                        transcript_wiped_at: row.get("transcript_wiped_at")?,
                    })
                },
            )
            .optional()?;
        Ok(session)
    }

    pub fn get_session_transcript(&self, session_id: &str) -> Result<Vec<TranscriptSegment>> {
        let conn = self.get_connection()?;
        let mut stmt = conn.prepare(
            "SELECT id, session_id, text, source, start_ms, end_ms, created_at FROM transcript_segments WHERE session_id = ?1 ORDER BY start_ms ASC",
        )?;

        let rows = stmt.query_map(params![session_id], |row| {
            Ok(TranscriptSegment {
                id: row.get("id")?,
                session_id: row.get("session_id")?,
                text: row.get("text")?,
                source: row.get("source")?,
                start_ms: row.get("start_ms")?,
                end_ms: row.get("end_ms")?,
                created_at: row.get("created_at")?,
            })
        })?;

        let mut segments = Vec::new();
        for row in rows {
            segments.push(row?);
        }
        Ok(segments)
    }

    /// Get recent transcript segments for a session, filtered by source and time window.
    ///
    /// This is used for deduplication - when adding a mic segment, we check if
    /// similar speaker segments already exist in the recent time window.
    ///
    /// # Arguments
    /// * `session_id` - The session to query
    /// * `source` - The source to filter by ("mic" or "speaker")
    /// * `since_ms` - Only return segments that end after this time (in session milliseconds)
    ///
    /// # Returns
    /// A vector of transcript segments matching the criteria
    pub fn get_recent_segments(
        &self,
        session_id: &str,
        source: &str,
        since_ms: i64,
    ) -> Result<Vec<TranscriptSegment>> {
        let conn = self.get_connection()?;
        let mut stmt = conn.prepare(
            "SELECT id, session_id, text, source, start_ms, end_ms, created_at
             FROM transcript_segments
             WHERE session_id = ?1 AND source = ?2 AND end_ms >= ?3
             ORDER BY start_ms DESC
             LIMIT 25",
        )?;

        let rows = stmt.query_map(params![session_id, source, since_ms], |row| {
            Ok(TranscriptSegment {
                id: row.get("id")?,
                session_id: row.get("session_id")?,
                text: row.get("text")?,
                source: row.get("source")?,
                start_ms: row.get("start_ms")?,
                end_ms: row.get("end_ms")?,
                created_at: row.get("created_at")?,
            })
        })?;

        let mut segments = Vec::new();
        for row in rows {
            segments.push(row?);
        }
        Ok(segments)
    }

    pub fn delete_session(&self, session_id: &str) -> Result<()> {
        // Clean up attachments (files + db records)
        self.delete_session_attachments(session_id)?;

        let conn = self.get_connection()?;

        // Clean up any legacy audio_recordings entries
        conn.execute(
            "DELETE FROM audio_recordings WHERE session_id = ?1",
            params![session_id],
        )?;
        conn.execute(
            "DELETE FROM meeting_notes WHERE session_id = ?1",
            params![session_id],
        )?;
        conn.execute(
            "DELETE FROM transcript_segments WHERE session_id = ?1",
            params![session_id],
        )?;
        conn.execute("DELETE FROM sessions WHERE id = ?1", params![session_id])?;

        self.delete_debug_recordings(session_id);

        let _ = self.app_handle.emit("session-deleted", session_id);
        info!("Session deleted: {}", session_id);
        Ok(())
    }

    /// Best-effort cleanup of the debug-recording directory for a session.
    /// Writes raw mic/spk WAVs and a metadata.json with transcript text when
    /// the `save_debug_recordings` debug flag is on; those files must be
    /// removed whenever the session's transcript is being cleared or the
    /// session is being deleted. Failures are logged, not propagated.
    fn delete_debug_recordings(&self, session_id: &str) {
        let data_dir = match crate::get_user_data_dir(&self.app_handle) {
            Ok(dir) => dir,
            Err(e) => {
                warn!(
                    "Skipping debug-recording cleanup for {}: data dir unresolved: {}",
                    session_id, e
                );
                return;
            }
        };
        let recordings_dir = data_dir.join("debug_recordings");
        if let Err(e) =
            crate::debug_recording::delete_session_recording(&recordings_dir, session_id)
        {
            warn!(
                "Failed to delete debug recordings for {}: {}",
                session_id, e
            );
        }
    }

    pub fn update_session_title(&self, session_id: &str, title: &str) -> Result<()> {
        let conn = self.get_connection()?;
        conn.execute(
            "UPDATE sessions SET title = ?1 WHERE id = ?2",
            params![title, session_id],
        )?;
        Ok(())
    }

    /// Clear the raw transcript for a session and seal the note. After this:
    /// - transcript_segments rows for this session are deleted
    /// - sessions.transcript_wiped_at is set to the current epoch second
    /// - recording on this session is locked (enforced at the command layer)
    ///
    /// Refuses if the session does not exist, is already sealed, or has no
    /// enhanced_notes yet (the whole point of the feature is that the enhanced
    /// notes replace the transcript as the record).
    pub fn clear_session_transcript(&self, session_id: &str) -> Result<Session> {
        let session = self
            .get_session(session_id)?
            .ok_or_else(|| anyhow::anyhow!("Session not found: {}", session_id))?;

        if session.transcript_wiped_at.is_some() {
            return Err(anyhow::anyhow!("Transcript is already cleared"));
        }

        let notes = self.get_meeting_notes(session_id)?;
        let has_enhanced = notes
            .as_ref()
            .and_then(|n| n.enhanced_notes.as_ref())
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
        if !has_enhanced {
            return Err(anyhow::anyhow!(
                "Cannot clear transcript before enhanced notes exist"
            ));
        }

        let now = Utc::now().timestamp();
        let conn = self.get_connection()?;
        conn.execute(
            "DELETE FROM transcript_segments WHERE session_id = ?1",
            params![session_id],
        )?;
        conn.execute(
            "UPDATE sessions SET transcript_wiped_at = ?1 WHERE id = ?2",
            params![now, session_id],
        )?;

        // Also remove debug-recording artifacts (raw audio + metadata.json
        // with transcript text), which otherwise survive the DB clear and
        // defeat the whole point of the feature when both flags are on.
        self.delete_debug_recordings(session_id);

        let updated = Session {
            transcript_wiped_at: Some(now),
            ..session
        };

        let _ = self.app_handle.emit("session-updated", &updated);
        info!("Transcript cleared for session: {}", session_id);

        Ok(updated)
    }

    /// Link a note to the calendar meeting it covers.
    ///
    /// The whole event is snapshotted as JSON rather than re-fetched on read.
    /// Calendar entries get edited after the fact, cancelled, or fall out of
    /// the local store when they age past what the provider syncs — and the
    /// attendee list is the input to speaker naming and to the people index,
    /// so it has to be durable independently of the calendar.
    pub fn link_session_to_calendar_event(
        &self,
        session_id: &str,
        event: &crate::managers::calendar::CalendarEvent,
    ) -> Result<()> {
        let snapshot = serde_json::to_string(event)?;
        let external_id = event
            .external_id
            .clone()
            .unwrap_or_else(|| event.id.clone());
        let conn = self.get_connection()?;
        conn.execute(
            "UPDATE sessions SET calendar_event_id = ?1, calendar_event_start = ?2, calendar_snapshot = ?3 WHERE id = ?4",
            params![external_id, event.start_ms, snapshot, session_id],
        )?;
        info!(
            "Linked session {} to calendar event starting {}",
            session_id, event.start_ms
        );
        if let Ok(Some(session)) = self.get_session(session_id) {
            let _ = self.app_handle.emit("session-updated", &session);
        }
        Ok(())
    }

    pub fn unlink_session_calendar_event(&self, session_id: &str) -> Result<()> {
        let conn = self.get_connection()?;
        conn.execute(
            "UPDATE sessions SET calendar_event_id = NULL, calendar_event_start = NULL, calendar_snapshot = NULL WHERE id = ?1",
            params![session_id],
        )?;
        if let Ok(Some(session)) = self.get_session(session_id) {
            let _ = self.app_handle.emit("session-updated", &session);
        }
        Ok(())
    }

    /// The snapshotted meeting for a note, if it is linked to one.
    pub fn get_session_calendar_event(
        &self,
        session_id: &str,
    ) -> Result<Option<crate::managers::calendar::CalendarEvent>> {
        let conn = self.get_connection()?;
        let snapshot: Option<String> = conn
            .query_row(
                "SELECT calendar_snapshot FROM sessions WHERE id = ?1",
                params![session_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();

        let Some(snapshot) = snapshot else {
            return Ok(None);
        };
        match serde_json::from_str(&snapshot) {
            Ok(event) => Ok(Some(event)),
            Err(e) => {
                // A snapshot written by an older shape shouldn't break the note.
                warn!(
                    "Discarding unreadable calendar snapshot for session {}: {}",
                    session_id, e
                );
                Ok(None)
            }
        }
    }

    /// The note already covering this meeting occurrence, if there is one.
    /// Guards against a second note being created for a meeting the user is
    /// already taking notes in.
    pub fn find_session_for_calendar_event(
        &self,
        external_id: &str,
        start_ms: i64,
    ) -> Result<Option<String>> {
        let conn = self.get_connection()?;
        Ok(conn
            .query_row(
                "SELECT id FROM sessions WHERE calendar_event_id = ?1 AND calendar_event_start = ?2 ORDER BY started_at DESC LIMIT 1",
                params![external_id, start_ms],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub fn update_session_environment(
        &self,
        session_id: &str,
        environment_id: Option<&str>,
    ) -> Result<()> {
        let conn = self.get_connection()?;
        conn.execute(
            "UPDATE sessions SET environment_id = ?1 WHERE id = ?2",
            params![environment_id, session_id],
        )?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn save_meeting_notes(
        &self,
        session_id: &str,
        summary: Option<String>,
        action_items: Option<String>,
        decisions: Option<String>,
        user_notes: Option<String>,
        enhanced_notes: Option<String>,
        enhanced_notes_edited: Option<bool>,
    ) -> Result<()> {
        let now = Utc::now().timestamp();
        let conn = self.get_connection()?;

        // Convert bool to i32 for SQLite
        let edited_int = enhanced_notes_edited.map(|b| if b { 1i32 } else { 0i32 });

        conn.execute(
            "INSERT INTO meeting_notes (session_id, summary, action_items, decisions, user_notes, enhanced_notes, enhanced_notes_edited, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, COALESCE(?7, 0), ?8, ?8)
             ON CONFLICT(session_id) DO UPDATE SET
                summary = COALESCE(?2, summary),
                action_items = COALESCE(?3, action_items),
                decisions = COALESCE(?4, decisions),
                user_notes = COALESCE(?5, user_notes),
                enhanced_notes = COALESCE(?6, enhanced_notes),
                enhanced_notes_edited = COALESCE(?7, enhanced_notes_edited),
                updated_at = ?8",
            params![session_id, summary, action_items, decisions, user_notes, enhanced_notes, edited_int, now],
        )?;

        Ok(())
    }

    pub fn get_meeting_notes(&self, session_id: &str) -> Result<Option<MeetingNotes>> {
        let conn = self.get_connection()?;
        let notes = conn
            .query_row(
                "SELECT id, session_id, summary, action_items, decisions, user_notes, enhanced_notes, enhanced_notes_edited, created_at, updated_at FROM meeting_notes WHERE session_id = ?1",
                params![session_id],
                |row| {
                    let edited_int: i32 = row.get("enhanced_notes_edited")?;
                    Ok(MeetingNotes {
                        id: row.get("id")?,
                        session_id: row.get("session_id")?,
                        summary: row.get("summary")?,
                        action_items: row.get("action_items")?,
                        decisions: row.get("decisions")?,
                        user_notes: row.get("user_notes")?,
                        enhanced_notes: row.get("enhanced_notes")?,
                        enhanced_notes_edited: edited_int != 0,
                        created_at: row.get("created_at")?,
                        updated_at: row.get("updated_at")?,
                    })
                },
            )
            .optional()?;
        Ok(notes)
    }

    /// Take accumulated speaker samples and clear the buffer
    pub fn take_speaker_samples(&self) -> Vec<f32> {
        std::mem::take(&mut *self.speaker_buffer.lock_or_recover())
    }

    /// Get a clone of the speaker buffer Arc for the capture task
    pub fn speaker_buffer_handle(&self) -> Arc<Mutex<Vec<f32>>> {
        self.speaker_buffer.clone()
    }

    /// Get the speaker shutdown signal
    pub fn speaker_shutdown_handle(&self) -> Arc<AtomicBool> {
        self.speaker_shutdown.clone()
    }

    /// Reset speaker state for a new session
    pub fn reset_speaker_state(&self) {
        // First, ensure any previous speaker thread is properly joined
        self.stop_speaker_capture();

        // Now reset state for new session
        self.speaker_shutdown.store(false, Ordering::Release);
        self.speaker_buffer.lock_or_recover().clear();
    }

    /// Store the speaker capture thread handle for later cleanup
    pub fn set_speaker_thread_handle(&self, handle: JoinHandle<()>) {
        *self.speaker_thread_handle.lock_or_recover() = Some(handle);
    }

    /// Signal the speaker capture task to stop and wait for thread to finish
    pub fn stop_speaker_capture(&self) {
        // Signal the thread to stop with Release ordering
        self.speaker_shutdown.store(true, Ordering::Release);

        // Wait for the thread to finish to prevent leaks and ensure
        // no writes to buffer after session is deleted
        if let Some(handle) = self.speaker_thread_handle.lock_or_recover().take() {
            if let Err(e) = handle.join() {
                warn!("Speaker capture thread panicked: {:?}", e);
            } else {
                debug!("Speaker capture thread joined successfully");
            }
        }
    }

    /// Get the time offset for a new recording pass by finding the max end_ms in existing segments.
    /// This is simpler than tracking in-memory state and survives app restarts.
    pub fn get_session_time_offset(&self, session_id: &str) -> i64 {
        let conn = match self.get_connection() {
            Ok(c) => c,
            Err(_) => return 0,
        };

        conn.query_row(
            "SELECT COALESCE(MAX(end_ms), 0) FROM transcript_segments WHERE session_id = ?1",
            params![session_id],
            |row| row.get(0),
        )
        .unwrap_or(0)
    }

    pub fn reactivate_session(&self, session_id: &str) -> Result<Session> {
        // End any currently active session
        self.end_session()?;

        // Reactivate the target session
        let conn = self.get_connection()?;
        conn.execute(
            "UPDATE sessions SET status = 'active', ended_at = NULL WHERE id = ?1",
            params![session_id],
        )?;

        *self.active_session.lock_or_recover() = Some(session_id.to_string());
        *self.session_start_time.lock_or_recover() = Some(std::time::Instant::now());

        let session = self
            .get_session(session_id)?
            .ok_or_else(|| anyhow::anyhow!("Session not found: {}", session_id))?;

        let _ = self.app_handle.emit("session-started", &session);
        info!("Session reactivated: {}", session_id);

        Ok(session)
    }

    // ==================== Folder CRUD ====================

    pub fn create_folder(&self, name: String, color: Option<String>) -> Result<Folder> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().timestamp();
        let conn = self.get_connection()?;

        // Get max sort_order
        let max_order: i32 = conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order), 0) FROM folders",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        conn.execute(
            "INSERT INTO folders (id, name, color, sort_order, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, name, color, max_order + 1, now],
        )?;

        Ok(Folder {
            id,
            name,
            color,
            sort_order: max_order + 1,
            created_at: now,
        })
    }

    pub fn update_folder(
        &self,
        folder_id: &str,
        name: String,
        color: Option<String>,
    ) -> Result<()> {
        let conn = self.get_connection()?;
        conn.execute(
            "UPDATE folders SET name = ?1, color = ?2 WHERE id = ?3",
            params![name, color, folder_id],
        )?;
        Ok(())
    }

    pub fn delete_folder(&self, folder_id: &str) -> Result<()> {
        let conn = self.get_connection()?;
        // Move sessions in this folder to unfiled (folder_id = NULL)
        conn.execute(
            "UPDATE sessions SET folder_id = NULL WHERE folder_id = ?1",
            params![folder_id],
        )?;
        conn.execute("DELETE FROM folders WHERE id = ?1", params![folder_id])?;
        Ok(())
    }

    pub fn get_folders(&self) -> Result<Vec<Folder>> {
        let conn = self.get_connection()?;
        let mut stmt = conn.prepare(
            "SELECT id, name, color, sort_order, created_at FROM folders ORDER BY sort_order ASC",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(Folder {
                id: row.get("id")?,
                name: row.get("name")?,
                color: row.get("color")?,
                sort_order: row.get("sort_order")?,
                created_at: row.get("created_at")?,
            })
        })?;

        let mut folders = Vec::new();
        for row in rows {
            folders.push(row?);
        }
        Ok(folders)
    }

    pub fn move_session_to_folder(
        &self,
        session_id: &str,
        folder_id: Option<String>,
    ) -> Result<()> {
        let conn = self.get_connection()?;
        conn.execute(
            "UPDATE sessions SET folder_id = ?1 WHERE id = ?2",
            params![folder_id, session_id],
        )?;
        Ok(())
    }

    pub fn get_sessions_by_folder(&self, folder_id: Option<String>) -> Result<Vec<Session>> {
        let conn = self.get_connection()?;

        let query = if folder_id.is_some() {
            "SELECT id, title, started_at, ended_at, status, folder_id, environment_id, calendar_event_id, transcript_wiped_at
             FROM sessions WHERE folder_id = ?1 ORDER BY started_at DESC"
        } else {
            "SELECT id, title, started_at, ended_at, status, folder_id, environment_id, calendar_event_id, transcript_wiped_at
             FROM sessions WHERE folder_id IS NULL ORDER BY started_at DESC"
        };

        let mut stmt = conn.prepare(query)?;
        let mut sessions = Vec::new();

        let map_row = |row: &rusqlite::Row| -> rusqlite::Result<Session> {
            Ok(Session {
                id: row.get("id")?,
                title: row.get("title")?,
                started_at: row.get("started_at")?,
                ended_at: row.get("ended_at")?,
                status: row.get("status")?,
                folder_id: row.get("folder_id")?,
                environment_id: row.get("environment_id")?,
                calendar_event_id: row.get("calendar_event_id")?,
                transcript_wiped_at: row.get("transcript_wiped_at")?,
            })
        };

        if let Some(fid) = &folder_id {
            let rows = stmt.query_map(params![fid], map_row)?;
            for row in rows {
                sessions.push(row?);
            }
        } else {
            let rows = stmt.query_map([], map_row)?;
            for row in rows {
                sessions.push(row?);
            }
        }

        Ok(sessions)
    }

    // ==================== Tag CRUD ====================

    pub fn create_tag(&self, name: String, color: Option<String>) -> Result<Tag> {
        let id = Uuid::new_v4().to_string();
        let conn = self.get_connection()?;

        conn.execute(
            "INSERT INTO tags (id, name, color) VALUES (?1, ?2, ?3)",
            params![id, name, color],
        )?;

        Ok(Tag { id, name, color })
    }

    pub fn update_tag(&self, tag_id: &str, name: String, color: Option<String>) -> Result<()> {
        let conn = self.get_connection()?;
        conn.execute(
            "UPDATE tags SET name = ?1, color = ?2 WHERE id = ?3",
            params![name, color, tag_id],
        )?;
        Ok(())
    }

    pub fn delete_tag(&self, tag_id: &str) -> Result<()> {
        let conn = self.get_connection()?;
        // session_tags will cascade delete
        conn.execute("DELETE FROM tags WHERE id = ?1", params![tag_id])?;
        Ok(())
    }

    pub fn get_tags(&self) -> Result<Vec<Tag>> {
        let conn = self.get_connection()?;
        // Only return tags that are used by at least one session
        let mut stmt = conn.prepare(
            "SELECT DISTINCT t.id, t.name, t.color FROM tags t
             INNER JOIN session_tags st ON t.id = st.tag_id
             ORDER BY t.name ASC",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(Tag {
                id: row.get("id")?,
                name: row.get("name")?,
                color: row.get("color")?,
            })
        })?;

        let mut tags = Vec::new();
        for row in rows {
            tags.push(row?);
        }
        Ok(tags)
    }

    pub fn add_tag_to_session(&self, session_id: &str, tag_id: &str) -> Result<()> {
        let conn = self.get_connection()?;
        conn.execute(
            "INSERT OR IGNORE INTO session_tags (session_id, tag_id) VALUES (?1, ?2)",
            params![session_id, tag_id],
        )?;
        Ok(())
    }

    pub fn remove_tag_from_session(&self, session_id: &str, tag_id: &str) -> Result<()> {
        let conn = self.get_connection()?;
        conn.execute(
            "DELETE FROM session_tags WHERE session_id = ?1 AND tag_id = ?2",
            params![session_id, tag_id],
        )?;
        Ok(())
    }

    pub fn get_session_tags(&self, session_id: &str) -> Result<Vec<Tag>> {
        let conn = self.get_connection()?;
        let mut stmt = conn.prepare(
            "SELECT t.id, t.name, t.color FROM tags t
             INNER JOIN session_tags st ON st.tag_id = t.id
             WHERE st.session_id = ?1
             ORDER BY t.name ASC",
        )?;

        let rows = stmt.query_map(params![session_id], |row| {
            Ok(Tag {
                id: row.get("id")?,
                name: row.get("name")?,
                color: row.get("color")?,
            })
        })?;

        let mut tags = Vec::new();
        for row in rows {
            tags.push(row?);
        }
        Ok(tags)
    }

    pub fn set_session_tags(&self, session_id: &str, tag_ids: Vec<String>) -> Result<()> {
        let conn = self.get_connection()?;
        // Remove existing tags
        conn.execute(
            "DELETE FROM session_tags WHERE session_id = ?1",
            params![session_id],
        )?;
        // Add new tags
        for tag_id in tag_ids {
            conn.execute(
                "INSERT INTO session_tags (session_id, tag_id) VALUES (?1, ?2)",
                params![session_id, tag_id],
            )?;
        }
        Ok(())
    }

    pub fn get_sessions_by_tag(&self, tag_id: &str) -> Result<Vec<Session>> {
        let conn = self.get_connection()?;
        let mut stmt = conn.prepare(
            "SELECT s.id, s.title, s.started_at, s.ended_at, s.status, s.folder_id, s.environment_id, s.calendar_event_id, s.transcript_wiped_at
             FROM sessions s
             INNER JOIN session_tags st ON st.session_id = s.id
             WHERE st.tag_id = ?1
             ORDER BY s.started_at DESC",
        )?;

        let rows = stmt.query_map(params![tag_id], |row| {
            Ok(Session {
                id: row.get("id")?,
                title: row.get("title")?,
                started_at: row.get("started_at")?,
                ended_at: row.get("ended_at")?,
                status: row.get("status")?,
                folder_id: row.get("folder_id")?,
                environment_id: row.get("environment_id")?,
                calendar_event_id: row.get("calendar_event_id")?,
                transcript_wiped_at: row.get("transcript_wiped_at")?,
            })
        })?;

        let mut sessions = Vec::new();
        for row in rows {
            sessions.push(row?);
        }
        Ok(sessions)
    }

    pub fn count_sessions_by_environment_id(&self, environment_id: &str) -> Result<i64> {
        let conn = self.get_connection()?;
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sessions WHERE environment_id = ?1",
            [environment_id],
            |row| row.get(0),
        )?;
        Ok(count)
    }

    // ==================== Attachment CRUD ====================

    /// Get the attachments directory for a session, creating it if needed
    fn get_attachments_dir(&self, session_id: &str) -> Result<PathBuf> {
        let app_data_dir = self.app_handle.path().app_data_dir()?;
        let attachments_dir = app_data_dir.join("attachments").join(session_id);
        if !attachments_dir.exists() {
            fs::create_dir_all(&attachments_dir)?;
        }
        Ok(attachments_dir)
    }

    /// Add an attachment to a session by copying the source file to app data
    pub fn add_attachment(
        &self,
        session_id: &str,
        source_path: &str,
        filename: &str,
        mime_type: &str,
    ) -> Result<Attachment> {
        let source = std::path::Path::new(source_path);
        if !source.exists() {
            return Err(anyhow::anyhow!(
                "Source file does not exist: {}",
                source_path
            ));
        }

        let metadata = fs::metadata(source)?;
        let file_size = metadata.len() as i64;

        // Generate unique ID and destination path
        let id = Uuid::new_v4().to_string();
        let attachments_dir = self.get_attachments_dir(session_id)?;
        let dest_filename = format!("{}_{}", id, filename);
        let dest_path = attachments_dir.join(&dest_filename);

        // Copy file to app data
        fs::copy(source, &dest_path)?;

        let now = Utc::now().timestamp();
        let file_path_str = dest_path.to_string_lossy().to_string();

        let conn = self.get_connection()?;
        conn.execute(
            "INSERT INTO session_attachments (id, session_id, filename, file_path, mime_type, file_size, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, session_id, filename, file_path_str, mime_type, file_size, now],
        )?;

        info!("Attachment added: {} -> {}", filename, id);

        Ok(Attachment {
            id,
            session_id: session_id.to_string(),
            filename: filename.to_string(),
            file_path: file_path_str,
            mime_type: mime_type.to_string(),
            file_size,
            extracted_text: None,
            created_at: now,
        })
    }

    /// Add an attachment to a session from raw bytes (e.g. clipboard paste)
    pub fn add_attachment_from_bytes(
        &self,
        session_id: &str,
        data: &[u8],
        filename: &str,
        mime_type: &str,
    ) -> Result<Attachment> {
        let file_size = data.len() as i64;
        const MAX_SIZE: i64 = 25 * 1024 * 1024; // 25 MB
        if file_size > MAX_SIZE {
            return Err(anyhow::anyhow!("File too large (max 25 MB)"));
        }

        let id = Uuid::new_v4().to_string();
        let attachments_dir = self.get_attachments_dir(session_id)?;
        let dest_filename = format!("{}_{}", id, filename);
        let dest_path = attachments_dir.join(&dest_filename);

        fs::write(&dest_path, data)?;

        let now = Utc::now().timestamp();
        let file_path_str = dest_path.to_string_lossy().to_string();

        let conn = self.get_connection()?;
        conn.execute(
            "INSERT INTO session_attachments (id, session_id, filename, file_path, mime_type, file_size, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, session_id, filename, file_path_str, mime_type, file_size, now],
        )?;

        info!("Attachment added from bytes: {} -> {}", filename, id);

        Ok(Attachment {
            id,
            session_id: session_id.to_string(),
            filename: filename.to_string(),
            file_path: file_path_str,
            mime_type: mime_type.to_string(),
            file_size,
            extracted_text: None,
            created_at: now,
        })
    }

    /// Get all attachments for a session
    pub fn get_attachments(&self, session_id: &str) -> Result<Vec<Attachment>> {
        let conn = self.get_connection()?;
        let mut stmt = conn.prepare(
            "SELECT id, session_id, filename, file_path, mime_type, file_size, extracted_text, created_at
             FROM session_attachments
             WHERE session_id = ?1
             ORDER BY created_at ASC",
        )?;

        let rows = stmt.query_map(params![session_id], |row| {
            Ok(Attachment {
                id: row.get("id")?,
                session_id: row.get("session_id")?,
                filename: row.get("filename")?,
                file_path: row.get("file_path")?,
                mime_type: row.get("mime_type")?,
                file_size: row.get("file_size")?,
                extracted_text: row.get("extracted_text")?,
                created_at: row.get("created_at")?,
            })
        })?;

        let mut attachments = Vec::new();
        for row in rows {
            attachments.push(row?);
        }
        Ok(attachments)
    }

    /// Get a single attachment by ID
    pub fn get_attachment(&self, attachment_id: &str) -> Result<Option<Attachment>> {
        let conn = self.get_connection()?;
        let attachment = conn
            .query_row(
                "SELECT id, session_id, filename, file_path, mime_type, file_size, extracted_text, created_at
                 FROM session_attachments WHERE id = ?1",
                params![attachment_id],
                |row| {
                    Ok(Attachment {
                        id: row.get("id")?,
                        session_id: row.get("session_id")?,
                        filename: row.get("filename")?,
                        file_path: row.get("file_path")?,
                        mime_type: row.get("mime_type")?,
                        file_size: row.get("file_size")?,
                        extracted_text: row.get("extracted_text")?,
                        created_at: row.get("created_at")?,
                    })
                },
            )
            .optional()?;
        Ok(attachment)
    }

    /// Delete an attachment by ID, also removing the file from disk
    pub fn delete_attachment(&self, attachment_id: &str) -> Result<()> {
        // Get attachment to find file path
        let attachment = self.get_attachment(attachment_id)?;
        if let Some(att) = attachment {
            // Delete file from disk
            let path = std::path::Path::new(&att.file_path);
            if path.exists() {
                if let Err(e) = fs::remove_file(path) {
                    warn!("Failed to delete attachment file {}: {}", att.file_path, e);
                }
            }
        }

        let conn = self.get_connection()?;
        conn.execute(
            "DELETE FROM session_attachments WHERE id = ?1",
            params![attachment_id],
        )?;

        info!("Attachment deleted: {}", attachment_id);
        Ok(())
    }

    /// Delete all attachments for a session (called when deleting a session)
    pub fn delete_session_attachments(&self, session_id: &str) -> Result<()> {
        // Get all attachments to delete their files
        let attachments = self.get_attachments(session_id)?;
        for att in attachments {
            let path = std::path::Path::new(&att.file_path);
            if path.exists() {
                if let Err(e) = fs::remove_file(path) {
                    warn!("Failed to delete attachment file {}: {}", att.file_path, e);
                }
            }
        }

        // Delete from database
        let conn = self.get_connection()?;
        conn.execute(
            "DELETE FROM session_attachments WHERE session_id = ?1",
            params![session_id],
        )?;

        // Try to remove the attachments directory for this session
        let attachments_dir = self
            .app_handle
            .path()
            .app_data_dir()
            .ok()
            .map(|d| d.join("attachments").join(session_id));
        if let Some(dir) = attachments_dir {
            if dir.exists() {
                let _ = fs::remove_dir(&dir); // Ignore error if not empty
            }
        }

        Ok(())
    }

    /// Update the extracted text for an attachment (used after PDF/OCR processing)
    pub fn update_attachment_extracted_text(
        &self,
        attachment_id: &str,
        extracted_text: Option<&str>,
    ) -> Result<()> {
        let conn = self.get_connection()?;
        conn.execute(
            "UPDATE session_attachments SET extracted_text = ?1 WHERE id = ?2",
            params![extracted_text, attachment_id],
        )?;
        Ok(())
    }
}

/// Strength of a match by which field it came from. Lower is stronger.
fn field_rank(field: &str) -> u8 {
    match field {
        "title" => 0,
        "user_notes" => 1,
        "enhanced_notes" => 2,
        "transcript" => 3,
        _ => 4,
    }
}

/// Turn what the user typed into an FTS5 query, or `None` when there is
/// nothing to search for.
///
/// User text goes nowhere near the FTS5 parser directly: `"`, `*`, `:`, `-`,
/// `NEAR` and `AND` are all operators there, so a search for `pricing - Q3`
/// would be a syntax error rather than a search. Each word becomes a quoted
/// phrase, which the parser treats as a literal, and the words are implicitly
/// ANDed.
///
/// The final token gets a prefix match so search-as-you-type finds "procure"
/// while the user is still typing "procurement".
fn to_fts_query(input: &str) -> Option<String> {
    let tokens: Vec<&str> = input
        .split(|c: char| !c.is_alphanumeric() && c != '\'')
        .filter(|t| !t.is_empty())
        .collect();

    if tokens.is_empty() {
        return None;
    }

    let last = tokens.len() - 1;
    let terms: Vec<String> = tokens
        .iter()
        .enumerate()
        .map(|(i, token)| {
            // A quote cannot survive inside a quoted phrase; it is also never
            // a meaningful part of a search term.
            let cleaned = token.replace('"', "");
            if i == last {
                format!("\"{}\"*", cleaned)
            } else {
                format!("\"{}\"", cleaned)
            }
        })
        .collect();

    Some(terms.join(" "))
}

#[cfg(test)]
mod search_index_tests {
    use super::*;

    /// A migrated in-memory database. Exercises the real migration list, so a
    /// syntax error in the trigger SQL fails here rather than on a user's disk.
    fn migrated_db() -> Connection {
        let mut conn = Connection::open_in_memory().expect("open in-memory db");
        Migrations::new(SESSION_MIGRATIONS.to_vec())
            .to_latest(&mut conn)
            .expect("run migrations");
        conn
    }

    fn indexed(conn: &Connection, session_id: &str, field: &str) -> Vec<String> {
        let mut stmt = conn
            .prepare("SELECT body FROM search_index WHERE session_id = ?1 AND field = ?2 ORDER BY ref_id")
            .unwrap();
        let rows = stmt
            .query_map(params![session_id, field], |r| r.get::<_, String>(0))
            .unwrap();
        rows.map(|r| r.unwrap()).collect()
    }

    fn new_session(conn: &Connection, id: &str, title: &str) {
        conn.execute(
            "INSERT INTO sessions (id, title, started_at, status) VALUES (?1, ?2, 0, 'active')",
            params![id, title],
        )
        .unwrap();
    }

    #[test]
    fn migrations_apply_cleanly() {
        let conn = migrated_db();
        let n: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'search_%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 8, "expected every search trigger to be created");
    }

    #[test]
    fn title_is_indexed_and_follows_renames() {
        let conn = migrated_db();
        new_session(&conn, "s1", "Procurement sync");
        assert_eq!(indexed(&conn, "s1", "title"), vec!["Procurement sync"]);

        conn.execute(
            "UPDATE sessions SET title = ?1 WHERE id = ?2",
            params!["Vendor shortlist", "s1"],
        )
        .unwrap();
        // Exactly one row: the rename must replace, not accumulate.
        assert_eq!(indexed(&conn, "s1", "title"), vec!["Vendor shortlist"]);
    }

    #[test]
    fn notes_are_indexed_through_the_coalescing_upsert() {
        let conn = migrated_db();
        new_session(&conn, "s1", "Sync");

        // The shape `save_meeting_notes` uses: insert, then upsert with
        // COALESCE so a null leaves the stored value alone.
        let upsert = "INSERT INTO meeting_notes (session_id, user_notes, enhanced_notes, created_at, updated_at)
             VALUES (?1, ?2, ?3, 0, 0)
             ON CONFLICT(session_id) DO UPDATE SET
                user_notes = COALESCE(?2, user_notes),
                enhanced_notes = COALESCE(?3, enhanced_notes)";

        conn.execute(
            upsert,
            params!["s1", "raw jottings", Option::<String>::None],
        )
        .unwrap();
        assert_eq!(indexed(&conn, "s1", "user_notes"), vec!["raw jottings"]);

        // Writing only enhanced_notes must leave user_notes indexed — this is
        // the case a Rust-side index would get wrong, since the caller passes
        // None and never learns the stored value.
        conn.execute(
            upsert,
            params!["s1", Option::<String>::None, "[ai] Vendor shortlist agreed"],
        )
        .unwrap();
        assert_eq!(indexed(&conn, "s1", "user_notes"), vec!["raw jottings"]);
        assert_eq!(
            indexed(&conn, "s1", "enhanced_notes"),
            vec!["Vendor shortlist agreed"],
            "[ai] and [noted] markers must be stripped before indexing"
        );
    }

    #[test]
    fn searching_for_ai_does_not_match_every_enhanced_note() {
        let conn = migrated_db();
        new_session(&conn, "s1", "Sync");
        conn.execute(
            "INSERT INTO meeting_notes (session_id, enhanced_notes, created_at, updated_at)
             VALUES ('s1', '[ai] Pricing was agreed [noted] and signed', 0, 0)",
            [],
        )
        .unwrap();
        let hits: i64 = conn
            .query_row(
                "SELECT count(*) FROM search_index WHERE search_index MATCH 'ai'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 0, "the [ai] marker leaked into the index");
    }

    #[test]
    fn transcript_segments_are_indexed_per_segment_and_cleared_together() {
        let conn = migrated_db();
        new_session(&conn, "s1", "Sync");
        for (i, text) in ["we should revisit pricing", "agreed on Q3"]
            .iter()
            .enumerate()
        {
            conn.execute(
                "INSERT INTO transcript_segments (session_id, text, source, start_ms, end_ms, created_at)
                 VALUES ('s1', ?1, 'mic', ?2, ?3, 0)",
                params![text, i as i64 * 1000, i as i64 * 1000 + 500],
            )
            .unwrap();
        }
        assert_eq!(indexed(&conn, "s1", "transcript").len(), 2);

        let hits: i64 = conn
            .query_row(
                "SELECT count(*) FROM search_index WHERE search_index MATCH 'pricing'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1, "transcripts must be searchable");

        conn.execute(
            "DELETE FROM transcript_segments WHERE session_id = 's1'",
            [],
        )
        .unwrap();
        assert!(indexed(&conn, "s1", "transcript").is_empty());
    }

    #[test]
    fn deleting_a_session_clears_its_whole_index() {
        let conn = migrated_db();
        new_session(&conn, "s1", "Procurement sync");
        conn.execute(
            "INSERT INTO transcript_segments (session_id, text, source, start_ms, end_ms, created_at)
             VALUES ('s1', 'hello there', 'mic', 0, 1, 0)",
            [],
        )
        .unwrap();
        // Same order as `delete_session`: children first, then the session.
        conn.execute(
            "DELETE FROM transcript_segments WHERE session_id = 's1'",
            [],
        )
        .unwrap();
        conn.execute("DELETE FROM sessions WHERE id = 's1'", [])
            .unwrap();

        let left: i64 = conn
            .query_row(
                "SELECT count(*) FROM search_index WHERE session_id = 's1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(left, 0);
    }
    // --- query sanitisation -------------------------------------------------

    #[test]
    fn fts_operators_in_user_input_are_neutralised() {
        // Every one of these is FTS5 syntax. Passed through raw they would be
        // a parse error or a query the user did not ask for.
        assert_eq!(
            to_fts_query("pricing - Q3").as_deref(),
            Some(r#""pricing" "Q3"*"#)
        );
        assert_eq!(to_fts_query("cost:").as_deref(), Some(r#""cost"*"#));
        assert_eq!(
            to_fts_query(r#"say "hello""#).as_deref(),
            Some(r#""say" "hello"*"#)
        );
        assert_eq!(
            to_fts_query("a NEAR b").as_deref(),
            Some(r#""a" "NEAR" "b"*"#)
        );
        assert_eq!(to_fts_query("*").as_deref(), None);
        assert_eq!(to_fts_query("   ").as_deref(), None);
    }

    #[test]
    fn a_query_full_of_operators_runs_without_erroring() {
        let conn = migrated_db();
        new_session(&conn, "s1", "Budget review");
        for q in ["\"", "* AND", "NEAR(a b)", "-x", "^foo", "a:b:c", "()"] {
            run_search(&conn, q, &SearchFilters::default())
                .unwrap_or_else(|e| panic!("query {:?} failed: {}", q, e));
        }
    }

    // --- searching ----------------------------------------------------------

    fn add_segment(conn: &Connection, session_id: &str, text: &str, start_ms: i64) {
        conn.execute(
            "INSERT INTO transcript_segments (session_id, text, source, start_ms, end_ms, created_at)
             VALUES (?1, ?2, 'mic', ?3, ?4, 0)",
            params![session_id, text, start_ms, start_ms + 500],
        )
        .unwrap();
    }

    #[test]
    fn transcripts_are_searchable() {
        let conn = migrated_db();
        new_session(&conn, "s1", "Budget review");
        add_segment(&conn, "s1", "we should revisit the vendor shortlist", 0);

        let hits = run_search(&conn, "shortlist", &SearchFilters::default()).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].matched_field, "transcript");
        assert!(
            hits[0].snippet.contains("shortlist"),
            "snippet was {:?}",
            hits[0].snippet
        );
    }

    #[test]
    fn matching_stops_at_word_boundaries() {
        let conn = migrated_db();
        new_session(&conn, "s1", "Sync");
        add_segment(&conn, "s1", "we walked the path together with everyone", 0);

        // The old LIKE query matched any substring, so "ath" lit up "path".
        // FTS5 tokenises, so a fragment that only ever appears mid-word finds
        // nothing.
        assert!(
            run_search(&conn, "ath", &SearchFilters::default())
                .unwrap()
                .is_empty(),
            "a mid-word fragment must not match"
        );
        assert!(run_search(&conn, "ogether", &SearchFilters::default())
            .unwrap()
            .is_empty());

        // Prefixes still match, because they start a word. This is the point
        // of the trailing `*`, and is a different thing from substring search:
        // "th" finds "the" and "together" but never "path" or "with".
        assert_eq!(
            run_search(&conn, "th", &SearchFilters::default())
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            run_search(&conn, "path", &SearchFilters::default())
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn prefix_matching_works_while_still_typing() {
        let conn = migrated_db();
        new_session(&conn, "s1", "Procurement sync");
        assert_eq!(
            run_search(&conn, "procure", &SearchFilters::default())
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn a_session_matching_twice_yields_one_hit_from_its_strongest_field() {
        let conn = migrated_db();
        new_session(&conn, "s1", "Pricing review");
        add_segment(&conn, "s1", "pricing came up again", 0);
        add_segment(&conn, "s1", "and pricing once more", 1000);

        let hits = run_search(&conn, "pricing", &SearchFilters::default()).unwrap();
        assert_eq!(hits.len(), 1, "one hit per session");
        assert_eq!(hits[0].matched_field, "title");
        assert_eq!(hits[0].snippet, "", "a title match needs no snippet");
    }

    #[test]
    fn all_terms_must_match() {
        let conn = migrated_db();
        new_session(&conn, "s1", "Budget review");
        add_segment(&conn, "s1", "vendor shortlist agreed", 0);

        assert_eq!(
            run_search(&conn, "vendor shortlist", &SearchFilters::default())
                .unwrap()
                .len(),
            1
        );
        assert!(
            run_search(&conn, "vendor pricing", &SearchFilters::default())
                .unwrap()
                .is_empty(),
            "terms are ANDed, not ORed"
        );
    }

    #[test]
    fn filters_apply_with_and_without_a_query() {
        let conn = migrated_db();
        conn.execute(
            "INSERT INTO folders (id, name, sort_order, created_at) VALUES ('f1', 'Work', 0, 0)",
            [],
        )
        .unwrap();
        new_session(&conn, "s1", "Budget review");
        new_session(&conn, "s2", "Budget planning");
        conn.execute("UPDATE sessions SET folder_id = 'f1' WHERE id = 's1'", [])
            .unwrap();

        let in_folder = SearchFilters {
            folder_id: Some("f1".to_string()),
            ..Default::default()
        };

        // Filters alone still list notes, as they did before FTS.
        let hits = run_search(&conn, "", &in_folder).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].session.id, "s1");

        // And they narrow a text query.
        let hits = run_search(&conn, "budget", &SearchFilters::default()).unwrap();
        assert_eq!(hits.len(), 2);
        let hits = run_search(&conn, "budget", &in_folder).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].session.id, "s1");
    }

    #[test]
    fn results_stay_in_reverse_chronological_order() {
        let conn = migrated_db();
        for (id, started) in [("old", 100), ("new", 300), ("mid", 200)] {
            conn.execute(
                "INSERT INTO sessions (id, title, started_at, status) VALUES (?1, 'Budget review', ?2, 'active')",
                params![id, started],
            )
            .unwrap();
        }
        let hits = run_search(&conn, "budget", &SearchFilters::default()).unwrap();
        let ids: Vec<&str> = hits.iter().map(|h| h.session.id.as_str()).collect();
        assert_eq!(ids, vec!["new", "mid", "old"]);
    }
    /// Migrate a copy of a real database and search it.
    ///
    /// Ignored: it needs a real corpus. Point `TALKY_TEST_DB` at a *copy* of
    /// sessions.db — the migration writes to it. Prints counts only, never
    /// note content.
    #[test]
    #[ignore = "requires TALKY_TEST_DB pointing at a copy of a real database"]
    fn backfills_a_real_database() {
        let path = std::env::var("TALKY_TEST_DB").expect("set TALKY_TEST_DB");
        let mut conn = Connection::open(&path).expect("open db copy");

        let sessions: i64 = conn
            .query_row("SELECT count(*) FROM sessions", [], |r| r.get(0))
            .unwrap();
        let segments: i64 = conn
            .query_row("SELECT count(*) FROM transcript_segments", [], |r| r.get(0))
            .unwrap();

        Migrations::new(SESSION_MIGRATIONS.to_vec())
            .to_latest(&mut conn)
            .expect("migrate real database");

        let mut stmt = conn
            .prepare("SELECT field, count(*) FROM search_index GROUP BY field ORDER BY field")
            .unwrap();
        let rows: Vec<(String, i64)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        drop(stmt);

        println!("{} sessions, {} segments", sessions, segments);
        for (field, n) in &rows {
            println!("  indexed {}: {}", field, n);
        }

        let transcript_rows = rows
            .iter()
            .find(|(f, _)| f == "transcript")
            .map(|(_, n)| *n)
            .unwrap_or(0);
        assert_eq!(
            transcript_rows, segments,
            "every transcript segment should have been backfilled"
        );

        let titles = rows
            .iter()
            .find(|(f, _)| f == "title")
            .map(|(_, n)| *n)
            .unwrap_or(0);
        assert!(titles > 0, "no titles were indexed");

        // The index has to survive a real query, not just exist.
        let hits = run_search(&conn, "the", &SearchFilters::default()).unwrap();
        println!("search for a common word returned {} notes", hits.len());
        assert!(!hits.is_empty(), "a common word matched nothing");
    }
}
