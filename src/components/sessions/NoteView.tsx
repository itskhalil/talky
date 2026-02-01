import { useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  Mic,
  Square,
  Volume2,
  Loader2,
  RefreshCw,
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

type DetailTab = "notes" | "transcript" | "summary";

interface NoteViewProps {
  session: Session | null | undefined;
  isActive: boolean;
  isRecording: boolean;
  amplitude: { mic: number; speaker: number };
  transcript: TranscriptSegment[];
  userNotes: string;
  notesLoaded: boolean;
  summary: string | null;
  summaryLoading: boolean;
  summaryError: string | null;
  activeTab: DetailTab;
  onTabChange: (tab: DetailTab) => void;
  onNotesChange: (notes: string) => void;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onEndNote: () => void;
  onGenerateSummary: () => void;
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

export function NoteView({
  session,
  isActive,
  isRecording,
  amplitude,
  transcript,
  userNotes,
  notesLoaded,
  summary,
  summaryLoading,
  summaryError,
  activeTab,
  onTabChange,
  onNotesChange,
  onStartRecording,
  onStopRecording,
  onEndNote,
  onGenerateSummary,
}: NoteViewProps) {
  const { t } = useTranslation();
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 pt-5 pb-3">
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <h2 className="text-xl font-semibold truncate">
              {session?.title ?? t("sessions.title")}
            </h2>
            {session && (
              <div className="text-xs text-mid-gray mt-1">
                {formatTime(session.started_at)} &middot;{" "}
                {formatDuration(session.started_at, session.ended_at)}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {/* Mic button */}
            {isActive && !isRecording && (
              <button
                onClick={onStartRecording}
                className="p-2 rounded-lg text-mid-gray hover:text-foreground hover:bg-mid-gray/20 transition-colors"
                title={t("sessions.startRecording")}
              >
                <Mic size={20} />
              </button>
            )}
            {isActive && isRecording && (
              <button
                onClick={onStopRecording}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors animate-pulse"
              >
                <Square size={14} />
                <span className="text-sm font-medium">
                  {t("sessions.recording")}
                </span>
              </button>
            )}

            {/* End Note button */}
            {isActive && !isRecording && (
              <button
                onClick={onEndNote}
                className="text-xs px-3 py-1.5 rounded-lg bg-mid-gray/20 hover:bg-mid-gray/30 transition-colors"
              >
                {t("sessions.endNote")}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex px-6 gap-4 border-b border-mid-gray/10">
        {(["notes", "transcript", "summary"] as DetailTab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => onTabChange(tab)}
            className={`pb-2 text-sm font-medium transition-colors ${
              activeTab === tab
                ? "border-b-2 border-logo-primary text-logo-primary"
                : "text-mid-gray hover:text-foreground"
            }`}
          >
            {t(`sessions.${tab}Tab`)}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {/* Notes tab */}
        {activeTab === "notes" && (
          <NotesEditor
            content={notesLoaded ? userNotes : ""}
            onChange={onNotesChange}
            disabled={!notesLoaded}
            placeholder={t("sessions.notesPlaceholder")}
          />
        )}

        {/* Transcript tab */}
        {activeTab === "transcript" && (
          <div className="flex flex-col gap-4">
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

            <div className="max-h-[calc(100vh-16rem)] overflow-y-auto">
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
              <div className="rounded-lg p-3 bg-mid-gray/5">
                <p className="text-sm whitespace-pre-wrap">{summary}</p>
              </div>
            )}
            {!summaryLoading && !summaryError && !summary && (
              <p className="text-sm text-mid-gray">
                {t("sessions.noSummary")}
              </p>
            )}
            {!summaryLoading && (
              <button
                onClick={onGenerateSummary}
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
    </div>
  );
}
