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

type DetailTab = "notes" | "transcript" | "summary";

interface SessionsViewProps {
  onOpenSettings: () => void;
}

function EmptyState({ onNewNote }: { onNewNote: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center h-full text-mid-gray gap-4">
      <StickyNote size={48} className="opacity-30" />
      <p className="text-sm">{t("notes.emptyState")}</p>
      <button
        onClick={onNewNote}
        className="text-sm px-4 py-2 bg-logo-primary/80 rounded-lg hover:bg-logo-primary transition-colors text-foreground"
      >
        {t("sessions.newNote")}
      </button>
    </div>
  );
}

export function SessionsView({ onOpenSettings }: SessionsViewProps) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
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
  const [activeTab, setActiveTab] = useState<DetailTab>("notes");
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadSessions = useCallback(async () => {
    try {
      const result = await invoke<Session[]>("get_sessions");
      setSessions(result);
    } catch (e) {
      console.error("Failed to load sessions:", e);
    }
  }, []);

  const loadActiveSession = useCallback(async () => {
    try {
      const result = await invoke<Session | null>("get_active_session");
      setActiveSession(result);
      if (result) {
        setSelectedSessionId(result.id);
      }
    } catch (e) {
      console.error("Failed to load active session:", e);
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
        saveTimerRef.current = setTimeout(() => {
          saveUserNotes(selectedSessionId, newNotes);
        }, 500);
      }
    },
    [selectedSessionId, saveUserNotes],
  );

  useEffect(() => {
    loadSessions();
    loadActiveSession();
  }, [loadSessions, loadActiveSession]);

  useEffect(() => {
    if (selectedSessionId) {
      loadTranscript(selectedSessionId);
      setNotesLoaded(false);
      loadUserNotes(selectedSessionId);
      loadSummary(selectedSessionId);
    }
  }, [selectedSessionId, loadTranscript, loadUserNotes, loadSummary]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, [selectedSessionId]);

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
      setActiveSession(event.payload);
      setSelectedSessionId(event.payload.id);
      loadSessions();
    });

    const unlistenEnd = listen<Session>("session-ended", () => {
      setActiveSession(null);
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
        if (event.payload.session_id === activeSession?.id) {
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
  }, [activeSession?.id]);

  // Check recording state on mount / when active session changes
  useEffect(() => {
    const checkRecording = async () => {
      try {
        const recording = await invoke<boolean>("is_recording");
        setIsRecording(recording && activeSession != null);
      } catch {
        setIsRecording(false);
      }
    };
    checkRecording();
  }, [activeSession]);

  const handleNewNote = async () => {
    try {
      const result = await invoke<Session>("start_session", { title: null });
      setActiveSession(result);
      setSelectedSessionId(result.id);
      setTranscript([]);
      setUserNotes("");
      setNotesLoaded(true);
      setSummary(null);
      setSummaryError(null);
      setActiveTab("notes");
      setIsRecording(false);
      loadSessions();
    } catch (e) {
      console.error("Failed to create note:", e);
    }
  };

  const handleEndNote = async () => {
    try {
      // Stop recording first if active
      if (isRecording && selectedSessionId) {
        await invoke("stop_session_recording", {
          sessionId: selectedSessionId,
        });
        setIsRecording(false);
        setAmplitude({ mic: 0, speaker: 0 });
      }

      // Flush any pending notes save
      if (saveTimerRef.current && selectedSessionId) {
        clearTimeout(saveTimerRef.current);
        await saveUserNotes(selectedSessionId, userNotes);
      }
      const endedSessionId = selectedSessionId;
      await invoke("end_session");
      setActiveSession(null);
      setIsRecording(false);
      setAmplitude({ mic: 0, speaker: 0 });
      loadSessions();

      // Auto-generate summary
      if (endedSessionId) {
        setActiveTab("summary");
        generateSummary(endedSessionId);
      }
    } catch (e) {
      console.error("Failed to end note:", e);
    }
  };

  const handleStartRecording = async () => {
    if (!selectedSessionId) return;
    try {
      await invoke("start_session_recording", {
        sessionId: selectedSessionId,
      });
      setIsRecording(true);
    } catch (e) {
      console.error("Failed to start recording:", e);
    }
  };

  const handleStopRecording = async () => {
    if (!selectedSessionId) return;
    try {
      await invoke("stop_session_recording", {
        sessionId: selectedSessionId,
      });
      setIsRecording(false);
      setAmplitude({ mic: 0, speaker: 0 });
    } catch (e) {
      console.error("Failed to stop recording:", e);
    }
  };

  const handleDeleteSession = async (sessionId: string) => {
    try {
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

  return (
    <div className="flex h-full">
      <NotesSidebar
        sessions={sessions}
        selectedId={selectedSessionId}
        activeSessionId={activeSession?.id}
        isRecording={isRecording}
        onSelect={setSelectedSessionId}
        onNewNote={handleNewNote}
        onDelete={handleDeleteSession}
        onOpenSettings={onOpenSettings}
      />
      <div className="flex-1 overflow-hidden">
        {selectedSessionId ? (
          <NoteView
            session={
              sessions.find((s) => s.id === selectedSessionId) ?? activeSession
            }
            isActive={activeSession?.id === selectedSessionId}
            isRecording={isRecording}
            amplitude={amplitude}
            transcript={transcript}
            userNotes={userNotes}
            notesLoaded={notesLoaded}
            summary={summary}
            summaryLoading={summaryLoading}
            summaryError={summaryError}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            onNotesChange={handleNotesChange}
            onStartRecording={handleStartRecording}
            onEndNote={handleEndNote}
            onGenerateSummary={() => generateSummary(selectedSessionId)}
          />
        ) : (
          <EmptyState onNewNote={handleNewNote} />
        )}
      </div>
    </div>
  );
}
