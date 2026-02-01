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
  enhancedNotes: string | null;
  onNotesChange: (notes: string) => void;
  onTitleChange: (title: string) => void;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onGenerateSummary: () => void;
  onEnhanceNotes: () => void;
  enhanceLoading: boolean;
  enhanceError: string | null;
  viewMode: "notes" | "enhanced";
  onViewModeChange: (mode: "notes" | "enhanced") => void;
}

function formatMs(ms: number): string {
  const totalSecs = Math.floor(ms / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function renderInlineMarkdown(text: string) {
  // Match **bold** or *italic* (but not ** inside bold)
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("*") && part.endsWith("*")) {
      return <em key={i}>{part.slice(1, -1)}</em>;
    }
    return <span key={i}>{part}</span>;
  });
}

function EnhancedNotesPanel({ content, loading, error }: { content: string | null; loading: boolean; error: string | null }) {
  const { t } = useTranslation();

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-text-secondary pt-2">
        <Loader2 size={14} className="animate-spin" />
        {t("sessions.enhancing")}
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-sm pt-2">
        <p className="text-red-400">{t("sessions.enhanceError")}</p>
        <p className="text-xs text-text-secondary mt-1">{error}</p>
      </div>
    );
  }

  if (!content) return null;

  console.log("[EnhancedNotesPanel] raw content:\n", content);

  // Pre-process lines: strip tags, detect source, parse structure
  const rawLines = content.split("\n");
  const parsed = rawLines.map((line) => {
    const isAi = /\[ai\]/.test(line);
    const isUser = /\[user\]/.test(line);
    // Strip tags including surrounding bold markers: **[user]**, **[ai]**
    const cleaned = line
      .replace(/\*{0,2}\[(?:user|ai)\]\*{0,2}\s*/g, "")
      .replace(/\*{4}/g, ""); // clean up any leftover empty bold markers
    const trimmed = cleaned.trimStart();
    const headerMatch = trimmed.match(/^(#{1,4})\s+(.*)/);
    const bulletMatch = trimmed.match(/^-\s+(.*)/);
    return { cleaned, trimmed, isAi, isUser, hasTag: isAi || isUser, headerMatch, bulletMatch };
  });

  // For lines without a tag (typically headers), inherit from the next tagged line
  for (let i = 0; i < parsed.length; i++) {
    if (!parsed[i].hasTag && parsed[i].headerMatch) {
      for (let j = i + 1; j < parsed.length; j++) {
        if (parsed[j].hasTag) {
          parsed[i].isAi = parsed[j].isAi;
          break;
        }
        if (parsed[j].trimmed === "") break;
      }
    }
  }

  return (
    <div className="text-base leading-[1.7] cursor-text select-text">
      {parsed.map((line, i) => {
        const colorClass = line.isAi ? "text-text-ai" : "text-text";

        if (line.headerMatch) {
          const level = line.headerMatch[1].length;
          const headerSize =
            level === 1 ? "text-xl" : level === 2 ? "text-lg" : "text-base";
          return (
            <div key={i} className={colorClass}>
              <p className={`${headerSize} font-semibold mt-3 mb-1`}>{renderInlineMarkdown(line.headerMatch[2])}</p>
            </div>
          );
        }

        if (line.trimmed === "") {
          return <div key={i} className="h-1" />;
        }

        if (line.bulletMatch) {
          return (
            <div key={i} className={`${colorClass} flex gap-2 ml-1`}>
              <span className="shrink-0 select-none">•</span>
              <p className="whitespace-pre-wrap">{renderInlineMarkdown(line.bulletMatch[1])}</p>
            </div>
          );
        }

        return (
          <div key={i} className={colorClass}>
            <p className="whitespace-pre-wrap">{renderInlineMarkdown(line.cleaned)}</p>
          </div>
        );
      })}
    </div>
  );
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
  enhancedNotes,
  onNotesChange,
  onTitleChange,
  onStartRecording,
  onStopRecording,
  onGenerateSummary,
  onEnhanceNotes,
  enhanceLoading,
  enhanceError,
  viewMode,
  onViewModeChange,
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
  const hasEnhanced = enhancedNotes != null || enhanceLoading || enhanceError != null;

  return (
    <div className="flex flex-col h-full relative">
      {/* Title + editor area */}
      <div className="flex-1 overflow-y-auto px-12 pt-4 pb-32 w-full cursor-text select-text">
        {/* Editable title */}
        <div className="max-w-3xl mx-auto">
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
        </div>

        <div className="max-w-3xl mx-auto">
          {/* View mode toggle - only show when enhanced notes exist */}
          {hasEnhanced && (
            <div className="flex gap-1 mb-4 bg-background-secondary rounded-lg p-0.5 w-fit">
              <button
                onClick={() => onViewModeChange("enhanced")}
                className={`text-xs font-medium px-3 py-1.5 rounded-md transition-colors ${
                  viewMode === "enhanced"
                    ? "bg-background text-text shadow-sm"
                    : "text-text-secondary hover:text-text"
                }`}
              >
                {t("sessions.enhancedNotes")}
              </button>
              <button
                onClick={() => onViewModeChange("notes")}
                className={`text-xs font-medium px-3 py-1.5 rounded-md transition-colors ${
                  viewMode === "notes"
                    ? "bg-background text-text shadow-sm"
                    : "text-text-secondary hover:text-text"
                }`}
              >
                {t("sessions.yourNotes")}
              </button>
            </div>
          )}

          {/* Content area */}
          {hasEnhanced && viewMode === "enhanced" ? (
            <EnhancedNotesPanel
              content={enhancedNotes}
              loading={enhanceLoading}
              error={enhanceError}
            />
          ) : (
            <>
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
            </>
          )}
        </div>
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
                {isRecording && (() => {
                  const amp = Math.max(amplitude.mic, amplitude.speaker) / 1000;
                  const clamped = Math.min(Math.max(amp * 3, 0), 1);
                  const minH = 4;
                  const maxH = 16;
                  const h1 = minH + clamped * (maxH - minH) * 0.7;
                  const h2 = minH + clamped * (maxH - minH);
                  const h3 = minH + clamped * (maxH - minH) * 0.5;
                  const cy = 12; // vertical center
                  return (
                    <svg width="22" height="22" viewBox="0 0 24 24" className="text-green-500">
                      <rect x="4" y={cy - h1 / 2} width="3" height={h1} rx="1.5" fill="currentColor" style={{ transition: "y 0.1s ease, height 0.1s ease" }} />
                      <rect x="10.5" y={cy - h2 / 2} width="3" height={h2} rx="1.5" fill="currentColor" style={{ transition: "y 0.1s ease, height 0.1s ease" }} />
                      <rect x="17" y={cy - h3 / 2} width="3" height={h3} rx="1.5" fill="currentColor" style={{ transition: "y 0.1s ease, height 0.1s ease" }} />
                    </svg>
                  );
                })()}
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
                {!isRecording && hasTranscript && !enhanceLoading && (
                  <>
                    {isActive && <span className="w-px h-3.5 bg-border-strong" />}
                    <button
                      onClick={onEnhanceNotes}
                      className="flex items-center gap-1.5 text-xs font-medium text-accent hover:text-accent/70 transition-colors"
                    >
                      <Sparkles size={12} />
                      {enhancedNotes
                        ? t("sessions.reenhance")
                        : t("sessions.enhanceNotes")}
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
