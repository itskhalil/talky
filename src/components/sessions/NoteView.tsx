import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronUp,
  ChevronDown,
  Square,
  Sparkles,
  Loader2,
  Copy,
  Check,
} from "lucide-react";
import { NotesEditor } from "./NotesEditor";
import { JSONContent } from "@tiptap/core";

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
  onEnhancedNotesChange?: (tagged: string) => void;
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

/**
 * Parse enhanced notes (tagged markdown with [ai]/[user] markers) into
 * a tiptap JSON document with `source` attributes on each block.
 */
export function parseEnhancedToTiptapJSON(content: string): JSONContent {
  const lines = content.split("\n");
  const nodes: JSONContent[] = [];

  // For lines without a tag (headers), inherit from next tagged line
  const parsed = lines.map((line) => {
    const isAi = /\[ai\]/.test(line);
    const isUser = /\[user\]/.test(line);
    const cleaned = line
      .replace(/\*{0,2}\[(?:user|ai)\]\*{0,2}\s*/g, "")
      .replace(/\*{4}/g, "");
    return { cleaned, isAi, isUser, hasTag: isAi || isUser };
  });

  // Inherit source for untagged headers
  for (let i = 0; i < parsed.length; i++) {
    if (!parsed[i].hasTag && parsed[i].cleaned.trimStart().match(/^#{1,3}\s/)) {
      for (let j = i + 1; j < parsed.length; j++) {
        if (parsed[j].hasTag) {
          parsed[i].isAi = parsed[j].isAi;
          break;
        }
        if (parsed[j].cleaned.trim() === "") break;
      }
    }
  }

  let i = 0;
  while (i < parsed.length) {
    const { cleaned, isAi } = parsed[i];
    const trimmed = cleaned.trimStart();
    const source = isAi ? "ai" : "user";

    // Skip empty lines — spacing is handled by CSS margins on headings/lists
    if (trimmed === "") {
      i++;
      continue;
    }

    // Heading
    const headingMatch = trimmed.match(/^(#{1,3})\s+(.*)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      nodes.push({
        type: "heading",
        attrs: { level, source },
        content: parseInlineContent(headingMatch[2]),
      });
      i++;
      continue;
    }

    // Bullet list: collect consecutive bullet lines
    if (trimmed.match(/^-\s/)) {
      const listItems: JSONContent[] = [];
      while (i < parsed.length) {
        const bTrimmed = parsed[i].cleaned.trimStart();
        const bMatch = bTrimmed.match(/^-\s+(.*)/);
        if (!bMatch) break;
        const bSource = parsed[i].isAi ? "ai" : "user";
        listItems.push({
          type: "listItem",
          attrs: { source: bSource },
          content: [
            {
              type: "paragraph",
              attrs: { source: bSource },
              content: parseInlineContent(bMatch[1]),
            },
          ],
        });
        i++;
      }
      nodes.push({ type: "bulletList", content: listItems });
      continue;
    }

    // Regular paragraph
    nodes.push({
      type: "paragraph",
      attrs: { source },
      content: parseInlineContent(trimmed),
    });
    i++;
  }

  return { type: "doc", content: nodes };
}

function parseInlineContent(text: string): JSONContent[] {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
  const result: JSONContent[] = [];
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith("**") && part.endsWith("**")) {
      result.push({
        type: "text",
        text: part.slice(2, -2),
        marks: [{ type: "bold" }],
      });
    } else if (part.startsWith("*") && part.endsWith("*")) {
      result.push({
        type: "text",
        text: part.slice(1, -1),
        marks: [{ type: "italic" }],
      });
    } else {
      result.push({ type: "text", text: part });
    }
  }
  return result.length > 0 ? result : [{ type: "text", text: " " }];
}

/**
 * Serialize tiptap JSON back to tagged markdown for storage.
 */
export function serializeTiptapToTagged(json: JSONContent): string {
  if (!json.content) return "";
  const lines: string[] = [];

  for (const node of json.content) {
    const source = node.attrs?.source ?? "user";
    const tag = `[${source}]`;

    if (node.type === "heading") {
      const level = node.attrs?.level ?? 2;
      const hashes = "#".repeat(level);
      const text = inlineToMarkdown(node.content);
      lines.push(`${hashes} ${text}`);
    } else if (node.type === "bulletList" && node.content) {
      for (const li of node.content) {
        const liSource = li.attrs?.source ?? "user";
        const liTag = `[${liSource}]`;
        const para = li.content?.[0];
        const text = para ? inlineToMarkdown(para.content) : "";
        lines.push(`${liTag} - ${text}`);
      }
    } else if (node.type === "paragraph") {
      const text = inlineToMarkdown(node.content);
      if (text.trim() === "") {
        lines.push("");
      } else {
        lines.push(`${tag} ${text}`);
      }
    }
  }

  return lines.join("\n");
}

