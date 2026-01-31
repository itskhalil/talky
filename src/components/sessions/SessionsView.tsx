import { useEffect, useState, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Play, Square, Trash2, ChevronLeft, Mic, Volume2 } from "lucide-react";

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
  const transcriptEndRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    loadSessions();
    loadActiveSession();
  }, [loadSessions, loadActiveSession]);

  useEffect(() => {
    if (selectedSessionId) {
      loadTranscript(selectedSessionId);
    }
  }, [selectedSessionId, loadTranscript]);

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

  const handleStartSession = async () => {
    try {
      const result = await invoke<Session>("start_session", { title: null });
      setActiveSession(result);
      setSelectedSessionId(result.id);
      setTranscript([]);
    } catch (e) {
      console.error("Failed to start session:", e);
    }
  };

  const handleEndSession = async () => {
    try {
      await invoke("end_session");
      setActiveSession(null);
      loadSessions();
    } catch (e) {
      console.error("Failed to end session:", e);
    }
  };

  const handleDeleteSession = async (sessionId: string) => {
    try {
      await invoke("delete_session", { sessionId });
      if (selectedSessionId === sessionId) {
        setSelectedSessionId(null);
        setTranscript([]);
      }
      loadSessions();
    } catch (e) {
      console.error("Failed to delete session:", e);
    }
  };

  if (selectedSessionId) {
    const session =
      sessions.find((s) => s.id === selectedSessionId) ?? activeSession;
    const isActive = activeSession?.id === selectedSessionId;

    return (
      <div className="w-full max-w-2xl">
        <div className="flex items-center gap-2 mb-4">
          <button
            onClick={() => {
              setSelectedSessionId(null);
              setTranscript([]);
            }}
            className="p-1 rounded hover:bg-mid-gray/20"
          >
            <ChevronLeft size={20} />
          </button>
          <h2 className="text-lg font-semibold flex-1 truncate">
            {session?.title ?? t("sessions.title")}
          </h2>
          {isActive && (
            <span className="text-xs bg-red-500/20 text-red-400 px-2 py-1 rounded-full animate-pulse">
              {t("sessions.active")}
            </span>
          )}
        </div>

        {session && (
          <div className="text-xs text-mid-gray mb-3">
            {formatTime(session.started_at)} &middot;{" "}
            {formatDuration(session.started_at, session.ended_at)}
          </div>
        )}

        {isActive && (
          <>
            <button
              onClick={handleEndSession}
              className="flex items-center gap-2 px-4 py-2 mb-4 bg-red-500/20 text-red-400 rounded-lg hover:bg-red-500/30 transition-colors"
            >
              <Square size={16} />
              {t("sessions.endSession")}
            </button>
            <div className="flex gap-4 mb-4">
              <div className="flex items-center gap-2 flex-1">
                <Mic size={14} className="text-blue-400 shrink-0" />
                <div className="flex-1 h-2 bg-mid-gray/20 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-400 rounded-full transition-all duration-100"
                    style={{ width: `${Math.min(amplitude.mic / 10, 100)}%` }}
                  />
                </div>
              </div>
              <div className="flex items-center gap-2 flex-1">
                <Volume2 size={14} className="text-green-400 shrink-0" />
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
          </>
        )}

        <h3 className="text-sm font-medium mb-2">
          {isActive ? t("sessions.liveTranscript") : t("sessions.transcript")}
        </h3>

        <div className="border border-mid-gray/20 rounded-lg p-3 max-h-96 overflow-y-auto bg-background">
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
    );
  }

  return (
    <div className="w-full max-w-2xl">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">{t("sessions.title")}</h2>
        {activeSession ? (
          <button
            onClick={handleEndSession}
            className="flex items-center gap-2 px-3 py-1.5 bg-red-500/20 text-red-400 rounded-lg hover:bg-red-500/30 transition-colors text-sm"
          >
            <Square size={14} />
            {t("sessions.endSession")}
          </button>
        ) : (
          <button
            onClick={handleStartSession}
            className="flex items-center gap-2 px-3 py-1.5 bg-logo-primary/80 rounded-lg hover:bg-logo-primary transition-colors text-sm"
          >
            <Play size={14} />
            {t("sessions.startSession")}
          </button>
        )}
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
                      <span className="text-xs bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded-full animate-pulse shrink-0">
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
