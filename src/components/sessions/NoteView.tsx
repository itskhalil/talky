import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronUp,
  ChevronDown,
  Square,
  Sparkles,
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
  onNotesChange: (notes: string) => void;
  onTitleChange: (title: string) => void;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onGenerateSummary: () => void;
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
  transcript,
  userNotes,
  notesLoaded,
  summary,
  summaryLoading,
  summaryError,
  onNotesChange,
  onTitleChange,
  onStartRecording,
  onStopRecording,
  onGenerateSummary,
}: NoteViewProps) {
  const { t } = useTranslation();
  const [panelOpen, setPanelOpen] = useState(false);
  const [titleValue, setTitleValue] = useState(session?.title ?? "");
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTitleValue(session?.title ?? "");
  }, [session?.id, session?.title]);

  useEffect(() => {
    if (panelOpen) {
      transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [transcript, panelOpen]);

  const handleTitleBlur = () => {
    const trimmed = titleValue.trim();
    if (trimmed && trimmed !== session?.title) {
      onTitleChange(trimmed);
    }
  };

  const handleTitleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      (e.target as HTMLInputElement).blur();
    }
  };

  const hasTranscript = transcript.length > 0;
  const isEnded = !isActive;

  return (
    <div className="flex flex-col h-full relative">
      {/* Title + editor area */}
      <div className="flex-1 overflow-y-auto px-12 pt-8 pb-32 max-w-3xl mx-auto w-full">
        {/* Editable title */}
        <input
          type="text"
          data-ui
          value={titleValue}
          onChange={(e) => setTitleValue(e.target.value)}
          onBlur={handleTitleBlur}
          onKeyDown={handleTitleKeyDown}
          placeholder={t("sessions.newNote")}
          className="w-full text-2xl font-semibold bg-transparent border-none outline-none placeholder:text-mid-gray/30 mb-6 tracking-tight"
        />

        {/* Summary display */}
        {summaryLoading && (
          <div className="flex items-center gap-2 text-sm text-text-secondary mb-5">
            <Loader2 size={14} className="animate-spin" />
            {t("sessions.summaryLoading")}
          </div>
        )}
        {summaryError && !summaryLoading && (
          <div className="text-sm mb-5">
            <p className="text-red-400">{t("sessions.summaryError")}</p>
            <p className="text-xs text-text-secondary mt-1">{summaryError}</p>
          </div>
        )}
        {summary && !summaryLoading && (
          <div className="mb-6 text-sm whitespace-pre-wrap leading-relaxed text-text">
            {summary}
          </div>
        )}

        {/* Notes editor */}
        <NotesEditor
          content={notesLoaded ? userNotes : ""}
          onChange={onNotesChange}
          disabled={!notesLoaded}
          placeholder={t("sessions.notesPlaceholder")}
        />

      </div>

      {/* Floating recording panel */}
      {(isActive || hasTranscript) && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 w-full max-w-xl px-4">
          <div className="bg-background border border-border-strong rounded-2xl shadow-sm overflow-hidden">
            {/* Expandable transcript area */}
            {panelOpen && (
              <div className="max-h-64 overflow-y-auto px-5 pt-4 pb-2 border-b border-border">
                {transcript.length === 0 ? (
                  <p data-ui className="text-xs text-text-secondary py-2">
                    {t("sessions.noTranscript")}
                  </p>
                ) : (
                  <div className="space-y-2">
                    {transcript.map((seg) => (
                      <div key={seg.id} className="flex gap-3 text-sm">
                        <span
                          data-ui
                          className="text-xs text-text-secondary/50 shrink-0 pt-0.5 w-9 text-right tabular-nums"
                        >
                          {formatMs(seg.start_ms)}
                        </span>
                        <span className="text-sm leading-relaxed text-text">
                          {seg.text}
                        </span>
                      </div>
                    ))}
                    <div ref={transcriptEndRef} />
                  </div>
                )}
              </div>
            )}

            {/* Bottom bar */}
            <div data-ui className="flex items-center justify-between px-3 py-2">
              {/* Left: audio icon + chevron + stop */}
              <div className="flex items-center gap-0.5">
                {isRecording && (
                  <svg width="22" height="22" viewBox="0 0 24 24" className="text-green-500">
                    <rect x="4" y="6" width="3" rx="1.5" fill="currentColor">
                      <animate attributeName="height" values="12;6;14;8;12" dur="1s" repeatCount="indefinite" />
                      <animate attributeName="y" values="6;9;5;8;6" dur="1s" repeatCount="indefinite" />
                    </rect>
                    <rect x="10.5" y="4" width="3" rx="1.5" fill="currentColor">
                      <animate attributeName="height" values="16;10;8;14;16" dur="1.1s" repeatCount="indefinite" />
                      <animate attributeName="y" values="4;7;8;5;4" dur="1.1s" repeatCount="indefinite" />
                    </rect>
                    <rect x="17" y="7" width="3" rx="1.5" fill="currentColor">
                      <animate attributeName="height" values="10;14;6;12;10" dur="0.9s" repeatCount="indefinite" />
                      <animate attributeName="y" values="7;5;9;6;7" dur="0.9s" repeatCount="indefinite" />
                    </rect>
                  </svg>
                )}
                <button
                  onClick={() => setPanelOpen(!panelOpen)}
                  className="p-1.5 rounded-md text-text-secondary/50 hover:text-text-secondary transition-colors"
                >
                  {panelOpen ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                </button>
                {isRecording && (
                  <button
                    onClick={onStopRecording}
                    className="p-1.5 rounded-md bg-text/8 hover:bg-text/12 transition-colors text-text-secondary/60"
                    title={t("sessions.stopRecording")}
                  >
                    <Square size={11} fill="currentColor" />
                  </button>
                )}
              </div>

              {/* Right: resume / summary */}
              <div className="flex items-center gap-3">
                {isActive && !isRecording && (
                  <button
                    onClick={onStartRecording}
                    className="text-xs font-medium text-accent hover:text-accent/70 transition-colors"
                  >
                    {t("sessions.resumeRecording")}
                  </button>
                )}
                {!isRecording && hasTranscript && !summaryLoading && (
                  <>
                    {isActive && <span className="w-px h-3.5 bg-border-strong" />}
                    <button
                      onClick={onGenerateSummary}
                      className="flex items-center gap-1.5 text-xs font-medium text-accent hover:text-accent/70 transition-colors"
                    >
                      <Sparkles size={12} />
                      {summary
                        ? t("sessions.regenerateSummary")
                        : t("sessions.generateSummary")}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
