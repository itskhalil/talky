import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronUp,
  ChevronDown,
  Square,
  Sparkles,
  Loader2,
  Circle,
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
  const showEnhanceButton =
    isEnded && hasTranscript && !summary && !summaryLoading;

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

        {/* Enhance button */}
        {showEnhanceButton && (
          <div className="flex justify-center mt-10">
            <button
              data-ui
              onClick={onGenerateSummary}
              className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-accent text-background text-sm font-medium hover:bg-accent/85 transition-colors"
            >
              <Sparkles size={15} />
              {t("sessions.generateSummary")}
            </button>
          </div>
        )}
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
            <div data-ui className="flex items-center gap-3 px-4 py-2.5">
              {/* Expand toggle */}
              <button
                onClick={() => setPanelOpen(!panelOpen)}
                className="flex items-center gap-1.5 text-text-secondary hover:text-text transition-colors"
              >
                {isRecording && (
                  <Circle
                    size={8}
                    className="text-red-400 fill-red-400"
                  />
                )}
                <span className="text-xs font-medium">
                  {t("sessions.transcript", { defaultValue: "Transcript" })}
                </span>
                {panelOpen ? (
                  <ChevronDown size={13} />
                ) : (
                  <ChevronUp size={13} />
                )}
              </button>

              {/* Stop button */}
              {isRecording && (
                <button
                  onClick={onStopRecording}
                  className="p-1.5 rounded-lg hover:bg-accent-soft transition-colors text-text-secondary hover:text-text"
                  title={t("sessions.stopRecording")}
                >
                  <Square size={14} />
                </button>
              )}

              {/* Resume link */}
              {isActive && !isRecording && (
                <button
                  onClick={onStartRecording}
                  className="text-xs font-medium text-accent hover:text-accent/70 transition-colors"
                >
                  {t("sessions.resumeRecording")}
                </button>
              )}

              {/* Regenerate summary */}
              {isEnded && summary && !summaryLoading && (
                <button
                  onClick={onGenerateSummary}
                  className="text-xs text-text-secondary hover:text-text transition-colors ml-auto"
                >
                  {t("sessions.regenerateSummary")}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
