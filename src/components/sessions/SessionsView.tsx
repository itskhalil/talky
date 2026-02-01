import { useEffect, useState, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Plus,
  Square,
  Trash2,
  ChevronLeft,
  Mic,
  Volume2,
  Circle,
  RefreshCw,
  Loader2,
} from "lucide-react";
import { NotesEditor } from "./NotesEditor";

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

function formatDuration(startedAt: number, endedAt: number | null): string {
  const end = endedAt ?? Math.floor(Date.now() / 1000);
  const seconds = end - startedAt;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString();
}

function formatMs(ms: number): string {
  const totalSecs = Math.floor(ms / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

interface AmplitudeEvent {
  session_id: string;
  mic: number;
  speaker: number;
}

type DetailTab = "notes" | "transcript" | "summary";

export function SessionsView() {
  const { t } = useTranslation();
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
  const transcriptEndRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript]);

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

  const handleBack = async () => {
    // Flush pending save
    if (saveTimerRef.current && selectedSessionId) {
      clearTimeout(saveTimerRef.current);
      await saveUserNotes(selectedSessionId, userNotes);
    }
    // If this is the active session, stop recording and end it
    if (activeSession?.id === selectedSessionId) {
      try {
        await invoke("end_session");
        setActiveSession(null);
        setIsRecording(false);
        setAmplitude({ mic: 0, speaker: 0 });
        loadSessions();
      } catch (e) {
        console.error("Failed to end note on back:", e);
      }
    }
    setSelectedSessionId(null);
    setTranscript([]);
    setUserNotes("");
  };

  // ── Detail view ──
  if (selectedSessionId) {
    const session =
      sessions.find((s) => s.id === selectedSessionId) ?? activeSession;
    const isActive = activeSession?.id === selectedSessionId;

    return (
      <div className="w-full max-w-2xl">
        {/* Header */}
        <div className="flex items-center gap-2 mb-4">
          <button
            onClick={handleBack}
            className="p-1 rounded hover:bg-mid-gray/20"
          >
            <ChevronLeft size={20} />
          </button>
          <h2 className="text-lg font-semibold flex-1 truncate">
            {session?.title ?? t("sessions.title")}
          </h2>
          {isActive && isRecording && (
            <button
              onClick={handleStopRecording}
              className="flex items-center gap-1.5 text-xs bg-red-500/20 text-red-400 px-2.5 py-1 rounded-full hover:bg-red-500/30 transition-colors animate-pulse"
            >
              <Square size={12} />
              {t("sessions.stopRecording")}
            </button>
          )}
          {isActive && !isRecording && (
            <button
              onClick={handleStartRecording}
              className="flex items-center gap-1.5 text-xs bg-logo-primary/80 px-2.5 py-1 rounded-full hover:bg-logo-primary transition-colors"
            >
              <Circle size={12} />
              {t("sessions.startRecording")}
            </button>
          )}
        </div>

        {session && (
          <div className="text-xs text-mid-gray mb-3">
            {formatTime(session.started_at)} &middot;{" "}
            {formatDuration(session.started_at, session.ended_at)}
          </div>
        )}

        {/* Tabs */}
        <div className="flex border-b border-mid-gray/20 mb-4">
          <button
            onClick={() => setActiveTab("notes")}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === "notes"
                ? "border-b-2 border-logo-primary text-logo-primary"
                : "text-mid-gray hover:text-foreground"
            }`}
          >
            {t("sessions.notesTab")}
          </button>
          <button
            onClick={() => setActiveTab("transcript")}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === "transcript"
                ? "border-b-2 border-logo-primary text-logo-primary"
                : "text-mid-gray hover:text-foreground"
            }`}
          >
            {t("sessions.transcriptTab")}
          </button>
          <button
            onClick={() => setActiveTab("summary")}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === "summary"
                ? "border-b-2 border-logo-primary text-logo-primary"
                : "text-mid-gray hover:text-foreground"
            }`}
          >
            {t("sessions.summaryTab")}
          </button>
        </div>

        {/* Notes tab */}
        {activeTab === "notes" && (
          <div>
            <NotesEditor
              content={notesLoaded ? userNotes : ""}
              onChange={handleNotesChange}
              disabled={!notesLoaded}
              placeholder={t("sessions.notesPlaceholder")}
            />
          </div>
        )}

        {/* Transcript tab */}
        {activeTab === "transcript" && (
          <div className="flex flex-col gap-4">
            {/* Amplitude viz when recording */}
            {isActive && isRecording && (
              <div className="flex gap-4">
                <div className="flex items-center gap-2 flex-1">
                  <Mic size={14} className="text-blue-400 shrink-0" />
                  <div className="flex-1 h-2 bg-mid-gray/20 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-400 rounded-full transition-all duration-100"
                      style={{
                        width: `${Math.min(amplitude.mic / 10, 100)}%`,
                      }}
                    />
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-1">
                  <Volume2
                    size={14}
                    className="text-green-400 shrink-0"
                  />
                  <div className="flex-1 h-2 bg-mid-gray/20 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-green-400 rounded-full transition-all duration-100"
                      style={{
                        width: `${Math.min(amplitude.speaker / 10, 100)}%`,
                      }}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Transcript list */}
            <div className="border border-mid-gray/20 rounded-lg p-3 max-h-80 overflow-y-auto bg-background">
              {transcript.length === 0 ? (
                <p className="text-sm text-mid-gray">
                  {t("sessions.noTranscript")}
                </p>
              ) : (
                <div className="space-y-2">
                  {transcript.map((seg) => (
                    <div key={seg.id} className="flex gap-2 text-sm">
                      <span className="text-xs text-mid-gray shrink-0 pt-0.5 w-10 text-right">
                        {formatMs(seg.start_ms)}
                      </span>
                      <span
                        className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${
                          seg.source === "mic"
                            ? "bg-blue-500/20 text-blue-400"
                            : "bg-green-500/20 text-green-400"
                        }`}
                      >
                        {seg.source === "mic"
                          ? t("sessions.mic")
                          : t("sessions.speaker")}
                      </span>
                      <span>{seg.text}</span>
                    </div>
                  ))}
                  <div ref={transcriptEndRef} />
                </div>
              )}
            </div>
          </div>
        )}

        {/* Summary tab */}
        {activeTab === "summary" && (
          <div className="flex flex-col gap-3">
            {summaryLoading && (
              <div className="flex items-center gap-2 text-sm text-mid-gray">
                <Loader2 size={16} className="animate-spin" />
                {t("sessions.summaryLoading")}
              </div>
            )}
            {!summaryLoading && summaryError && (
              <div className="text-sm">
                <p className="text-red-400 mb-2">
                  {t("sessions.summaryError")}
                </p>
                <p className="text-xs text-mid-gray">{summaryError}</p>
              </div>
            )}
            {!summaryLoading && !summaryError && summary && (
              <div className="border border-mid-gray/20 rounded-lg p-3 bg-background">
                <p className="text-sm whitespace-pre-wrap">{summary}</p>
              </div>
            )}
            {!summaryLoading && !summaryError && !summary && (
              <p className="text-sm text-mid-gray">
                {t("sessions.noSummary")}
              </p>
            )}
            {selectedSessionId && !summaryLoading && (
              <button
                onClick={() => generateSummary(selectedSessionId)}
                className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-mid-gray/20 hover:bg-mid-gray/30 transition-colors w-fit"
              >
                <RefreshCw size={12} />
                {summary
                  ? t("sessions.regenerateSummary")
                  : t("sessions.generateSummary")}
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  // ── List view ──
  return (
    <div className="w-full max-w-2xl">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">{t("sessions.title")}</h2>
        <button
          onClick={handleNewNote}
          className="flex items-center gap-2 px-3 py-1.5 bg-logo-primary/80 rounded-lg hover:bg-logo-primary transition-colors text-sm"
        >
          <Plus size={14} />
          {t("sessions.newNote")}
        </button>
      </div>

      {sessions.length === 0 ? (
        <p className="text-sm text-mid-gray">{t("sessions.noSessions")}</p>
      ) : (
        <div className="space-y-2">
          {sessions.map((session) => {
            const isActive = activeSession?.id === session.id;
            return (
              <div
                key={session.id}
                className="flex items-center gap-3 p-3 border border-mid-gray/20 rounded-lg cursor-pointer hover:bg-mid-gray/10 transition-colors"
                onClick={() => setSelectedSessionId(session.id)}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">
                      {session.title}
                    </span>
                    {isActive && (
                      <span className="text-xs bg-green-500/20 text-green-400 px-1.5 py-0.5 rounded-full shrink-0">
                        {t("sessions.active")}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-mid-gray mt-0.5">
                    {formatTime(session.started_at)} &middot;{" "}
                    {formatDuration(session.started_at, session.ended_at)}
                  </div>
                </div>
                {!isActive && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteSession(session.id);
                    }}
                    className="p-1.5 rounded hover:bg-red-500/20 text-mid-gray hover:text-red-400 transition-colors"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