function inlineToMarkdown(content?: JSONContent[]): string {
  if (!content) return "";
  return content
    .map((node) => {
      if (node.type !== "text" || !node.text) return "";
      const hasBold = node.marks?.some((m) => m.type === "bold");
      const hasItalic = node.marks?.some((m) => m.type === "italic");
      let t = node.text;
      if (hasBold) t = `**${t}**`;
      if (hasItalic) t = `*${t}*`;
      return t;
    })
    .join("");
}

export function NoteView({
  session,
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
  onEnhancedNotesChange,
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
  const [enhancedJSON, setEnhancedJSON] = useState<JSONContent | null>(null);
  const [notesCopied, setNotesCopied] = useState(false);
  const [transcriptCopied, setTranscriptCopied] = useState(false);

  const handleCopyNotes = async () => {
    let text = "";
    if (viewMode === "enhanced" && enhancedNotes) {
      text = enhancedNotes.replace(/\*{0,2}\[(?:user|ai)\]\*{0,2}\s*/g, "").replace(/\*{4}/g, "");
    } else {
      text = userNotes;
    }
    await navigator.clipboard.writeText(text);
    setNotesCopied(true);
    setTimeout(() => setNotesCopied(false), 1500);
  };

  const handleCopyTranscript = async () => {
    const text = transcript
      .map((seg) => {
        const mins = Math.floor(seg.start_ms / 60000);
        const secs = Math.floor((seg.start_ms % 60000) / 1000);
        return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}  ${seg.text}`;
      })
      .join("\n");
    await navigator.clipboard.writeText(text);
    setTranscriptCopied(true);
    setTimeout(() => setTranscriptCopied(false), 1500);
  };

  useEffect(() => {
    setTitleValue(session?.title ?? "");
  }, [session?.id, session?.title]);

  useEffect(() => {
    if (panelOpen) {
      transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [transcript, panelOpen]);

  // Parse enhanced notes into tiptap JSON when they change
  useEffect(() => {
    if (enhancedNotes) {
      console.log("[EnhancedNotesPanel] raw content:\n", enhancedNotes);
      setEnhancedJSON(parseEnhancedToTiptapJSON(enhancedNotes));
    } else {
      setEnhancedJSON(null);
    }
  }, [enhancedNotes]);

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

  const handleEnhancedJSONChange = (json: JSONContent) => {
    const tagged = serializeTiptapToTagged(json);
    onEnhancedNotesChange?.(tagged);
  };

  const hasTranscript = transcript.length > 0;
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
            <div className="flex items-center gap-2 mb-4">
              <div className="flex gap-1 bg-background-secondary rounded-lg p-0.5 w-fit">
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
              <button
                onClick={handleCopyNotes}
                className="p-1.5 rounded-md text-text-secondary/50 hover:text-text-secondary transition-colors"
                title={t("sessions.copyNotes")}
              >
                {notesCopied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
              </button>
            </div>
          )}

          {/* Content area */}
          {hasEnhanced && viewMode === "enhanced" ? (
            <>
              {enhanceLoading && (
                <div className="flex items-center gap-2 text-sm text-text-secondary pt-2">
                  <Loader2 size={14} className="animate-spin" />
                  {t("sessions.enhancing")}
                </div>
              )}
              {enhanceError && !enhanceLoading && (
                <div className="text-sm pt-2">
                  <p className="text-red-400">{t("sessions.enhanceError")}</p>
                  <p className="text-xs text-text-secondary mt-1">{enhanceError}</p>
                </div>
              )}
              {enhancedJSON && !enhanceLoading && (
                <NotesEditor
                  content=""
                  onChange={() => {}}
                  mode="enhanced"
                  initialJSON={enhancedJSON}
                  onJSONChange={handleEnhancedJSONChange}
                />
              )}
            </>
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

      {/* Floating recording panel — always show for any note */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 w-full max-w-xl px-4">
        <div className="bg-background border border-border-strong rounded-2xl shadow-sm overflow-hidden">
          {/* Expandable transcript area */}
          {panelOpen && (
            <div className="relative max-h-64 overflow-y-auto px-5 pt-4 pb-2 border-b border-border">
              {transcript.length > 0 && (
                <button
                  onClick={handleCopyTranscript}
                  className="sticky top-0 float-right p-1.5 rounded-md text-text-secondary/50 hover:text-text-secondary transition-colors z-10 bg-background/80 backdrop-blur-sm"
                  title={t("sessions.copyTranscript")}
                >
                  {transcriptCopied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
                </button>
              )}
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

          {/* Consent warning */}
          {isRecording && (
            <div className="px-3 pt-1.5 pb-0">
              <p className="text-[10px] text-text-secondary/50 text-center">
                {t("sessions.consentWarning")}
              </p>
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

            {/* Right: resume / start recording / enhance */}
            <div className="flex items-center gap-3">
              {!isRecording && (
                <button
                  onClick={onStartRecording}
                  className="text-xs font-medium text-accent hover:text-accent/70 transition-colors"
                >
                  {hasTranscript
                    ? t("sessions.resumeRecording")
                    : t("sessions.startRecording")}
                </button>
              )}
              {!isRecording && hasTranscript && !enhanceLoading && (
                <>
                  <span className="w-px h-3.5 bg-border-strong" />
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
    </div>
  );
}
