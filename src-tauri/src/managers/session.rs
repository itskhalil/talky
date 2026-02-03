use anyhow::Result;
use chrono::Utc;
use log::{debug, info};
use rusqlite::{params, Connection, OptionalExtension};
use rusqlite_migration::{Migrations, M};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
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
];

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct Session {
    pub id: String,
    pub title: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub status: String,
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
    pub created_at: i64,
    pub updated_at: i64,
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
    speaker_shutdown: Arc<std::sync::atomic::AtomicBool>,
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
            speaker_shutdown: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        };

        manager.init_database()?;

        Ok(manager)
    }

    fn init_database(&self) -> Result<()> {
        let mut conn = Connection::open(&self.db_path)?;
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

    pub fn start_session(&self, title: Option<String>) -> Result<Session> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().timestamp();
        let title = title.unwrap_or_else(|| "New Note".to_string());

        let conn = self.get_connection()?;
        conn.execute(
            "INSERT INTO sessions (id, title, started_at, status) VALUES (?1, ?2, ?3, 'active')",
            params![id, title, now],
        )?;

        *self.active_session.lock().unwrap() = Some(id.clone());
        *self.session_start_time.lock().unwrap() = Some(std::time::Instant::now());

        let session = Session {
            id,
            title,
            started_at: now,
            ended_at: None,
            status: "active".to_string(),
        };

        let _ = self.app_handle.emit("session-started", &session);
        info!("Session started: {}", session.id);

        Ok(session)
    }

    pub fn end_session(&self) -> Result<Option<Session>> {
        let session_id = {
            let mut active = self.active_session.lock().unwrap();
            active.take()
        };

        let Some(session_id) = session_id else {
            return Ok(None);
        };

        *self.session_start_time.lock().unwrap() = None;

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
        self.active_session.lock().unwrap().clone()
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

    pub fn search_sessions(&self, query: &str) -> Result<Vec<Session>> {
        let conn = self.get_connection()?;
        let pattern = format!("%{}%", query);
        let mut stmt = conn.prepare(
            "SELECT DISTINCT s.id, s.title, s.started_at, s.ended_at, s.status
             FROM sessions s
             LEFT JOIN meeting_notes mn ON mn.session_id = s.id
             WHERE s.title LIKE ?1
                OR mn.user_notes LIKE ?1
                OR mn.enhanced_notes LIKE ?1
             ORDER BY s.started_at DESC",
        )?;

        let rows = stmt.query_map(params![pattern], |row| {
            Ok(Session {
                id: row.get("id")?,
                title: row.get("title")?,
                started_at: row.get("started_at")?,
                ended_at: row.get("ended_at")?,
                status: row.get("status")?,
            })
        })?;

        let mut sessions = Vec::new();
        for row in rows {
            sessions.push(row?);
        }
        Ok(sessions)
    }

    pub fn get_sessions(&self) -> Result<Vec<Session>> {
        let conn = self.get_connection()?;
        let mut stmt = conn.prepare(
            "SELECT id, title, started_at, ended_at, status FROM sessions ORDER BY started_at DESC",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(Session {
                id: row.get("id")?,
                title: row.get("title")?,
                started_at: row.get("started_at")?,
                ended_at: row.get("ended_at")?,
                status: row.get("status")?,
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
                "SELECT id, title, started_at, ended_at, status FROM sessions WHERE id = ?1",
                params![session_id],
                |row| {
                    Ok(Session {
                        id: row.get("id")?,
                        title: row.get("title")?,
                        started_at: row.get("started_at")?,
                        ended_at: row.get("ended_at")?,
                        status: row.get("status")?,
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

        let _ = self.app_handle.emit("session-deleted", session_id);
        info!("Session deleted: {}", session_id);
        Ok(())
    }

    pub fn update_session_title(&self, session_id: &str, title: &str) -> Result<()> {
        let conn = self.get_connection()?;
        conn.execute(
            "UPDATE sessions SET title = ?1 WHERE id = ?2",
            params![title, session_id],
        )?;
        Ok(())
    }

    pub fn save_meeting_notes(
        &self,
        session_id: &str,
        summary: Option<String>,
        action_items: Option<String>,
        decisions: Option<String>,
        user_notes: Option<String>,
        enhanced_notes: Option<String>,
    ) -> Result<()> {
        let now = Utc::now().timestamp();
        let conn = self.get_connection()?;

        conn.execute(
            "INSERT INTO meeting_notes (session_id, summary, action_items, decisions, user_notes, enhanced_notes, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
             ON CONFLICT(session_id) DO UPDATE SET
                summary = COALESCE(?2, summary),
                action_items = COALESCE(?3, action_items),
                decisions = COALESCE(?4, decisions),
                user_notes = COALESCE(?5, user_notes),
                enhanced_notes = COALESCE(?6, enhanced_notes),
                updated_at = ?7",
            params![session_id, summary, action_items, decisions, user_notes, enhanced_notes, now],
        )?;

        Ok(())
    }

    pub fn get_meeting_notes(&self, session_id: &str) -> Result<Option<MeetingNotes>> {
        let conn = self.get_connection()?;
        let notes = conn
            .query_row(
                "SELECT id, session_id, summary, action_items, decisions, user_notes, enhanced_notes, created_at, updated_at FROM meeting_notes WHERE session_id = ?1",
                params![session_id],
                |row| {
                    Ok(MeetingNotes {
                        id: row.get("id")?,
                        session_id: row.get("session_id")?,
                        summary: row.get("summary")?,
                        action_items: row.get("action_items")?,
                        decisions: row.get("decisions")?,
                        user_notes: row.get("user_notes")?,
                        enhanced_notes: row.get("enhanced_notes")?,
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
        std::mem::take(&mut *self.speaker_buffer.lock().unwrap())
    }

    /// Get a clone of the speaker buffer Arc for the capture task
    pub fn speaker_buffer_handle(&self) -> Arc<Mutex<Vec<f32>>> {
        self.speaker_buffer.clone()
    }

    /// Get the speaker shutdown signal
    pub fn speaker_shutdown_handle(&self) -> Arc<std::sync::atomic::AtomicBool> {
        self.speaker_shutdown.clone()
    }

    /// Reset speaker state for a new session
    pub fn reset_speaker_state(&self) {
        self.speaker_shutdown
            .store(false, std::sync::atomic::Ordering::Relaxed);
        self.speaker_buffer.lock().unwrap().clear();
    }

    /// Signal the speaker capture task to stop
    pub fn stop_speaker_capture(&self) {
        self.speaker_shutdown
            .store(true, std::sync::atomic::Ordering::Relaxed);
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

        *self.active_session.lock().unwrap() = Some(session_id.to_string());
        *self.session_start_time.lock().unwrap() = Some(std::time::Instant::now());

        let session = self
            .get_session(session_id)?
            .ok_or_else(|| anyhow::anyhow!("Session not found: {}", session_id))?;

        let _ = self.app_handle.emit("session-started", &session);
        info!("Session reactivated: {}", session_id);

        Ok(session)
    }
}
