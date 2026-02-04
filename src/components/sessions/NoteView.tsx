import { useState, useRef, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import { useTranslation } from "react-i18next";
import {
  ChevronUp,
  ChevronDown,
  Square,
  Sparkles,
  Loader2,
  Copy,
  Check,
  Send,
  X,
  RotateCcw,
  PenLine,
  List,
  FolderIcon,
  Tag,
  Plus,
} from "lucide-react";
import { NotesEditor } from "./NotesEditor";
import { FindBar } from "./FindBar";
import { useGlobalChat, type ChatMessage } from "@/hooks/useGlobalChat";
import { useSettings } from "@/hooks/useSettings";
import { useOrganizationStore } from "@/stores/organizationStore";
import { JSONContent, Editor } from "@tiptap/core";
import type { Tag as TagType } from "@/bindings";

interface Session {
  id: string;
  title: string;
  started_at: number;
  ended_at: number | null;
  status: string;
  folder_id: string | null;
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
  findBarOpen?: boolean;
  onCloseFindBar?: () => void;
}

function formatMs(ms: number): string {
  const totalSecs = Math.floor(ms / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/**
 * Format notes as Logseq-friendly bullet points.
 * - Each non-empty line becomes a bullet
 * - Headings become parent bullets (# removed)
 * - Subsequent lines indent under headings
 * - Existing bullets are preserved (no double bullets)
 */
function formatNotesForLogseq(notes: string): string {
  const lines = notes.split("\n");
  const result: string[] = [];
  let inHeading = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const headingMatch = trimmed.match(/^(#{1,4})\s+(.*)/);
    if (headingMatch) {
      result.push(`- ${headingMatch[2]}`);
      inHeading = true;
    } else {
      // Check if line already starts with a bullet
      const hasBullet = /^[-*]\s/.test(trimmed);
      if (hasBullet) {
        // Already a bullet - just indent if under a heading
        const content = trimmed.replace(/^[-*]\s+/, "");
        const prefix = inHeading ? "  - " : "- ";
        result.push(`${prefix}${content}`);
      } else {
        const prefix = inHeading ? "  - " : "- ";
        result.push(`${prefix}${trimmed}`);
      }
    }
  }

  return result.join("\n");
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
        if (parsed[j].cleaned.trim() === "") continue;
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

    // Skip horizontal rules/dividers (---, ***, ___)
    if (/^[-*_]{3,}$/.test(trimmed)) {
      i++;
      continue;
    }

    // Heading
    const headingMatch = trimmed.match(/^(#{1,4})\s+(.*)/);
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

    // Bullet list: collect consecutive bullet lines with nesting support
    if (trimmed.match(/^-\s/)) {
      const bulletList = parseBulletList(parsed, i);
      nodes.push(bulletList.node);
      i = bulletList.endIndex;
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

interface ParsedLine {
  cleaned: string;
  isAi: boolean;
  isUser: boolean;
  hasTag: boolean;
}

/**
 * Parse bullet list with nesting support.
 * Indentation is detected by counting leading spaces (2 spaces = 1 level).
 */
function parseBulletList(
  parsed: ParsedLine[],
  startIndex: number,
  baseIndent: number = 0
): { node: JSONContent; endIndex: number } {
  const listItems: JSONContent[] = [];
  let i = startIndex;

  while (i < parsed.length) {
    const line = parsed[i].cleaned;
    // Count leading spaces
    const leadingSpaces = line.length - line.trimStart().length;
    const indentLevel = Math.floor(leadingSpaces / 2);
    const trimmed = line.trimStart();
    const bulletMatch = trimmed.match(/^-\s+(.*)/);

    // Not a bullet line - end the list
    if (!bulletMatch) break;

    // Less indented than our base - this bullet belongs to parent list
    if (indentLevel < baseIndent) break;

    // More indented - this is a nested list, handled by recursive call
    if (indentLevel > baseIndent) {
      // Attach nested list to the last list item
      if (listItems.length > 0) {
        const nested = parseBulletList(parsed, i, indentLevel);
        listItems[listItems.length - 1].content!.push(nested.node);
        i = nested.endIndex;
      } else {
        // Edge case: indented bullet with no parent - treat as base level
        i++;
      }
      continue;
    }

    // Same indent level - add to current list
    const source = parsed[i].isAi ? "ai" : "user";
    listItems.push({
      type: "listItem",
      attrs: { source },
      content: [
        {
          type: "paragraph",
          attrs: { source },
          content: parseInlineContent(bulletMatch[1]),
        },
      ],
    });
    i++;
  }

  return {
    node: { type: "bulletList", content: listItems },
    endIndex: i,
  };
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
      serializeBulletList(node, lines, 0);
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

/**
 * Recursively serialize a bullet list with proper indentation.
 */
function serializeBulletList(
  node: JSONContent,
  lines: string[],
  depth: number
): void {
  if (!node.content) return;
  const indent = "  ".repeat(depth);

  for (const li of node.content) {
    const liSource = li.attrs?.source ?? "user";
    const liTag = `[${liSource}]`;

    // Find paragraph and nested lists in the list item
    const para = li.content?.find((c) => c.type === "paragraph");
    const nestedList = li.content?.find((c) => c.type === "bulletList");

    const text = para ? inlineToMarkdown(para.content) : "";
    lines.push(`${liTag} ${indent}- ${text}`);

    // Recursively serialize nested list
    if (nestedList) {
      serializeBulletList(nestedList, lines, depth + 1);
    }
  }
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
  findBarOpen,
  onCloseFindBar,
}: NoteViewProps) {
  const { t } = useTranslation();
  const { getSetting } = useSettings();
  const copyAsBulletsEnabled = getSetting("copy_as_bullets_enabled") ?? false;
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelMode, setPanelMode] = useState<"transcript" | "chat">("transcript");
  const [titleValue, setTitleValue] = useState(session?.title ?? "");
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLInputElement>(null);
  const [enhancedJSON, setEnhancedJSON] = useState<JSONContent | null>(null);
  const [notesCopied, setNotesCopied] = useState(false);
  const [transcriptCopied, setTranscriptCopied] = useState(false);
  const [bulletsCopied, setBulletsCopied] = useState(false);
  const [activeEditor, setActiveEditor] = useState<Editor | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [folderDropdownOpen, setFolderDropdownOpen] = useState(false);
  const [sessionTags, setSessionTags] = useState<TagType[]>([]);
  const [tagInputOpen, setTagInputOpen] = useState(false);
  const [tagInputValue, setTagInputValue] = useState("");
  const [localFolderId, setLocalFolderId] = useState<string | null>(session?.folder_id ?? null);
  const folderDropdownRef = useRef<HTMLDivElement>(null);
  const tagInputRef = useRef<HTMLInputElement>(null);

  const {
    folders,
    tags: allTags,
    moveSessionToFolder,
    getSessionTags,
    addTagToSession,
    removeTagFromSession,
    createTag,
  } = useOrganizationStore();

  // Fetch session tags when session changes
  useEffect(() => {
    if (session?.id) {
      getSessionTags(session.id).then(setSessionTags);
    } else {
      setSessionTags([]);
    }
  }, [session?.id, getSessionTags]);

  // Sync local folder state with session prop
  useEffect(() => {
    setLocalFolderId(session?.folder_id ?? null);
  }, [session?.id, session?.folder_id]);

  // Close folder dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (folderDropdownRef.current && !folderDropdownRef.current.contains(e.target as Node)) {
        setFolderDropdownOpen(false);
      }
    };
    if (folderDropdownOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [folderDropdownOpen]);

  // Focus tag input when opened
  useEffect(() => {
    if (tagInputOpen && tagInputRef.current) {
      tagInputRef.current.focus();
    }
  }, [tagInputOpen]);

  const handleFolderSelect = async (folderId: string | null) => {
    if (session?.id) {
      setLocalFolderId(folderId);
      await moveSessionToFolder(session.id, folderId);
      setFolderDropdownOpen(false);
    }
  };

  const handleAddTag = async (tagId: string) => {
    if (session?.id) {
      await addTagToSession(session.id, tagId);
      const updated = await getSessionTags(session.id);
      setSessionTags(updated);
    }
  };

  const handleRemoveTag = async (tagId: string) => {
    if (session?.id) {
      await removeTagFromSession(session.id, tagId);
      const updated = await getSessionTags(session.id);
      setSessionTags(updated);
    }
  };

  const handleCreateAndAddTag = async () => {
    if (!tagInputValue.trim() || !session?.id) return;
    const newTag = await createTag(tagInputValue.trim());
    if (newTag) {
      await addTagToSession(session.id, newTag.id);
      const updated = await getSessionTags(session.id);
      setSessionTags(updated);
    }
    setTagInputValue("");
    setTagInputOpen(false);
  };

  const currentFolder = folders.find((f) => f.id === localFolderId);
  const availableTags = allTags.filter((t) => !sessionTags.some((st) => st.id === t.id));

  const handleEditorReady = useCallback((editor: Editor | null) => {
    setActiveEditor(editor);
  }, []);

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

  const handleCopyAsBullets = async () => {
    let text = "";
    if (viewMode === "enhanced" && enhancedNotes) {
      text = enhancedNotes.replace(/\*{0,2}\[(?:user|ai)\]\*{0,2}\s*/g, "").replace(/\*{4}/g, "");
    } else {
      text = userNotes;
    }
    const formatted = formatNotesForLogseq(text);
    await navigator.clipboard.writeText(formatted);
    setBulletsCopied(true);
    setTimeout(() => setBulletsCopied(false), 1500);
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
    if (session) {
      // Show empty field with placeholder for new notes
      const isNewNote = session.title === "New Note";
      setTitleValue(isNewNote ? "" : session.title);
    } else {
      setTitleValue("");
    }
  }, [session?.id, session?.title]);

  // Auto-focus title for new notes
  useEffect(() => {
    if (session && textareaRef.current) {
      const isNewNote = session.title === "New Note";
      if (isNewNote) {
        textareaRef.current.focus();
      }
    }
  }, [session?.id]);

  const panelWasOpen = useRef(panelOpen);
  useEffect(() => {
    if (panelOpen && panelMode === "transcript") {
      const justOpened = !panelWasOpen.current;
      transcriptEndRef.current?.scrollIntoView({
        behavior: justOpened ? "instant" : "smooth",
      });
    }
    panelWasOpen.current = panelOpen;
  }, [transcript, panelOpen, panelMode]);

  // Reset scroll when switching view modes so title stays visible.
  // Use rAF to ensure this runs after the editor re-mounts and sets content.
  useEffect(() => {
    scrollContainerRef.current?.scrollTo(0, 0);
    const frame = requestAnimationFrame(() => {
      scrollContainerRef.current?.scrollTo(0, 0);
    });
    return () => cancelAnimationFrame(frame);
  }, [viewMode]);

  // Parse enhanced notes into tiptap JSON when they change
  useEffect(() => {
    if (enhancedNotes) {
      const json = parseEnhancedToTiptapJSON(enhancedNotes);
      setEnhancedJSON(json);
    } else {
      setEnhancedJSON(null);
    }
  }, [enhancedNotes]);

  const adjustTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "0";
      textarea.style.height = `${textarea.scrollHeight}px`;
    }
  }, []);

  useEffect(() => {
    adjustTextareaHeight();
  }, [titleValue, adjustTextareaHeight]);

  // Recalculate title height on window resize (title may wrap/unwrap)
  useEffect(() => {
    window.addEventListener("resize", adjustTextareaHeight);
    return () => window.removeEventListener("resize", adjustTextareaHeight);
  }, [adjustTextareaHeight]);

  const handleTitleBlur = () => {
    const trimmed = titleValue.trim();
    if (trimmed && trimmed !== session?.title) {
      onTitleChange(trimmed);
    }
  };

  const handleTitleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      (e.target as HTMLTextAreaElement).blur();
      // Focus the notes editor
      activeEditor?.commands.focus();
    }
  };

  const handleEnhancedJSONChange = (json: JSONContent) => {
    const tagged = serializeTiptapToTagged(json);
    onEnhancedNotesChange?.(tagged);
  };

  const getTranscriptText = useCallback(() => {
    return transcript
      .map((seg) => {
        const label = seg.source === "mic" ? "[You]" : "[Other]";
        return `[${formatMs(seg.start_ms)}] ${label}: ${seg.text}`;
      })
      .join("\n");
  }, [transcript]);

  const getUserNotesText = useCallback(() => {
    return userNotes;
  }, [userNotes]);

  const chat = useGlobalChat({
    currentNoteId: session?.id ?? "",
    getCurrentTranscript: getTranscriptText,
    getCurrentNotes: getUserNotesText,
  });

  useEffect(() => {
    if (panelOpen && panelMode === "chat") {
      chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [chat.messages, panelOpen, panelMode]);

  const handleChatSubmit = useCallback(() => {
    if (!chat.input.trim()) return;
    setPanelOpen(true);
    setPanelMode("chat");
    chat.handleSubmit();
  }, [chat]);

  const handleChatKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleChatSubmit();
      }
    },
    [handleChatSubmit],
  );

  const hasTranscript = transcript.length > 0;
  const hasEnhanced = enhancedNotes != null || enhanceLoading || enhanceError != null;

  return (
    <div className="flex flex-col h-full relative">
      {findBarOpen && onCloseFindBar && (
        <div className="absolute top-2 right-4 z-20 w-80">
          <FindBar editor={activeEditor} onClose={onCloseFindBar} />
        </div>
      )}
      {/* Pinned toggle + copy controls */}
      {hasEnhanced && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 w-full max-w-3xl px-4 flex justify-end pointer-events-none z-10">
          <div className="flex items-center gap-1.5 pointer-events-auto">
            <div className="flex bg-background-sidebar rounded-lg p-0.5">
              <button
                onClick={() => onViewModeChange("enhanced")}
                className={`p-1.5 rounded-md transition-colors ${viewMode === "enhanced" ? "bg-background text-text shadow-sm" : "text-text-secondary/50 hover:text-text-secondary"}`}
                title={t("sessions.enhancedNotes")}
              >
                <Sparkles size={14} />
              </button>
              <button
                onClick={() => onViewModeChange("notes")}
                className={`p-1.5 rounded-md transition-colors ${viewMode === "notes" ? "bg-background text-text shadow-sm" : "text-text-secondary/50 hover:text-text-secondary"}`}
                title={t("sessions.yourNotes")}
              >
                <PenLine size={14} />
              </button>
            </div>
            <div className="flex items-center bg-background-sidebar rounded-lg p-0.5">
              <button
                onClick={handleCopyNotes}
                className="p-1.5 rounded-md text-text-secondary/40 hover:text-text-secondary transition-colors"
                title={t("sessions.copyNotes")}
              >
                {notesCopied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
              </button>
              {copyAsBulletsEnabled && (
                <button
                  onClick={handleCopyAsBullets}
                  className="p-1.5 rounded-md text-text-secondary/40 hover:text-text-secondary transition-colors"
                  title={t("sessions.copyAsBullets")}
                >
                  {bulletsCopied ? <Check size={14} className="text-green-500" /> : <List size={14} />}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-scroll overflow-x-hidden px-12 pt-4 pb-32 w-full cursor-text select-text">
        {/* Editable title */}
        <div className="max-w-3xl mx-auto mb-6">
          <textarea
            ref={textareaRef}
            rows={1}
            value={titleValue}
            onChange={(e) => {
              setTitleValue(e.target.value);
              // Height adjustment is also handled by useEffect on titleValue
            }}
            onBlur={handleTitleBlur}
            onKeyDown={handleTitleKeyDown}
            placeholder={t("sessions.newNote")}
            className="w-full text-2xl font-semibold bg-transparent border-none outline-none placeholder:text-mid-gray/30 tracking-tight pr-16 resize-none overflow-hidden"
          />

          {/* Folder and Tags */}
          {session && (
            <div className="flex items-center gap-3 mt-2 flex-wrap">
              {/* Folder selector */}
              <div ref={folderDropdownRef} className="relative">
                <button
                  onClick={() => setFolderDropdownOpen(!folderDropdownOpen)}
                  className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-text-secondary hover:bg-accent-soft transition-colors"
                >
                  <FolderIcon size={12} style={currentFolder?.color ? { color: currentFolder.color } : undefined} />
                  <span>{currentFolder?.name ?? t("notes.noFolder", "Notes")}</span>
                  <ChevronDown size={10} />
                </button>
                {folderDropdownOpen && (
                  <div className="absolute top-full left-0 mt-1 bg-background border border-border rounded-lg shadow-lg z-20 min-w-[140px] py-1">
                    <button
                      onClick={() => handleFolderSelect(null)}
                      className={`w-full text-left px-3 py-1.5 text-xs hover:bg-accent-soft transition-colors ${!localFolderId ? "text-accent" : "text-text"}`}
                    >
                      {t("notes.noFolder", "Notes")}
                    </button>
                    {folders.map((folder) => (
                      <button
                        key={folder.id}
                        onClick={() => handleFolderSelect(folder.id)}
                        className={`w-full text-left px-3 py-1.5 text-xs hover:bg-accent-soft transition-colors flex items-center gap-2 ${localFolderId === folder.id ? "text-accent" : "text-text"}`}
                      >
                        <FolderIcon size={12} style={folder.color ? { color: folder.color } : undefined} />
                        {folder.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Tags */}
              <div className="flex items-center gap-1.5 flex-wrap">
                {sessionTags.map((tag) => (
                  <span
                    key={tag.id}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-accent-soft text-text"
                    style={tag.color ? { backgroundColor: `${tag.color}20`, color: tag.color } : undefined}
                  >
                    {tag.name}
                    <button
                      onClick={() => handleRemoveTag(tag.id)}
                      className="hover:text-red-400 transition-colors"
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}

                {/* Add tag */}
                {tagInputOpen ? (
                  <div className="flex items-center gap-1">
                    <input
                      ref={tagInputRef}
                      type="text"
                      value={tagInputValue}
                      onChange={(e) => setTagInputValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleCreateAndAddTag();
                        if (e.key === "Escape") {
                          setTagInputOpen(false);
                          setTagInputValue("");
                        }
                      }}
                      placeholder={t("notes.newTag", "New tag")}
                      className="w-20 px-2 py-0.5 text-xs rounded border border-border bg-transparent focus:outline-none focus:border-accent"
                    />
                    {availableTags.length > 0 && (
                      <div className="flex gap-1">
                        {availableTags.slice(0, 3).map((tag) => (
                          <button
                            key={tag.id}
                            onClick={() => {
                              handleAddTag(tag.id);
                              setTagInputOpen(false);
                            }}
                            className="px-1.5 py-0.5 rounded text-xs bg-accent-soft text-text-secondary hover:text-text transition-colors"
                            style={tag.color ? { backgroundColor: `${tag.color}20`, color: tag.color } : undefined}
                          >
                            {tag.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <button
                    onClick={() => setTagInputOpen(true)}
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs text-text-secondary hover:bg-accent-soft transition-colors"
                  >
                    <Tag size={10} />
                    <Plus size={10} />
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
        <div className="max-w-3xl mx-auto overflow-hidden break-words">

          {/* Content area */}
          {hasEnhanced && viewMode === "enhanced" ? (
            <>
              {enhanceLoading && (
                <div className="flex items-center gap-2 text-xs text-text-secondary pt-2">
                  <Loader2 size={14} className="animate-spin" />
                  {t("sessions.enhancing")}
                </div>
              )}
              {enhanceError && !enhanceLoading && (
                <div className="text-xs pt-2">
                  <p className="text-red-400">{t("sessions.enhanceError")}</p>
                  <p className="text-xs text-text-secondary mt-1">{enhanceError}</p>
                </div>
              )}
              {enhancedJSON && !enhanceLoading && (
                <NotesEditor
                  content=""
                  onChange={() => { }}
                  mode="enhanced"
                  initialJSON={enhancedJSON}
                  onJSONChange={handleEnhancedJSONChange}
                  onEditorReady={handleEditorReady}
                />
              )}
            </>
          ) : (
            <>
              {/* Summary display */}
              {summaryLoading && (
                <div className="flex items-center gap-2 text-xs text-text-secondary mb-5">
                  <Loader2 size={14} className="animate-spin" />
                  {t("sessions.summaryLoading")}
                </div>
              )}
              {summaryError && !summaryLoading && (
                <div className="text-xs mb-5">
                  <p className="text-red-400">{t("sessions.summaryError")}</p>
                  <p className="text-xs text-text-secondary mt-1">{summaryError}</p>
                </div>
              )}
              {summary && !summaryLoading && (
                <div className="mb-6 text-xs whitespace-pre-wrap leading-relaxed text-text">
                  {summary}
                </div>
              )}

              {/* Notes editor */}
              <NotesEditor
                content={notesLoaded ? userNotes : ""}
                onChange={onNotesChange}
                disabled={!notesLoaded}
                placeholder={t("sessions.notesPlaceholder")}
                onEditorReady={handleEditorReady}
              />
            </>
          )}
        </div>
      </div>

      {/* Floating recording panel — always show for any note */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 w-full max-w-2xl px-4">
        <div className="bg-background border border-border-strong rounded-2xl shadow-sm overflow-hidden">
          {/* Expandable area — transcript or chat */}
          {panelOpen && (
            <div className="border-b border-border">
              {/* Tab switcher */}
              <div className="flex items-center gap-1 px-4 pt-2 pb-0">
                <button
                  onClick={() => setPanelMode("transcript")}
                  className={`text-[11px] font-medium px-2 py-1 rounded-md transition-colors ${panelMode === "transcript" ? "bg-text/8 text-text" : "text-text-secondary/50 hover:text-text-secondary"}`}
                >
                  {t("sessions.chat.transcriptTab")}
                </button>
                <button
                  onClick={() => setPanelMode("chat")}
                  className={`text-[11px] font-medium px-2 py-1 rounded-md transition-colors ${panelMode === "chat" ? "bg-text/8 text-text" : "text-text-secondary/50 hover:text-text-secondary"}`}
                >
                  {t("sessions.chat.chatTab")}
                  {chat.messages.length > 0 && (
                    <span className="ml-1 text-[10px] text-text-secondary/40">
                      {chat.messages.length}
                    </span>
                  )}
                </button>
                {panelMode === "transcript" && transcript.length > 0 && (
                  <button
                    onClick={handleCopyTranscript}
                    className="p-1 rounded-md text-text-secondary/50 hover:text-text-secondary transition-colors"
                    title={t("sessions.copyTranscript")}
                  >
                    {transcriptCopied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
                  </button>
                )}
                {panelMode === "chat" && chat.messages.length > 0 && (
                  <button
                    onClick={chat.clearMessages}
                    className="p-1 rounded-md text-text-secondary/50 hover:text-text-secondary transition-colors"
                    title={t("sessions.chat.newChat")}
                  >
                    <RotateCcw size={12} />
                  </button>
                )}
                <button
                  onClick={() => setPanelOpen(false)}
                  className="ml-auto p-1 rounded-md text-text-secondary/50 hover:text-text-secondary transition-colors"
                >
                  <ChevronDown size={12} />
                </button>
              </div>

              {/* Panel content */}
              <div className="max-h-64 overflow-y-auto px-5 pt-2 pb-2">
                {panelMode === "transcript" ? (
                  <>
                    {transcript.length === 0 ? (
                      <p data-ui className="text-xs text-text-secondary py-2">
                        {t("sessions.noTranscript")}
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {transcript.map((seg) => (
                          <div key={seg.id} className="flex gap-3 text-xs">
                            <span
                              data-ui
                              className="text-xs text-text-secondary/50 shrink-0 pt-0.5 w-9 text-right tabular-nums"
                            >
                              {formatMs(seg.start_ms)}
                            </span>
                            <span
                              data-ui
                              className={`text-xs shrink-0 pt-0.5 w-8 ${seg.source === "mic" ? "text-blue-500" : "text-text-secondary/50"}`}
                            >
                              {seg.source === "mic" ? t("sessions.sourceMe") : t("sessions.sourceThem")}
                            </span>
                            <span className="text-xs leading-relaxed text-text">
                              {seg.text}
                            </span>
                          </div>
                        ))}
                        <div ref={transcriptEndRef} />
                      </div>
                    )}
                  </>
                ) : (
                  <div className="space-y-2 min-h-[60px]">
                    {chat.messages.map((msg, i) => (
                      <MessageBubble key={i} message={msg} />
                    ))}
                    {chat.isLoading &&
                      chat.messages[chat.messages.length - 1]?.role !== "assistant" && (
                        <div className="flex items-center gap-1.5 text-xs text-text-secondary">
                          <Loader2 size={12} className="animate-spin" />
                          {t("sessions.chat.thinking")}
                        </div>
                      )}
                    {chat.error && (
                      <div className="text-xs text-red-400 px-1 py-1">
                        {chat.error}
                      </div>
                    )}
                    <div ref={chatEndRef} />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Consent warning */}
          {isRecording && (
            <div className="px-3 pt-1.5 pb-0">
              <p className="text-xs text-text-secondary/50 text-center">
                {t("sessions.consentWarning")}
              </p>
            </div>
          )}

          {/* Bottom bar */}
          <div data-ui className="flex items-center gap-2 px-3 py-2">
            {/* Left: audio icon + chevron + stop */}
            <div className="flex items-center gap-0.5 shrink-0">
              <button
                onClick={() => setPanelOpen(!panelOpen)}
                className={`flex items-center gap-0.5 p-1.5 rounded-md transition-colors hover:bg-text/8 ${isRecording ? "text-green-500" : "text-text-secondary/60"}`}
              >
                {(() => {
                  const cy = 12;
                  if (isRecording) {
                    const amp = Math.max(amplitude.mic, amplitude.speaker) / 1000;
                    const clamped = Math.min(Math.max(amp * 3, 0), 1);
                    const minH = 4;
                    const maxH = 16;
                    const h1 = minH + clamped * (maxH - minH) * 0.7;
                    const h2 = minH + clamped * (maxH - minH);
                    const h3 = minH + clamped * (maxH - minH) * 0.5;
                    return (
                      <svg width="22" height="22" viewBox="0 0 24 24">
                        <rect x="4" y={cy - h1 / 2} width="3" height={h1} rx="1.5" fill="currentColor" style={{ transition: "y 0.1s ease, height 0.1s ease" }} />
                        <rect x="10.5" y={cy - h2 / 2} width="3" height={h2} rx="1.5" fill="currentColor" style={{ transition: "y 0.1s ease, height 0.1s ease" }} />
                        <rect x="17" y={cy - h3 / 2} width="3" height={h3} rx="1.5" fill="currentColor" style={{ transition: "y 0.1s ease, height 0.1s ease" }} />
                      </svg>
                    );
                  }
                  return (
                    <svg width="22" height="22" viewBox="0 0 24 24">
                      <rect x="4" y={cy - 5} width="3" height={10} rx="1.5" fill="currentColor" />
                      <rect x="10.5" y={cy - 7} width="3" height={14} rx="1.5" fill="currentColor" />
                      <rect x="17" y={cy - 4} width="3" height={8} rx="1.5" fill="currentColor" />
                    </svg>
                  );
                })()}
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

            {/* Center: chat input */}
            {session && (
              <div className="flex-1 flex items-center gap-1.5 min-w-0">
                <input
                  ref={chatInputRef}
                  type="text"
                  data-ui
                  value={chat.input}
                  onChange={(e) => chat.setInput(e.target.value)}
                  onKeyDown={handleChatKeyDown}
                  onFocus={() => {
                    chat.handleInputFocus();
                  }}
                  placeholder={t("sessions.chat.placeholder")}
                  className="flex-1 text-xs bg-transparent outline-none placeholder:text-text-secondary min-w-0"
                />
                {chat.isLoading ? (
                  <button
                    onClick={chat.stop}
                    className="p-1 rounded-md text-text-secondary/50 hover:text-text-secondary transition-colors shrink-0"
                  >
                    <X size={14} />
                  </button>
                ) : (
                  chat.input.trim() && (
                    <button
                      onClick={handleChatSubmit}
                      className="p-1 rounded-md text-accent hover:text-accent/70 transition-colors shrink-0"
                    >
                      <Send size={14} />
                    </button>
                  )
                )}
              </div>
            )}

            {/* Right: resume / start recording / enhance */}
            <div className="flex items-center gap-3 shrink-0">
              {!isRecording && (
                <button
                  onClick={onStartRecording}
                  className="text-xs font-medium text-accent hover:text-accent/70 transition-colors whitespace-nowrap"
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
                    className="flex items-center gap-1.5 text-xs font-medium text-accent hover:text-accent/70 transition-colors whitespace-nowrap"
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

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-lg px-2.5 py-1.5 text-xs leading-relaxed ${isUser
          ? "bg-accent/10 text-text"
          : "bg-background-secondary text-text"
          }`}
      >
        {isUser ? (
          <span className="whitespace-pre-wrap select-text cursor-text">{message.content}</span>
        ) : message.content ? (
          <div className="select-text cursor-text [&_ul]:list-disc [&_ul]:ml-4 [&_ol]:list-decimal [&_ol]:ml-4 [&_li]:my-0.5 [&_p]:my-1 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_strong]:font-semibold [&_code]:bg-background/50 [&_code]:px-1 [&_code]:rounded">
            <ReactMarkdown>{message.content}</ReactMarkdown>
          </div>
        ) : (
          <Loader2 size={12} className="animate-spin text-text-secondary" />
        )}
      </div>
    </div>
  );
}
