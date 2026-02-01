import { useEffect, useState, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { StickyNote } from "lucide-react";
import { NotesSidebar } from "../NotesSidebar";
import { NoteView } from "./NoteView";

interface Session {
  id: string;
  title: string;
  started_at: number;
  ended_at: number | null;
  status: string;
}

interface TranscriptSegment {
  id: number;
  session_id: string;
  text: string;
  source: string;
  start_ms: number;
  end_ms: number;
  created_at: number;
}

interface AmplitudeEvent {
  session_id: string;
  mic: number;
  speaker: number;
}

interface SessionsViewProps {
  onOpenSettings: () => void;
}

function EmptyState({ onNewNote }: { onNewNote: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center h-full text-text-secondary gap-4">
      <StickyNote size={40} strokeWidth={1} className="opacity-25" />
      <p className="text-sm">{t("notes.emptyState")}</p>
      <button
        onClick={onNewNote}
        data-ui
        className="text-sm px-4 py-2 bg-accent-soft rounded-lg hover:bg-accent/10 transition-colors text-accent border border-border"
      >
        {t("sessions.newNote")}
      </button>
    </div>
  );
}

export function SessionsView({ onOpenSettings }: SessionsViewProps) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [recordingSessionId, setRecordingSessionId] = useState<string | null>(
    null,
  );
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null,
  );
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([]);
  const [amplitude, setAmplitude] = useState<{
    mic: number;
    speaker: number;
  }>({ mic: 0, speaker: 0 });
  const [userNotes, setUserNotes] = useState("");
  const [notesLoaded, setNotesLoaded] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [enhancedNotes, setEnhancedNotes] = useState<string | null>(null);
  const [enhanceLoading, setEnhanceLoading] = useState(false);
  const [enhanceError, setEnhanceError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"notes" | "enhanced">("notes");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef<{ sessionId: string; notes: string } | null>(null);

  const loadSessions = useCallback(async () => {
    try {
      const result = await invoke<Session[]>("get_sessions");
      setSessions(result);
    } catch (e) {
      console.error("Failed to load sessions:", e);
    }
  }, []);

  const loadTranscript = useCallback(async (sessionId: string) => {
    try {
      const result = await invoke<TranscriptSegment[]>(
        "get_session_transcript",
        { sessionId },
      );
      setTranscript(result);
    } catch (e) {
      console.error("Failed to load transcript:", e);
    }
  }, []);

  const loadUserNotes = useCallback(async (sessionId: string) => {
    try {
      const result = await invoke<string | null>("get_user_notes", {
        sessionId,
      });
      setUserNotes(result ?? "");
      setNotesLoaded(true);
    } catch (e) {
      console.error("Failed to load user notes:", e);
      setUserNotes("");
      setNotesLoaded(true);
    }
  }, []);

  const loadSummary = useCallback(async (sessionId: string) => {
    try {
      const result = await invoke<string | null>("get_session_summary", {
        sessionId,
      });
      setSummary(result);
      setSummaryError(null);
    } catch (e) {
      console.error("Failed to load summary:", e);
      setSummary(null);
    }
  }, []);

  const generateSummary = useCallback(async (sessionId: string) => {
    setSummaryLoading(true);
    setSummaryError(null);
    try {
      const result = await invoke<string>("generate_session_summary", {
        sessionId,
      });
      setSummary(result);
    } catch (e) {
      console.error("Failed to generate summary:", e);
      setSummaryError(String(e));
    } finally {
      setSummaryLoading(false);
    }
  }, []);

  const loadEnhancedNotes = useCallback(async (sessionId: string) => {
    try {
      const result = await invoke<{
        enhanced_notes: string | null;
      } | null>("get_meeting_notes", { sessionId });
      const notes = result?.enhanced_notes ?? null;
      setEnhancedNotes(notes);
      if (notes) setViewMode("enhanced");
      else setViewMode("notes");
    } catch (e) {
      console.error("Failed to load enhanced notes:", e);
      setEnhancedNotes(null);
      setViewMode("notes");
    }
  }, []);

  const enhanceNotes = useCallback(async (sessionId: string) => {
    setEnhanceLoading(true);
    setEnhanceError(null);
    try {
      const result = await invoke<string>("generate_session_summary", {
        sessionId,
      });
      console.log("[enhanceNotes] raw model response:\n", result);
      setEnhancedNotes(result);
      setViewMode("enhanced");
    } catch (e) {
      console.error("Failed to enhance notes:", e);
      setEnhanceError(String(e));
    } finally {
      setEnhanceLoading(false);
    }
  }, []);

  const saveUserNotes = useCallback(
    async (sessionId: string, notes: string) => {
      try {
        await invoke("save_user_notes", { sessionId, notes });
      } catch (e) {
        console.error("Failed to save user notes:", e);
      }
    },
    [],
  );

  const handleNotesChange = useCallback(
    (newNotes: string) => {
      setUserNotes(newNotes);

      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
      if (selectedSessionId) {
        pendingSaveRef.current = { sessionId: selectedSessionId, notes: newNotes };
        saveTimerRef.current = setTimeout(() => {
          saveUserNotes(selectedSessionId, newNotes);
          pendingSaveRef.current = null;
        }, 500);
      }
    },
    [selectedSessionId, saveUserNotes],
  );

  // Initial load
  useEffect(() => {
    loadSessions();
    // Check if there's already an active/recording session
    (async () => {
      try {
        const active = await invoke<Session | null>("get_active_session");
        if (active) {
          setSelectedSessionId(active.id);
          const recording = await invoke<boolean>("is_recording");
          if (recording) {
            setRecordingSessionId(active.id);
            setIsRecording(true);
          }
        }
      } catch (e) {
        console.error("Failed to load active session:", e);
      }
    })();
  }, [loadSessions]);

  useEffect(() => {
    if (selectedSessionId) {
      // Reset state immediately so there's no stale content while loading
      setNotesLoaded(false);
      setTranscript([]);
      setSummary(null);
      setSummaryError(null);
      setEnhancedNotes(null);
      setEnhanceError(null);
      setViewMode("enhanced");

      loadTranscript(selectedSessionId);
      loadUserNotes(selectedSessionId);
      loadSummary(selectedSessionId);
      loadEnhancedNotes(selectedSessionId);
    }
  }, [selectedSessionId, loadTranscript, loadUserNotes, loadSummary, loadEnhancedNotes]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (pendingSaveRef.current) {
        saveUserNotes(pendingSaveRef.current.sessionId, pendingSaveRef.current.notes);
        pendingSaveRef.current = null;
      }
    };
  }, [selectedSessionId, saveUserNotes]);

  useEffect(() => {
    const unlisten = listen<{ session_id: string; segment: TranscriptSegment }>(
      "transcript-segment",
      (event) => {
        if (event.payload.session_id === selectedSessionId) {
          setTranscript((prev) => [...prev, event.payload.segment]);
        }
      },
    );

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [selectedSessionId]);

  useEffect(() => {
    const unlistenStart = listen<Session>("session-started", (event) => {
      setRecordingSessionId(event.payload.id);
      setSelectedSessionId(event.payload.id);
      loadSessions();
    });

    const unlistenEnd = listen<Session>("session-ended", () => {
      setRecordingSessionId(null);
      setIsRecording(false);
      setAmplitude({ mic: 0, speaker: 0 });
      loadSessions();
    });

    return () => {
      unlistenStart.then((fn) => fn());
      unlistenEnd.then((fn) => fn());
    };
  }, [loadSessions]);

  useEffect(() => {
    const unlisten = listen<AmplitudeEvent>(
      "session-amplitude",
      (event) => {
        if (event.payload.session_id === recordingSessionId) {
          setAmplitude({
            mic: event.payload.mic,
            speaker: event.payload.speaker,
          });
        }
      },
    );

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [recordingSessionId]);

  const handleNewNote = async () => {
    try {
      // If currently recording, stop first
      if (isRecording && recordingSessionId) {
        await invoke("stop_session_recording", { sessionId: recordingSessionId });
        setIsRecording(false);
        setRecordingSessionId(null);
        setAmplitude({ mic: 0, speaker: 0 });
      }

      const result = await invoke<Session>("start_session", { title: null });
      setRecordingSessionId(result.id);
      setSelectedSessionId(result.id);
      setTranscript([]);
      setUserNotes("");
      setNotesLoaded(true);
      setSummary(null);
      setSummaryError(null);
      setEnhancedNotes(null);
      setEnhanceError(null);
      setIsRecording(false);
      loadSessions();

      // Auto-start recording
      try {
        await invoke("start_session_recording", { sessionId: result.id });
        setIsRecording(true);
      } catch (e) {
        console.error("Failed to auto-start recording:", e);
      }
    } catch (e) {
      console.error("Failed to create note:", e);
    }
  };

  const handleStartRecording = async (sessionId: string) => {
    try {
      // Reactivate session if it's not the current active one
      await invoke<Session>("reactivate_session", { sessionId });
      await invoke("start_session_recording", { sessionId });
      setRecordingSessionId(sessionId);
      setIsRecording(true);
    } catch (e) {
      console.error("Failed to start recording:", e);
    }
  };

  const handleStopRecording = async () => {
    if (!recordingSessionId) return;
    try {
      await invoke("stop_session_recording", {
        sessionId: recordingSessionId,
      });
      setIsRecording(false);
      setAmplitude({ mic: 0, speaker: 0 });
    } catch (e) {
      console.error("Failed to stop recording:", e);
    }
  };

  const handleEnhancedNotesChange = useCallback(
    (tagged: string) => {
      if (!selectedSessionId) return;
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = setTimeout(async () => {
        try {
          await invoke("save_enhanced_notes", {
            sessionId: selectedSessionId,
            notes: tagged,
          });
        } catch (e) {
          console.error("Failed to save enhanced notes:", e);
        }
      }, 500);
    },
    [selectedSessionId],
  );

  const handleTitleChange = async (title: string) => {
    if (!selectedSessionId) return;
    try {
      await invoke("update_session_title", {
        sessionId: selectedSessionId,
        title,
      });
      loadSessions();
    } catch (e) {
      console.error("Failed to update title:", e);
    }
  };

  const handleDeleteSession = async (sessionId: string) => {
    try {
      // If deleting the recording session, stop recording first
      if (sessionId === recordingSessionId && isRecording) {
        await invoke("stop_session_recording", { sessionId });
        setIsRecording(false);
        setRecordingSessionId(null);
        setAmplitude({ mic: 0, speaker: 0 });
      }
      await invoke("delete_session", { sessionId });
      if (selectedSessionId === sessionId) {
        setSelectedSessionId(null);
        setTranscript([]);
        setUserNotes("");
      }
      loadSessions();
    } catch (e) {
      console.error("Failed to delete note:", e);
    }
  };

  const isSelectedRecording = isRecording && recordingSessionId === selectedSessionId;

  return (
    <div className="flex h-full">
      <NotesSidebar
        sessions={sessions}
        selectedId={selectedSessionId}
        recordingSessionId={isRecording ? recordingSessionId : null}
        onSelect={setSelectedSessionId}
        onNewNote={handleNewNote}
        onDelete={handleDeleteSession}
        onOpenSettings={onOpenSettings}
      />
      <div className="flex-1 overflow-hidden">
        {selectedSessionId ? (
          <NoteView
            session={
              sessions.find((s) => s.id === selectedSessionId) ?? null
            }
            isRecording={isSelectedRecording}
            amplitude={amplitude}
            transcript={transcript}
            userNotes={userNotes}
            notesLoaded={notesLoaded}
            summary={summary}
            summaryLoading={summaryLoading}
            summaryError={summaryError}
            onNotesChange={handleNotesChange}
            onEnhancedNotesChange={handleEnhancedNotesChange}
            onTitleChange={handleTitleChange}
            onStartRecording={() => handleStartRecording(selectedSessionId)}
            onStopRecording={handleStopRecording}
            onGenerateSummary={() => generateSummary(selectedSessionId)}
            enhancedNotes={enhancedNotes}
            onEnhanceNotes={() => enhanceNotes(selectedSessionId)}
            enhanceLoading={enhanceLoading}
            enhanceError={enhanceError}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
          />
        ) : (
          <EmptyState onNewNote={handleNewNote} />
        )}
      </div>
    </div>
  );
}
