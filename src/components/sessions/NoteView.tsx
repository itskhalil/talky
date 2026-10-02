import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import { useTranslation } from "react-i18next";
import {
  ChevronUp,
  ChevronDown,
  Square,
  Sparkles,
  Loader,
  Copy,
  Check,
  Send,
  X,
  RotateCcw,
  PenLine,
  List,
  FolderIcon,
  Plus,
  Globe,
  Search,
  Paperclip,
  Lock,
  ArrowUp,
  MoreHorizontal,
  RefreshCw,
  AlignLeft,
} from "lucide-react";
import { NotesEditor } from "./NotesEditor";
import { FindBar } from "./FindBar";
import {
  AttachmentsRow,
  MAX_ATTACHMENTS,
  type AttachmentsRowHandle,
} from "./AttachmentsRow";
import { MetaPicker } from "./MetaPicker";
import { MeetingChip } from "./MeetingChip";
import { ImageLightbox } from "@/components/ui/ImageLightbox";
import { WaveformBars } from "@/components/ui/WaveformBars";
import { useAttachments } from "@/stores/sessionStore";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useGlobalChat, type ChatMessage } from "@/hooks/useGlobalChat";
import { useSettings } from "@/hooks/useSettings";
import { useOrganizationStore } from "@/stores/organizationStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useSessionStore } from "@/stores/sessionStore";
import { useNoteUiIntentStore } from "@/stores/noteUiIntentStore";
import { JSONContent, Editor } from "@tiptap/core";
import type { Tag as TagType } from "@/bindings";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { normalizeAttachmentFilename } from "@/utils/attachmentFilename";
import {
  parseInlineContent as parseInline,
  inlineToMarkdown,
  stripNoteTags,
} from "@/utils/markdownParser";

/**
 * Wrapper around parseInlineContent that returns a space placeholder for empty content.
 * This ensures TipTap nodes render correctly even when text is empty.
 */
function parseInlineContent(text: string): JSONContent[] {
  const result = parseInline(text);
  return result.length > 0 ? result : [{ type: "text", text: " " }];
}

interface Session {
  id: string;
  title: string;
  started_at: number;
  ended_at: number | null;
  status: string;
  folder_id: string | null;
  environment_id: string | null;
  calendar_event_id: string | null;
  transcript_wiped_at: number | null;
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
  enhancedNotesEdited: boolean;
  showEnhancePrompt: boolean;
  onNotesChange: (notes: string) => void;
  onEnhancedNotesChange?: (tagged: string) => void;
  onTitleChange: (title: string) => void;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onGenerateSummary: () => void;
  onEnhanceNotes: () => void;
  onDismissEnhancePrompt: () => void;
  enhanceLoading: boolean;
  enhanceError: string | null;
  viewMode: "notes" | "enhanced";
  onViewModeChange: (mode: "notes" | "enhanced") => void;
  findBarOpen?: boolean;
  showReplace?: boolean;
  onCloseFindBar?: () => void;
  // Streaming props
  streamingEnhancedNotes?: string | null;
  enhanceStreaming?: boolean;
}

function highlightName(text: string, regex: RegExp): React.ReactNode {
  const parts = text.split(regex);
  if (parts.length === 1) return text;
  const matches = text.match(new RegExp(regex.source, "gi")) || [];
  return parts.reduce<React.ReactNode[]>((acc, part, i) => {
    acc.push(part);
    if (i < matches.length) {
      acc.push(
        <mark
          key={i}
          className="bg-yellow-500/20 text-inherit rounded-sm px-0.5"
        >
          {matches[i]}
        </mark>,
      );
    }
    return acc;
  }, []);
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
 * Parse enhanced notes (tagged markdown with [ai]/[noted] markers) into
 * a tiptap JSON document with `source` attributes on each block.
 */
export function parseEnhancedToTiptapJSON(content: string): JSONContent {
  const lines = content.split("\n");
  const nodes: JSONContent[] = [];

  // Log warnings for unsupported patterns
  if (content.includes("######")) {
    console.warn(
      "[enhance-notes] Found h6 heading (unsupported) - will become paragraph",
    );
  }
  if (content.includes("STRIKE")) {
    console.warn(
      "[enhance-notes] Found STRIKE text - possible LLM artifact",
      content.slice(
        Math.max(0, content.indexOf("STRIKE") - 20),
        content.indexOf("STRIKE") + 30,
      ),
    );
  }

  // For lines without a tag (headers), inherit from next tagged line
  const parsed = lines.map((line) => {
    const isAi = /\[ai\]/.test(line);
    const isUser = /\[noted\]/.test(line);
    const cleaned = line
      .replace(/\*{0,2}\[(?:noted|ai)\]\*{0,2} /g, "")
      .replace(/\*{4}/g, "");
    return { cleaned, isAi, isUser, hasTag: isAi || isUser };
  });

  // Inherit source for untagged lines from the NEXT tagged line
  for (let i = 0; i < parsed.length; i++) {
    if (!parsed[i].hasTag) {
      // Find the next tagged line
      const nextTagged = parsed.slice(i + 1).find((p) => p.hasTag);
      if (nextTagged) {
        parsed[i].isAi = nextTagged.isAi;
      }
      // If no next tagged line, keep the default (false = noted)
    }
  }

  let i = 0;
  while (i < parsed.length) {
    const { cleaned, isAi } = parsed[i];
    const trimmed = cleaned.trimStart();
    const source = isAi ? "ai" : "noted";

    // Preserve empty lines as empty paragraphs
    if (trimmed === "") {
      nodes.push({ type: "paragraph", attrs: { source }, content: [] });
      i++;
      continue;
    }

    // Skip horizontal rules/dividers (---, ***, ___)
    if (/^[-*_]{3,}$/.test(trimmed)) {
      i++;
      continue;
    }

    // Heading - support h1-h6, clamp to h4 max for TipTap
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)/);
    if (headingMatch) {
      const level = Math.min(headingMatch[1].length, 4);
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

    // Ordered list: collect consecutive numbered lines with nesting support
    if (trimmed.match(/^\d+\.\s/)) {
      const orderedList = parseOrderedList(parsed, i);
      nodes.push(orderedList.node);
      i = orderedList.endIndex;
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
  baseIndent: number = 0,
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
        // Adjust baseIndent to match this bullet's indentation
        baseIndent = indentLevel;
        const source = parsed[i].isAi ? "ai" : "noted";
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
      continue;
    }

    // Same indent level - add to current list
    const source = parsed[i].isAi ? "ai" : "noted";
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

/**
 * Parse ordered list with nesting support.
 * Nested bullet/ordered sublists are detected by indentation (2 spaces = 1 level).
 */
function parseOrderedList(
  parsed: ParsedLine[],
  startIndex: number,
  baseIndent: number = 0,
): { node: JSONContent; endIndex: number } {
  const listItems: JSONContent[] = [];
  let i = startIndex;

  while (i < parsed.length) {
    const line = parsed[i].cleaned;
    const leadingSpaces = line.length - line.trimStart().length;
    const indentLevel = Math.floor(leadingSpaces / 2);
    const trimmed = line.trimStart();
    const orderedMatch = trimmed.match(/^\d+\.\s+(.*)/);

    if (!orderedMatch) break;
    if (indentLevel < baseIndent) break;

    if (indentLevel > baseIndent) {
      if (listItems.length > 0) {
        const nested = parseOrderedList(parsed, i, indentLevel);
        listItems[listItems.length - 1].content!.push(nested.node);
        i = nested.endIndex;
      } else {
        baseIndent = indentLevel;
        const source = parsed[i].isAi ? "ai" : "noted";
        listItems.push({
          type: "listItem",
          attrs: { source },
          content: [
            {
              type: "paragraph",
              attrs: { source },
              content: parseInlineContent(orderedMatch[1]),
            },
          ],
        });
        i++;
      }
      continue;
    }

    const source = parsed[i].isAi ? "ai" : "noted";
    const item: JSONContent = {
      type: "listItem",
      attrs: { source },
      content: [
        {
          type: "paragraph",
          attrs: { source },
          content: parseInlineContent(orderedMatch[1]),
        },
      ],
    };
    listItems.push(item);
    i++;

    // Collect indented sublists (bullet or ordered) that belong to this item
    while (i < parsed.length) {
      const nextLine = parsed[i].cleaned;
      const nextSpaces = nextLine.length - nextLine.trimStart().length;
      const nextIndent = Math.floor(nextSpaces / 2);
      const nextTrimmed = nextLine.trimStart();

      if (nextIndent <= baseIndent) break;

      if (nextTrimmed.match(/^-\s/)) {
        const nested = parseBulletList(parsed, i, nextIndent);
        item.content!.push(nested.node);
        i = nested.endIndex;
      } else if (nextTrimmed.match(/^\d+\.\s/)) {
        const nested = parseOrderedList(parsed, i, nextIndent);
        item.content!.push(nested.node);
        i = nested.endIndex;
      } else {
        break;
      }
    }
  }

  return {
    node: { type: "orderedList", content: listItems },
    endIndex: i,
  };
}

/**
 * Serialize tiptap JSON back to tagged markdown for storage.
 */
export function serializeTiptapToTagged(json: JSONContent): string {
  if (!json.content) return "";
  const lines: string[] = [];

  for (const node of json.content) {
    const source = node.attrs?.source ?? "noted";
    const tag = `[${source}]`;

    if (node.type === "heading") {
      const level = node.attrs?.level ?? 2;
      const hashes = "#".repeat(level);
      const text = inlineToMarkdown(node.content);
      lines.push(`${hashes} ${text}`);
    } else if (node.type === "bulletList" && node.content) {
      serializeBulletList(node, lines, 0);
    } else if (node.type === "orderedList" && node.content) {
      serializeOrderedList(node, lines, 0);
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
  depth: number,
): void {
  if (!node.content) return;
  const indent = "  ".repeat(depth);

  for (const li of node.content) {
    const liSource = li.attrs?.source ?? "noted";
    const liTag = `[${liSource}]`;

    // Find paragraph and nested lists in the list item
    const para = li.content?.find((c) => c.type === "paragraph");
    const nestedList = li.content?.find(
      (c) => c.type === "bulletList" || c.type === "orderedList",
    );

    const text = para ? inlineToMarkdown(para.content) : "";
    lines.push(`${liTag} ${indent}- ${text}`);

    if (nestedList) {
      if (nestedList.type === "orderedList") {
        serializeOrderedList(nestedList, lines, depth + 1);
      } else {
        serializeBulletList(nestedList, lines, depth + 1);
      }
    }
  }
}

/**
 * Recursively serialize an ordered list with proper indentation.
 */
function serializeOrderedList(
  node: JSONContent,
  lines: string[],
  depth: number,
): void {
  if (!node.content) return;
  const indent = "  ".repeat(depth);

  let counter = 1;
  for (const li of node.content) {
    const liSource = li.attrs?.source ?? "noted";
    const liTag = `[${liSource}]`;

    const para = li.content?.find((c) => c.type === "paragraph");
    const nestedList = li.content?.find(
      (c) => c.type === "bulletList" || c.type === "orderedList",
    );

    const text = para ? inlineToMarkdown(para.content) : "";
    lines.push(`${liTag} ${indent}${counter}. ${text}`);
    counter++;

    if (nestedList) {
      if (nestedList.type === "orderedList") {
        serializeOrderedList(nestedList, lines, depth + 1);
      } else {
        serializeBulletList(nestedList, lines, depth + 1);
      }
    }
  }
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
  enhancedNotesEdited,
  showEnhancePrompt,
  onNotesChange,
  onEnhancedNotesChange,
  onTitleChange,
  onStartRecording,
  onStopRecording,
  onGenerateSummary,
  onEnhanceNotes,
  onDismissEnhancePrompt,
  enhanceLoading,
  enhanceError,
  viewMode,
  onViewModeChange,
  findBarOpen,
  showReplace,
  onCloseFindBar,
  streamingEnhancedNotes,
  enhanceStreaming,
}: NoteViewProps) {
  const { t } = useTranslation();
  const { getSetting } = useSettings();
  const copyAsBulletsEnabled = getSetting("copy_as_bullets_enabled") ?? false;
  const transcriptClearingEnabled =
    getSetting("transcript_clearing_enabled") ?? false;
  const attachments = useAttachments();
  const refreshAttachments = useSessionStore((s) => s.refreshAttachments);
  const clearTranscript = useSessionStore((s) => s.clearTranscript);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const imageAttachments = useMemo(
    () => attachments.filter((a) => a.mime_type.startsWith("image/")),
    [attachments],
  );
  const [panelOpen, setPanelOpen] = useState(false);
  const [showReenhanceWarning, setShowReenhanceWarning] = useState(false);
  const [showClearTranscriptDialog, setShowClearTranscriptDialog] =
    useState(false);
  const isSealed = !!session?.transcript_wiped_at;
  const canClearTranscript =
    transcriptClearingEnabled &&
    !!session &&
    !isSealed &&
    !!enhancedNotes &&
    !enhanceLoading &&
    !enhanceStreaming &&
    !isRecording;
  const transcriptClearedDate = session?.transcript_wiped_at
    ? new Date(session.transcript_wiped_at * 1000).toLocaleDateString(
        undefined,
        { year: "numeric", month: "short", day: "numeric" },
      )
    : "";
  const transcriptClearedDateShort = session?.transcript_wiped_at
    ? new Date(session.transcript_wiped_at * 1000).toLocaleDateString(
        undefined,
        { month: "short", day: "numeric" },
      )
    : "";
  const [panelMode, setPanelMode] = useState<"transcript" | "chat">(
    "transcript",
  );
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
  const [envDropdownOpen, setEnvDropdownOpen] = useState(false);
  const [sessionTags, setSessionTags] = useState<TagType[]>([]);
  const [tagInputOpen, setTagInputOpen] = useState(false);
  const [transcriptSearchOpen, setTranscriptSearchOpen] = useState(false);
  const [transcriptSearchQuery, setTranscriptSearchQuery] = useState("");
  const [transcriptCurrentMatch, setTranscriptCurrentMatch] = useState(0);
  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  const transcriptSearchInputRef = useRef<HTMLInputElement>(null);
  const [localFolderId, setLocalFolderId] = useState<string | null>(
    session?.folder_id ?? null,
  );
  const envDropdownRef = useRef<HTMLDivElement>(null);
  const attachmentsRowRef = useRef<AttachmentsRowHandle>(null);

  const folderPickerTick = useNoteUiIntentStore((s) => s.folderPickerTick);
  const tagInputTick = useNoteUiIntentStore((s) => s.tagInputTick);
  const attachmentPickerTick = useNoteUiIntentStore(
    (s) => s.attachmentPickerTick,
  );
  const lastFolderTick = useRef(folderPickerTick);
  const lastTagTick = useRef(tagInputTick);
  const lastAttachmentTick = useRef(attachmentPickerTick);

  useEffect(() => {
    if (folderPickerTick !== lastFolderTick.current) {
      lastFolderTick.current = folderPickerTick;
      setFolderDropdownOpen(true);
    }
  }, [folderPickerTick]);

  useEffect(() => {
    if (tagInputTick !== lastTagTick.current) {
      lastTagTick.current = tagInputTick;
      setTagInputOpen(true);
    }
  }, [tagInputTick]);

  useEffect(() => {
    if (attachmentPickerTick !== lastAttachmentTick.current) {
      lastAttachmentTick.current = attachmentPickerTick;
      attachmentsRowRef.current?.openPicker();
    }
  }, [attachmentPickerTick]);

  // Get environments from settings store
  const { settings } = useSettingsStore();
  const environments = settings?.model_environments || [];
  const defaultEnvId = settings?.default_environment_id;
  const { updateSessionEnvironment } = useSessionStore();

  // Only show environment selector if there are 2+ environments
  const showEnvSelector = environments.length >= 2;
  const currentEnv = environments.find(
    (e) => e.id === (session?.environment_id ?? defaultEnvId),
  );

  const {
    folders,
    tags: allTags,
    moveSessionToFolder,
    getSessionTags,
    addTagToSession,
    removeTagFromSession,
    createTag,
    createFolder,
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

  // Close environment dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        envDropdownRef.current &&
        !envDropdownRef.current.contains(e.target as Node)
      ) {
        setEnvDropdownOpen(false);
      }
    };
    if (envDropdownOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () =>
        document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [envDropdownOpen]);

  const handleEnvSelect = async (envId: string) => {
    if (session?.id) {
      await updateSessionEnvironment(session.id, envId);
    }
    setEnvDropdownOpen(false);
  };

  // Drag & drop file handling for attachments
  const [isDraggingFile, setIsDraggingFile] = useState(false);

  useEffect(() => {
    if (!session?.id) return;

    const sessionId = session.id;
    const supportedExtensions = ["pdf", "jpg", "jpeg", "png", "gif", "webp"];

    const getMimeType = (filename: string): string => {
      const ext = filename.toLowerCase().split(".").pop() || "";
      switch (ext) {
        case "pdf":
          return "application/pdf";
        case "jpg":
        case "jpeg":
          return "image/jpeg";
        case "png":
          return "image/png";
        case "gif":
          return "image/gif";
        case "webp":
          return "image/webp";
        default:
          return "application/octet-stream";
      }
    };

    const isSupported = (path: string): boolean => {
      const ext = path.toLowerCase().split(".").pop() || "";
      return supportedExtensions.includes(ext);
    };

    const unlisten = getCurrentWindow().onDragDropEvent(async (event) => {
      if (event.payload.type === "over") {
        setIsDraggingFile(true);
      } else if (event.payload.type === "leave") {
        setIsDraggingFile(false);
      } else if (event.payload.type === "drop") {
        setIsDraggingFile(false);
        const paths = event.payload.paths;
        const validPaths = paths.filter(isSupported);

        if (validPaths.length === 0 && paths.length > 0) {
          toast.error(t("sessions.attachments.unsupportedType"));
          return;
        }

        for (const path of validPaths) {
          const rawFilename = path.split(/[/\\]/).pop() || "file";
          const filename = normalizeAttachmentFilename(rawFilename);
          const mimeType = getMimeType(rawFilename);

          try {
            const attachment = await invoke<{ id: string; mime_type: string }>(
              "add_attachment",
              { sessionId, sourcePath: path, filename, mimeType },
            );

            // Extract PDF text in background
            if (attachment.mime_type === "application/pdf") {
              invoke("extract_pdf_text", {
                attachmentId: attachment.id,
              }).catch((e) => console.warn("PDF extraction failed:", e));
            }
          } catch (e) {
            console.error("Failed to add attachment:", e);
            toast.error(t("sessions.attachments.uploadError"));
          }
        }

        refreshAttachments(sessionId);
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [session?.id, refreshAttachments, t]);

  const handlePasteImage = useCallback(
    async (file: File) => {
      if (!session?.id) return;

      const allowedTypes = [
        "image/jpeg",
        "image/png",
        "image/gif",
        "image/webp",
      ];
      if (!allowedTypes.includes(file.type)) {
        toast.error(t("sessions.attachments.unsupportedType"));
        return;
      }

      if (attachments.length >= MAX_ATTACHMENTS) {
        toast.error(
          t("sessions.attachments.tooManyFiles", { count: MAX_ATTACHMENTS }),
        );
        return;
      }

      const maxSize = 25 * 1024 * 1024;
      if (file.size > maxSize) {
        toast.error(t("sessions.attachments.fileTooLarge", { size: "25 MB" }));
        return;
      }

      const ext =
        file.type.split("/")[1] === "jpeg" ? "jpg" : file.type.split("/")[1];
      const filename = `paste-${(attachments.length + 1).toString().padStart(3, "0")}.${ext}`;

      try {
        const buffer = await file.arrayBuffer();
        const data = Array.from(new Uint8Array(buffer));
        await invoke("add_attachment_from_bytes", {
          sessionId: session.id,
          data,
          filename,
          mimeType: file.type,
        });
        refreshAttachments(session.id);
        toast.success(t("sessions.attachments.pastedImage"));
      } catch (e) {
        console.error("Failed to paste image:", e);
        toast.error(t("sessions.attachments.uploadError"));
      }
    },
    [session?.id, attachments.length, refreshAttachments, t],
  );

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

  const currentFolder = folders.find((f) => f.id === localFolderId);

  const handleEditorReady = useCallback((editor: Editor | null) => {
    setActiveEditor(editor);
  }, []);

  const getCleanedNotesText = (): string => {
    if (viewMode === "enhanced" && enhancedNotes) {
      return stripNoteTags(enhancedNotes);
    }
    return userNotes;
  };

  const handleCopyNotes = async () => {
    const text = getCleanedNotesText();

    // Get HTML from editor for rich copy.
    // TipTap wraps text inside <li> with <p> tags which breaks Slack's paste
    // handler (nested bullets get flattened). Unwrap them for compatibility.
    const rawHtml = activeEditor?.getHTML() ?? "";
    const doc = new DOMParser().parseFromString(rawHtml, "text/html");
    doc.querySelectorAll("li > p").forEach((p) => {
      const li = p.parentElement!;
      while (p.firstChild) {
        li.insertBefore(p.firstChild, p);
      }
      p.remove();
    });
    const html = doc.body.innerHTML;

    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([text], { type: "text/plain" }),
        }),
      ]);
    } catch {
      // Fallback to plain text if HTML copy fails
      await navigator.clipboard.writeText(text);
    }

    setNotesCopied(true);
    setTimeout(() => setNotesCopied(false), 1500);
  };

  const handleCopyAsBullets = async () => {
    const formatted = formatNotesForLogseq(getCleanedNotesText());
    await navigator.clipboard.writeText(formatted);
    setBulletsCopied(true);
    setTimeout(() => setBulletsCopied(false), 1500);
  };

  const handleCopyTranscript = async () => {
    const text = transcript
      .map((seg) => {
        const label = seg.source === "mic" ? "[User]" : "[Other]";
        const mins = Math.floor(seg.start_ms / 60000);
        const secs = Math.floor((seg.start_ms % 60000) / 1000);
        return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")} ${label} ${seg.text}`;
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
  const prevPanelMode = useRef(panelMode);
  useEffect(() => {
    if (panelOpen && panelMode === "transcript") {
      const justOpened = !panelWasOpen.current;
      const justSwitchedToTranscript = prevPanelMode.current !== "transcript";
      transcriptEndRef.current?.scrollIntoView({
        behavior: justOpened || justSwitchedToTranscript ? "instant" : "smooth",
      });
    }
    panelWasOpen.current = panelOpen;
    prevPanelMode.current = panelMode;
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

  // Compute streaming JSON for TipTap rendering during enhance streaming
  // Strip inline reasoning preamble (before ---NOTES--- delimiter) so it's never shown
  const streamingJSON = useMemo(() => {
    if (enhanceStreaming && streamingEnhancedNotes) {
      const delimiter = "---NOTES---";
      const idx = streamingEnhancedNotes.indexOf(delimiter);
      const notesText =
        idx >= 0
          ? streamingEnhancedNotes.slice(idx + delimiter.length).trimStart()
          : null;
      if (!notesText) return null;
      return parseEnhancedToTiptapJSON(notesText);
    }
    return null;
  }, [enhanceStreaming, streamingEnhancedNotes]);

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

  // Re-adjust title height after fonts load (Geist swaps in after system-ui)
  useEffect(() => {
    document.fonts.ready.then(() => {
      adjustTextareaHeight();
    });
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

  const userName = settings?.user_name?.trim();

  // Regex for whole-word, case-insensitive match of the user's name (for transcript highlighting)
  const userNameRegex = useMemo(() => {
    if (!userName) return null;
    try {
      const escaped = userName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`\\b${escaped}\\b`, "i");
    } catch {
      return null;
    }
  }, [userName]);

  // Compute total search matches across all transcript segments
  const totalMatches = useMemo(() => {
    if (!transcriptSearchQuery) return 0;
    const query = transcriptSearchQuery.toLowerCase();
    let count = 0;
    for (const seg of transcript) {
      const text = seg.text.toLowerCase();
      let idx = 0;
      while ((idx = text.indexOf(query, idx)) !== -1) {
        count++;
        idx += query.length;
      }
    }
    return count;
  }, [transcript, transcriptSearchQuery]);

  // Reset current match when query changes
  useEffect(() => {
    setTranscriptCurrentMatch(0);
  }, [transcriptSearchQuery]);

  // Scroll current match into view
  useEffect(() => {
    if (!transcriptSearchQuery || totalMatches === 0) return;
    const container = transcriptScrollRef.current;
    if (!container) return;
    const marks = container.querySelectorAll(
      ".transcript-search-highlight--current",
    );
    if (marks.length > 0) {
      marks[0].scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [transcriptCurrentMatch, transcriptSearchQuery, totalMatches]);

  // Focus search input when opening
  useEffect(() => {
    if (transcriptSearchOpen && transcriptSearchInputRef.current) {
      transcriptSearchInputRef.current.focus();
    }
  }, [transcriptSearchOpen]);

  const handleTranscriptSearchPrev = useCallback(() => {
    setTranscriptCurrentMatch((prev) =>
      totalMatches === 0 ? 0 : (prev - 1 + totalMatches) % totalMatches,
    );
  }, [totalMatches]);

  const handleTranscriptSearchNext = useCallback(() => {
    setTranscriptCurrentMatch((prev) =>
      totalMatches === 0 ? 0 : (prev + 1) % totalMatches,
    );
  }, [totalMatches]);

  const handleTranscriptSearchClose = useCallback(() => {
    setTranscriptSearchOpen(false);
    setTranscriptSearchQuery("");
    setTranscriptCurrentMatch(0);
  }, []);

  /**
   * Highlight search matches in transcript text.
   * `startIndex` is the cumulative match count from prior segments.
   */
  const highlightSearch = useCallback(
    (
      text: string,
      query: string,
      startIndex: number,
      currentMatch: number,
    ): React.ReactNode => {
      if (!query) return text;
      const lowerText = text.toLowerCase();
      const lowerQuery = query.toLowerCase();
      const parts: React.ReactNode[] = [];
      let lastEnd = 0;
      let matchIdx = startIndex;

      let pos = 0;
      while ((pos = lowerText.indexOf(lowerQuery, pos)) !== -1) {
        if (pos > lastEnd) {
          parts.push(text.slice(lastEnd, pos));
        }
        const isCurrent = matchIdx === currentMatch;
        parts.push(
          <mark
            key={`search-${matchIdx}`}
            className={`transcript-search-highlight${isCurrent ? " transcript-search-highlight--current" : ""}`}
          >
            {text.slice(pos, pos + query.length)}
          </mark>,
        );
        lastEnd = pos + query.length;
        pos = lastEnd;
        matchIdx++;
      }
      if (lastEnd < text.length) {
        parts.push(text.slice(lastEnd));
      }
      return parts.length > 0 ? parts : text;
    },
    [],
  );

  const getTranscriptText = useCallback(() => {
    return transcript
      .map((seg) => {
        const label = seg.source === "mic" ? "[User]" : "[Other]";
        return `[${formatMs(seg.start_ms)}] ${label}: ${seg.text}`;
      })
      .join("\n");
  }, [transcript]);

  const getUserNotesText = useCallback(() => {
    return userNotes;
  }, [userNotes]);

  // Recorded time is stored in the transcript: on resume, new segments
  // continue from the last segment's end, so the latest end_ms is the total
  // time recorded so far (pauses excluded).
  const recordedMs = useMemo(
    () => transcript.reduce((max, seg) => Math.max(max, seg.end_ms), 0),
    [transcript],
  );
  const [run, setRun] = useState<{ since: number; baseMs: number } | null>(
    null,
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isRecording) {
      setRun(null);
      return;
    }
    // Capture the total at the moment this run starts; segments arriving
    // during the run are already covered by the run's own clock.
    setRun((r) => r ?? { since: Date.now(), baseMs: recordedMs });
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isRecording]);
  const elapsedLabel = (() => {
    const ms = run ? run.baseMs + Math.max(0, now - run.since) : recordedMs;
    const secs = Math.floor(ms / 1000);
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const sec = secs % 60;
    const mm = String(m).padStart(2, "0");
    const ss = String(sec).padStart(2, "0");
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  })();
  const lengthLabel = (() => {
    const mins = Math.max(1, Math.round(recordedMs / 60000));
    const h = Math.floor(mins / 60);
    return h > 0
      ? t("sessions.lengthHours", { hours: h, minutes: mins % 60 })
      : t("sessions.lengthMinutes", { count: mins });
  })();

  // Rare, post-meeting actions live in the header's ⋯ menu.
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!moreMenuOpen) return;
    const handle = (e: MouseEvent) => {
      if (
        moreMenuRef.current &&
        !moreMenuRef.current.contains(e.target as Node)
      )
        setMoreMenuOpen(false);
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [moreMenuOpen]);

  // Ask about this note, or across every note in this note's environment.
  const [chatScope, setChatScope] = useState<"note" | "all">("note");
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  const scopeMenuRef = useRef<HTMLDivElement>(null);
  const effectiveEnvId =
    session?.environment_id ?? defaultEnvId ?? environments[0]?.id ?? null;
  const chat = useGlobalChat(
    chatScope === "note"
      ? {
          currentNoteId: session?.id ?? "",
          getCurrentTranscript: getTranscriptText,
          getCurrentNotes: getUserNotesText,
          environmentId: session?.environment_id,
          filterEnvironmentId: session?.environment_id,
        }
      : { environmentId: effectiveEnvId, filterEnvironmentId: effectiveEnvId },
  );
  const scopeLabel =
    chatScope === "note"
      ? t("sessions.chat.scopeNote")
      : showEnvSelector && currentEnv
        ? t("sessions.chat.scopeAllEnv", { env: currentEnv.name })
        : t("sessions.chat.scopeAll");
  const chooseScope = (scope: "note" | "all") => {
    if (scope !== chatScope) chat.clearMessages();
    setChatScope(scope);
    setScopeMenuOpen(false);
    chatInputRef.current?.focus();
  };

  useEffect(() => {
    if (!scopeMenuOpen) return;
    const handle = (e: MouseEvent) => {
      if (
        scopeMenuRef.current &&
        !scopeMenuRef.current.contains(e.target as Node)
      )
        setScopeMenuOpen(false);
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [scopeMenuOpen]);

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

  const handleWhatDidIMiss = useCallback(() => {
    setPanelOpen(true);
    setPanelMode("chat");
    chat.handleSubmit(
      "I lost focus for a moment during this meeting. Quickly scan the latest portion of the transcript and get me back on track.\n- Skip any preamble and go straight to the summary\n- Only cover what was just discussed, not earlier topics\n- Keep it to 1-3 bullet points max\n- Avoid using direct quotes\n- Make sure to include the last thing that was said\n- Be brief—I need to rejoin the conversation seamlessly",
    );
  }, [chat]);

  const hasTranscript = transcript.length > 0;
  // Enhance is the one obvious next step after a meeting, so it lives in the bar.
  const canEnhanceFirst =
    !isRecording &&
    hasTranscript &&
    !enhanceLoading &&
    !enhanceStreaming &&
    !isSealed &&
    !enhancedNotes;
  const canReenhance =
    !isRecording &&
    hasTranscript &&
    !enhanceLoading &&
    !enhanceStreaming &&
    !isSealed &&
    !!enhancedNotes;
  const hasEnhanced =
    enhancedNotes != null ||
    enhanceLoading ||
    enhanceError != null ||
    enhanceStreaming;

  // Header stamp: the facts about this meeting, read-only.
  const stampLabel = (() => {
    if (!session) return "";
    const start = new Date(session.started_at * 1000);
    const parts = [
      start.toLocaleDateString(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
        ...(start.getFullYear() !== new Date().getFullYear()
          ? { year: "numeric" }
          : {}),
      }),
      start.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }),
    ];
    if (recordedMs > 0 && !isRecording) parts.push(lengthLabel);
    return parts.join(" · ");
  })();
  const chipClass =
    "inline-flex items-center gap-1.5 h-6 px-2 rounded-md border border-border text-xs text-text hover:border-border-strong transition-colors";
  const ghostClass =
    "inline-flex items-center gap-1 h-6 px-1.5 rounded-md text-xs text-mid-gray hover:bg-accent/5 hover:text-text-secondary transition-colors";

  const handleCreateFolder = async (name: string) => {
    const folder = await createFolder(name);
    if (folder) await handleFolderSelect(folder.id);
  };

  const handleCreateTag = async (name: string) => {
    if (!session?.id) return;
    const newTag = await createTag(name);
    if (newTag) await handleAddTag(newTag.id);
  };

  return (
    <div className="flex flex-col h-full relative">
      {/* File drop overlay */}
      {isDraggingFile && (
        <div className="absolute inset-0 z-50 bg-black/20 rounded-lg flex items-center justify-center pointer-events-none">
          <div className="bg-background px-4 py-2 rounded-lg shadow-lg text-sm text-text">
            {t("sessions.attachments.addFiles")}
          </div>
        </div>
      )}
      {/* Titlebar band: window controls (and the sidebar toggle when it's
          collapsed) sit here, so the panel below never moves. */}
      <div data-tauri-drag-region className="h-8 shrink-0" />
      {/* The note itself: a framed panel on the ground */}
      <div className="flex-1 min-h-0 flex flex-col relative mr-2 mb-2 ml-[var(--panel-left,0px)] bg-background border border-border rounded-lg overflow-hidden">
        {/* Panel header: the note's own controls */}
        <div
          data-tauri-drag-region
          className="h-10 shrink-0 flex items-center gap-1.5 pl-4 pr-2 border-b border-border"
        >
          {/* Stamp: when the meeting happened and how long it ran */}
          {session && (
            <span
              data-tauri-drag-region
              className="font-display text-label uppercase text-text-secondary truncate min-w-0"
            >
              {stampLabel}
            </span>
          )}

          <span data-tauri-drag-region className="flex-1 self-stretch" />
          {hasEnhanced && (
            <div className="flex p-0.5 rounded-md border border-border">
              <button
                onClick={() => onViewModeChange("notes")}
                className={`h-6 px-2 rounded text-xs transition-colors ${viewMode === "notes" ? "bg-accent/8 text-text" : "text-text-secondary hover:text-text"}`}
                title={t("sessions.yourNotes")}
              >
                {t("sessions.viewNotes")}
              </button>
              <button
                onClick={() => onViewModeChange("enhanced")}
                className={`h-6 px-2 rounded text-xs transition-colors ${viewMode === "enhanced" ? "bg-accent/8 text-text" : "text-text-secondary hover:text-text"}`}
                title={t("sessions.enhancedNotes")}
              >
                {t("sessions.viewEnhanced")}
              </button>
            </div>
          )}
          {canReenhance && (
            <button
              onClick={() => {
                if (enhancedNotesEdited) {
                  setShowReenhanceWarning(true);
                } else {
                  onDismissEnhancePrompt();
                  onEnhanceNotes();
                }
              }}
              className="w-7 h-7 flex items-center justify-center rounded-md text-text-secondary hover:bg-accent/8 hover:text-text transition-colors"
              title={t("sessions.reenhance")}
              aria-label={t("sessions.reenhance")}
            >
              <RefreshCw size={14} />
            </button>
          )}
          <button
            onClick={handleCopyNotes}
            className="w-7 h-7 flex items-center justify-center rounded-md text-text-secondary hover:bg-accent/8 hover:text-text transition-colors"
            title={t("sessions.copyNotes")}
            aria-label={t("sessions.copyNotes")}
          >
            {notesCopied ? <Check size={15} /> : <Copy size={15} />}
          </button>
          <div ref={moreMenuRef} className="relative">
            <button
              onClick={() => setMoreMenuOpen((o) => !o)}
              aria-label={t("sessions.moreActions")}
              title={t("sessions.moreActions")}
              className={`w-7 h-7 flex items-center justify-center rounded-md text-text-secondary hover:bg-accent/8 hover:text-text transition-colors ${moreMenuOpen ? "bg-accent/8 text-text" : ""}`}
            >
              <MoreHorizontal size={15} />
            </button>
            {moreMenuOpen && (
              <div className="absolute right-0 top-full mt-1 z-30 min-w-[200px] p-1 bg-background border border-border-strong rounded-lg shadow-lg">
                <button
                  onClick={() => {
                    setMoreMenuOpen(false);
                    attachmentsRowRef.current?.openPicker();
                  }}
                  className="flex items-center gap-2 w-full h-[30px] px-2.5 rounded-md text-left text-ui text-text hover:bg-accent/5"
                >
                  <Paperclip size={13} className="text-text-secondary" />
                  {t("sessions.attachments.attachFile")}
                </button>
                {copyAsBulletsEnabled && (
                  <button
                    onClick={() => {
                      setMoreMenuOpen(false);
                      handleCopyAsBullets();
                    }}
                    className="flex items-center gap-2 w-full h-[30px] px-2.5 rounded-md text-left text-ui text-text hover:bg-accent/5"
                  >
                    <List size={13} className="text-text-secondary" />
                    {t("sessions.copyAsBullets")}
                  </button>
                )}
                {canClearTranscript && (
                  <button
                    onClick={() => {
                      setMoreMenuOpen(false);
                      setShowClearTranscriptDialog(true);
                    }}
                    className="flex items-center gap-2 w-full h-[30px] px-2.5 rounded-md text-left text-ui text-text hover:bg-accent/5"
                  >
                    <Lock size={13} className="text-text-secondary" />
                    {t("sessions.clearTranscript")}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
        {findBarOpen && onCloseFindBar && (
          <div className="absolute top-2 right-4 z-20 w-80">
            <FindBar
              editor={activeEditor}
              onClose={onCloseFindBar}
              showReplace={showReplace}
              editable={activeEditor?.isEditable ?? false}
            />
          </div>
        )}
        <div
          ref={scrollContainerRef}
          className="flex-1 overflow-y-scroll overflow-x-hidden px-6 md:px-12 pt-6 pb-10 w-full cursor-text select-text"
        >
          {/* Editable title */}
          <div className="max-w-3xl mx-auto mb-4">
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
              className="w-full text-title leading-tight font-normal tracking-[-0.03em] bg-transparent border-none outline-none placeholder:text-mid-gray/30 pr-16 resize-none overflow-hidden p-0"
            />

            {/* Filing line: environment, folder and tags. Facts (date,
                length) live in the header stamp; files sit at the end. */}
            {session && (
              <div
                className={`flex items-center gap-1.5 mt-3 flex-wrap ${!showEnvSelector && !currentFolder ? "-ml-1.5" : ""}`}
              >
                {showEnvSelector && (
                  <div ref={envDropdownRef} className="relative">
                    <button
                      onClick={() => setEnvDropdownOpen(!envDropdownOpen)}
                      title={t("sessions.meta.environment")}
                      className={chipClass}
                    >
                      <span
                        className="w-1.5 h-1.5 rounded-full"
                        style={{
                          backgroundColor: currentEnv?.color || "#6b7280",
                        }}
                      />
                      {currentEnv?.name ?? t("sessions.environment")}
                      <ChevronDown size={11} className="text-text-secondary" />
                    </button>
                    {envDropdownOpen && (
                      <div className="absolute top-full left-0 mt-1 bg-background border border-border-strong rounded-lg shadow-lg z-30 min-w-[160px] p-1">
                        {environments.map((env) => (
                          <button
                            key={env.id}
                            onClick={() => handleEnvSelect(env.id)}
                            className="w-full h-[30px] px-2.5 rounded-md text-left text-ui text-text hover:bg-accent/5 flex items-center gap-2"
                          >
                            <span
                              className="w-1.5 h-1.5 rounded-full"
                              style={{ backgroundColor: env.color }}
                            />
                            <span className="flex-1">{env.name}</span>
                            {env.id === currentEnv?.id && <Check size={13} />}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Folder: one per note */}
                <div className="relative">
                  {currentFolder ? (
                    <button
                      onClick={() => setFolderDropdownOpen((o) => !o)}
                      title={t("sessions.meta.folder")}
                      className={chipClass}
                    >
                      <FolderIcon
                        size={12}
                        className="text-text-secondary"
                        style={
                          currentFolder.color
                            ? { color: currentFolder.color }
                            : undefined
                        }
                      />
                      {currentFolder.name}
                    </button>
                  ) : (
                    <button
                      onClick={() => setFolderDropdownOpen((o) => !o)}
                      className={ghostClass}
                    >
                      <Plus size={12} />
                      {t("sessions.meta.addFolder")}
                    </button>
                  )}
                  {folderDropdownOpen && (
                    <MetaPicker
                      items={folders.map((f) => ({
                        id: f.id,
                        label: f.name,
                        color: f.color,
                      }))}
                      selectedIds={localFolderId ? [localFolderId] : []}
                      multi={false}
                      label={t("sessions.meta.folder")}
                      placeholder={t("sessions.meta.folderPlaceholder")}
                      onPick={(id) => void handleFolderSelect(id)}
                      onCreate={(name) => void handleCreateFolder(name)}
                      clearLabel={
                        currentFolder
                          ? t("sessions.meta.removeFromFolder")
                          : undefined
                      }
                      onClear={
                        currentFolder
                          ? () => void handleFolderSelect(null)
                          : undefined
                      }
                      onClose={() => setFolderDropdownOpen(false)}
                      renderIcon={(item) => (
                        <FolderIcon
                          size={12}
                          className="shrink-0 text-text-secondary"
                          style={item.color ? { color: item.color } : undefined}
                        />
                      )}
                    />
                  )}
                </div>

                {/* Tags: any number */}
                {sessionTags.map((tag) => (
                  <span key={tag.id} className={`group ${chipClass} pr-1`}>
                    <span
                      className="text-mid-gray"
                      style={tag.color ? { color: tag.color } : undefined}
                    >
                      #
                    </span>
                    {tag.name}
                    <button
                      onClick={() => void handleRemoveTag(tag.id)}
                      aria-label={t("sessions.meta.removeTag")}
                      title={t("sessions.meta.removeTag")}
                      className="w-4 h-4 flex items-center justify-center rounded text-text-secondary opacity-0 group-hover:opacity-100 hover:text-text"
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
                <div className="relative">
                  <button
                    onClick={() => setTagInputOpen((o) => !o)}
                    title={t("sessions.meta.tagPlaceholder")}
                    className={ghostClass}
                  >
                    <Plus size={12} />
                    {sessionTags.length === 0 && t("sessions.meta.addTag")}
                  </button>
                  {tagInputOpen && (
                    <MetaPicker
                      items={allTags.map((tg) => ({
                        id: tg.id,
                        label: tg.name,
                        color: tg.color,
                      }))}
                      selectedIds={sessionTags.map((st) => st.id)}
                      multi
                      label={t("sessions.meta.tags")}
                      placeholder={t("sessions.meta.tagPlaceholder")}
                      onPick={(id) =>
                        void (sessionTags.some((st) => st.id === id)
                          ? handleRemoveTag(id)
                          : handleAddTag(id))
                      }
                      onCreate={(name) => void handleCreateTag(name)}
                      onClose={() => setTagInputOpen(false)}
                      renderIcon={(item) => (
                        <span
                          className="w-3 shrink-0 text-center text-mid-gray"
                          style={item.color ? { color: item.color } : undefined}
                        >
                          #
                        </span>
                      )}
                    />
                  )}
                </div>

                {/* Who was in the meeting, from the calendar */}
                <MeetingChip
                  sessionId={session.id}
                  startedAt={session.started_at}
                  calendarEventId={session.calendar_event_id}
                />
              </div>
            )}
          </div>
          <div className="max-w-3xl mx-auto overflow-hidden break-words">
            {/* Content area */}
            {hasEnhanced && viewMode === "enhanced" ? (
              <>
                {/* Show loading spinner until notes content starts streaming (after ---NOTES--- delimiter) */}
                {enhanceLoading && !streamingJSON && (
                  <div className="flex items-center gap-2 text-xs text-text-secondary pt-2">
                    <Loader size={16} className="animate-spin-slow" />
                    {t("sessions.enhancing")}
                  </div>
                )}
                {/* Show streaming text progressively using TipTap */}
                {enhanceStreaming && streamingJSON && (
                  <NotesEditor
                    content=""
                    onChange={() => {}}
                    mode="enhanced"
                    disabled={true}
                    initialJSON={streamingJSON}
                  />
                )}
                {enhanceError && !enhanceLoading && (
                  <div className="text-xs pt-2">
                    <p className="text-red-400">{t("sessions.enhanceError")}</p>
                    <p className="text-xs text-text-secondary mt-1">
                      {enhanceError}
                    </p>
                  </div>
                )}
                {enhancedJSON && !enhanceLoading && !enhanceStreaming && (
                  <NotesEditor
                    content=""
                    onChange={() => {}}
                    mode="enhanced"
                    initialJSON={enhancedJSON}
                    onJSONChange={handleEnhancedJSONChange}
                    onEditorReady={handleEditorReady}
                    onPasteImage={handlePasteImage}
                  />
                )}
              </>
            ) : (
              <>
                {/* Summary display */}
                {summaryLoading && (
                  <div className="flex items-center gap-2 text-xs text-text-secondary mb-5">
                    <Loader size={16} className="animate-spin-slow" />
                    {t("sessions.summaryLoading")}
                  </div>
                )}
                {summaryError && !summaryLoading && (
                  <div className="text-xs mb-5">
                    <p className="text-red-400">{t("sessions.summaryError")}</p>
                    <p className="text-xs text-text-secondary mt-1">
                      {summaryError}
                    </p>
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
                  onPasteImage={handlePasteImage}
                />
              </>
            )}
            {/* Files: attachments are content (Enhance reads them), so they
                sit at the end of the note like email attachments. */}
            {session && (
              <AttachmentsRow
                ref={attachmentsRowRef}
                sessionId={session.id}
                attachments={attachments}
                onAttachmentsChange={() => refreshAttachments(session.id)}
              />
            )}
          </div>
        </div>

        {/* The bar: record, transcript, ask. It sits in the page flow, so opening
          the transcript shrinks the notes rather than covering them. */}
        <div className="shrink-0 w-full max-w-3xl mx-auto px-4 pt-2 pb-4 flex gap-2 items-end">
          <div className="flex-1 min-w-0 bg-background border border-border-strong rounded-lg shadow-[0_1px_2px_rgba(0,0,0,0.04),0_6px_20px_rgba(0,0,0,0.06)] overflow-hidden">
            {/* Expandable area — transcript or chat */}
            {panelOpen && (
              <div className="border-b border-border">
                {/* Tab switcher */}
                <div className="flex items-center gap-1 px-4 pt-2 pb-1.5">
                  <button
                    onClick={() => setPanelMode("transcript")}
                    className={`font-display text-label uppercase px-2 py-1 rounded-md transition-colors ${panelMode === "transcript" ? "bg-text/8 text-text" : "text-text-secondary/60 hover:text-text-secondary"}`}
                  >
                    {t("sessions.chat.transcriptTab")}
                  </button>
                  <button
                    onClick={() => setPanelMode("chat")}
                    className={`font-display text-label uppercase px-2 py-1 rounded-md transition-colors ${panelMode === "chat" ? "bg-text/8 text-text" : "text-text-secondary/60 hover:text-text-secondary"}`}
                  >
                    {t("sessions.chat.chatTab")}
                    {chat.messages.length > 0 && (
                      <span className="ml-1 text-label text-text-secondary/40">
                        {chat.messages.length}
                      </span>
                    )}
                  </button>
                  {panelMode === "transcript" && transcript.length > 0 && (
                    <>
                      <button
                        onClick={() => {
                          setTranscriptSearchOpen((prev) => !prev);
                          if (transcriptSearchOpen) {
                            handleTranscriptSearchClose();
                          }
                        }}
                        className={`p-1 rounded-md transition-colors ${transcriptSearchOpen ? "text-text bg-text/8" : "text-text-secondary/50 hover:text-text-secondary"}`}
                        title={t("sessions.searchTranscript")}
                      >
                        <Search size={12} />
                      </button>
                      <button
                        onClick={handleCopyTranscript}
                        className="p-1 rounded-md text-text-secondary/50 hover:text-text-secondary transition-colors"
                        title={t("sessions.copyTranscript")}
                      >
                        {transcriptCopied ? (
                          <Check size={12} className="text-green-500" />
                        ) : (
                          <Copy size={12} />
                        )}
                      </button>
                    </>
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
                    <ChevronDown size={14} />
                  </button>
                </div>

                {/* Transcript search bar */}
                {transcriptSearchOpen && panelMode === "transcript" && (
                  <div className="flex items-center gap-1.5 px-4 py-1.5 border-b border-border bg-text/[0.02]">
                    <Search
                      size={12}
                      className="text-text-secondary/50 shrink-0"
                    />
                    <input
                      ref={transcriptSearchInputRef}
                      type="text"
                      value={transcriptSearchQuery}
                      onChange={(e) => setTranscriptSearchQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          if (e.shiftKey) {
                            handleTranscriptSearchPrev();
                          } else {
                            handleTranscriptSearchNext();
                          }
                        }
                        if (e.key === "Escape") {
                          handleTranscriptSearchClose();
                        }
                      }}
                      placeholder={t("sessions.searchTranscript")}
                      className="flex-1 text-xs bg-transparent outline-none placeholder:text-text-secondary/40 min-w-0"
                    />
                    <span className="text-label text-text-secondary/50 tabular-nums shrink-0">
                      {transcriptSearchQuery
                        ? totalMatches > 0
                          ? `${transcriptCurrentMatch + 1} / ${totalMatches}`
                          : t("sessions.noSearchMatches")
                        : ""}
                    </span>
                    <button
                      onClick={handleTranscriptSearchPrev}
                      disabled={totalMatches === 0}
                      className="p-0.5 rounded text-text-secondary/50 hover:text-text-secondary transition-colors disabled:opacity-30"
                    >
                      <ChevronUp size={12} />
                    </button>
                    <button
                      onClick={handleTranscriptSearchNext}
                      disabled={totalMatches === 0}
                      className="p-0.5 rounded text-text-secondary/50 hover:text-text-secondary transition-colors disabled:opacity-30"
                    >
                      <ChevronDown size={12} />
                    </button>
                    <button
                      onClick={handleTranscriptSearchClose}
                      className="p-0.5 rounded text-text-secondary/50 hover:text-text-secondary transition-colors"
                    >
                      <X size={12} />
                    </button>
                  </div>
                )}

                {/* Panel content */}
                <div
                  ref={transcriptScrollRef}
                  className="max-h-[38vh] overflow-y-auto px-5 pt-2 pb-2 select-text"
                >
                  {panelMode === "transcript" ? (
                    <>
                      {isSealed ? (
                        <p
                          data-ui
                          className="text-xs text-text-secondary py-2 whitespace-pre-line"
                        >
                          {t("sessions.transcriptClearedPlaceholder", {
                            date: transcriptClearedDate,
                          })}
                        </p>
                      ) : transcript.length === 0 ? (
                        <p data-ui className="text-xs text-text-secondary py-2">
                          {t("sessions.noTranscript")}
                        </p>
                      ) : (
                        <div className="space-y-2">
                          {transcript.map((seg, segIdx) => {
                            // Count matches in prior segments for startIndex
                            let startIndex = 0;
                            if (transcriptSearchQuery) {
                              const q = transcriptSearchQuery.toLowerCase();
                              for (let i = 0; i < segIdx; i++) {
                                const txt = transcript[i].text.toLowerCase();
                                let idx = 0;
                                while ((idx = txt.indexOf(q, idx)) !== -1) {
                                  startIndex++;
                                  idx += q.length;
                                }
                              }
                            }

                            return (
                              <div key={seg.id} className="flex gap-3 text-xs">
                                <span
                                  data-ui
                                  className="font-mono text-label text-mid-gray shrink-0 pt-0.5 w-9 text-right select-none"
                                >
                                  {formatMs(seg.start_ms)}
                                </span>
                                <span
                                  data-ui
                                  className={`text-xs shrink-0 pt-0.5 w-8 select-none ${seg.source === "mic" ? "text-text font-medium" : "text-text-secondary"}`}
                                >
                                  {seg.source === "mic"
                                    ? t("sessions.sourceMe")
                                    : t("sessions.sourceThem")}
                                </span>
                                <span className="text-xs leading-relaxed text-text">
                                  {transcriptSearchQuery
                                    ? highlightSearch(
                                        seg.text,
                                        transcriptSearchQuery,
                                        startIndex,
                                        transcriptCurrentMatch,
                                      )
                                    : userNameRegex && seg.source !== "mic"
                                      ? highlightName(seg.text, userNameRegex)
                                      : seg.text}
                                </span>
                              </div>
                            );
                          })}
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
                        chat.messages[chat.messages.length - 1]?.role !==
                          "assistant" && (
                          <div className="flex items-center gap-1.5 text-xs text-text-secondary">
                            <Loader size={16} className="animate-spin-slow" />
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
            <div data-ui className="flex items-center px-3 h-[50px]">
              {/* Section 1: recording and transcript */}
              <div className="flex items-center gap-1 shrink-0">
                {isRecording ? (
                  <>
                    <button
                      onClick={() => setPanelOpen(!panelOpen)}
                      title={t("sessions.chat.transcriptTab")}
                      aria-label={t("sessions.chat.transcriptTab")}
                      className={`flex items-center gap-2 h-8 pl-2 pr-1 rounded-md text-mid-gray transition-colors ${panelOpen ? "bg-accent/8" : "hover:bg-accent/5"}`}
                    >
                      <span className="w-2 h-2 rounded-full bg-live" />
                      <span className="font-mono text-xs text-text-secondary">
                        {elapsedLabel}
                      </span>
                      <WaveformBars amplitude={amplitude} isRecording={true} />
                    </button>
                    <button
                      onClick={onStopRecording}
                      title={t("sessions.stopRecording")}
                      aria-label={t("sessions.stopRecording")}
                      className="w-7 h-7 flex items-center justify-center rounded-md text-text-secondary hover:bg-accent/8 hover:text-text transition-colors"
                    >
                      <Square size={11} fill="currentColor" />
                    </button>
                  </>
                ) : (
                  <>
                    {!isSealed && (
                      <button
                        onClick={onStartRecording}
                        className="flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-border text-xs text-text hover:border-border-strong transition-colors whitespace-nowrap"
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-live" />
                        {hasTranscript
                          ? t("sessions.resumeRecording")
                          : t("sessions.startRecording")}
                      </button>
                    )}
                    {isSealed ? (
                      <button
                        onClick={() => setPanelOpen(!panelOpen)}
                        title={t("sessions.transcriptClearedPlaceholder", {
                          date: transcriptClearedDate,
                        })}
                        className={`flex items-center gap-1.5 h-8 px-2.5 rounded-md text-xs text-text-secondary whitespace-nowrap transition-colors ${panelOpen ? "bg-accent/8 text-text" : "hover:bg-accent/5 hover:text-text"}`}
                      >
                        <Lock size={12} />
                        {t("sessions.sealedBadge", {
                          date: transcriptClearedDateShort,
                        })}
                      </button>
                    ) : (
                      hasTranscript && (
                        <button
                          onClick={() => setPanelOpen(!panelOpen)}
                          title={t("sessions.chat.transcriptTab")}
                          aria-label={t("sessions.chat.transcriptTab")}
                          className={`w-8 h-8 flex items-center justify-center rounded-md text-text-secondary transition-colors ${panelOpen ? "bg-accent/8 text-text" : "hover:bg-accent/5 hover:text-text"}`}
                        >
                          <AlignLeft size={15} />
                        </button>
                      )
                    )}
                  </>
                )}
              </div>

              <span className="w-px h-4 bg-border mx-3 shrink-0" />

              {/* Section 2: Chat */}
              {session && (
                <div className="flex-1 flex items-center gap-2 min-w-0">
                  <input
                    ref={chatInputRef}
                    type="text"
                    data-ui
                    data-chat-input
                    value={chat.input}
                    onChange={(e) => chat.setInput(e.target.value)}
                    onKeyDown={handleChatKeyDown}
                    onFocus={() => {
                      chat.handleInputFocus();
                    }}
                    placeholder={
                      chatScope === "note"
                        ? t("sessions.chat.placeholderNote")
                        : showEnvSelector && currentEnv
                          ? t("sessions.chat.placeholderAllEnv", {
                              env: currentEnv.name,
                            })
                          : t("sessions.chat.placeholderAll")
                    }
                    className="flex-1 text-ui bg-transparent outline-none placeholder:text-mid-gray min-w-0"
                  />
                  <div ref={scopeMenuRef} className="relative shrink-0">
                    <button
                      onClick={() => setScopeMenuOpen((o) => !o)}
                      aria-label={t("sessions.chat.scopeMenu")}
                      className={`flex items-center gap-1.5 h-7 px-2 rounded-md border text-xs text-text-secondary whitespace-nowrap transition-colors ${
                        scopeMenuOpen
                          ? "border-border-strong bg-accent/5"
                          : "border-border hover:border-border-strong"
                      }`}
                    >
                      {chatScope === "all" && showEnvSelector && currentEnv && (
                        <span
                          className="w-1.5 h-1.5 rounded-full"
                          style={{ backgroundColor: currentEnv.color }}
                        />
                      )}
                      <span>{scopeLabel}</span>
                      <ChevronDown size={11} />
                    </button>
                    {scopeMenuOpen && (
                      <div className="absolute bottom-full right-0 mb-2 z-30 w-[290px] p-1 bg-background border border-border-strong rounded-lg shadow-lg">
                        {(["note", "all"] as const).map((scope) => (
                          <button
                            key={scope}
                            onClick={() => chooseScope(scope)}
                            className={`flex items-center gap-2 w-full h-[30px] px-2.5 rounded-md text-left text-ui text-text ${
                              chatScope === scope
                                ? "bg-accent/8"
                                : "hover:bg-accent/5"
                            }`}
                          >
                            {scope === "all" &&
                              showEnvSelector &&
                              currentEnv && (
                                <span
                                  className="w-1.5 h-1.5 rounded-full"
                                  style={{ backgroundColor: currentEnv.color }}
                                />
                              )}
                            <span className="flex-1">
                              {scope === "note"
                                ? t("sessions.chat.scopeNote")
                                : showEnvSelector && currentEnv
                                  ? t("sessions.chat.scopeAllEnv", {
                                      env: currentEnv.name,
                                    })
                                  : t("sessions.chat.scopeAll")}
                            </span>
                            {chatScope === scope && <Check size={13} />}
                          </button>
                        ))}
                        {showEnvSelector && currentEnv && (
                          <p className="px-2.5 pt-2 pb-1.5 mt-1 border-t border-border text-xs leading-snug text-text-secondary">
                            {t("sessions.chat.scopeFootnote", {
                              env: currentEnv.name,
                            })}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                  {chat.isLoading ? (
                    <button
                      onClick={chat.stop}
                      className="p-1 rounded-md text-text-secondary/50 hover:text-text-secondary transition-colors shrink-0"
                    >
                      <X size={16} />
                    </button>
                  ) : (
                    <>
                      {chat.input.trim() ? (
                        <button
                          onClick={handleChatSubmit}
                          aria-label={t("sessions.chat.send")}
                          className="w-[30px] h-[30px] flex items-center justify-center rounded-md bg-background-ui text-white border border-background-ui dark:border-border-strong shrink-0"
                        >
                          <ArrowUp size={15} strokeWidth={2.2} />
                        </button>
                      ) : (
                        canEnhanceFirst && (
                          <button
                            onClick={() => {
                              onDismissEnhancePrompt();
                              onEnhanceNotes();
                            }}
                            className="flex items-center gap-1.5 h-8 px-3 rounded-md bg-background-ui text-white text-xs font-medium border border-background-ui dark:border-border-strong whitespace-nowrap shrink-0"
                          >
                            <Sparkles size={13} />
                            {t("sessions.enhanceNotes")}
                          </button>
                        )
                      )}
                    </>
                  )}
                  {isRecording && hasTranscript && (
                    <button
                      onClick={handleWhatDidIMiss}
                      className="h-7 px-2.5 text-xs text-text border border-border rounded-md hover:border-border-strong transition-colors whitespace-nowrap shrink-0"
                    >
                      {t("sessions.chat.whatDidIMiss")}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Re-enhance warning dialog */}
        <ConfirmDialog
          open={showReenhanceWarning}
          title={t("sessions.reenhanceWarningTitle")}
          message={t("sessions.reenhanceWarningMessage")}
          confirmLabel={t("common.continue")}
          variant="warning"
          onConfirm={() => {
            setShowReenhanceWarning(false);
            onDismissEnhancePrompt();
            onEnhanceNotes();
          }}
          onCancel={() => setShowReenhanceWarning(false)}
        />

        {/* Clear transcript confirmation dialog */}
        <ConfirmDialog
          open={showClearTranscriptDialog}
          title={t("sessions.clearTranscriptTitle")}
          message={t("sessions.clearTranscriptMessage")}
          confirmLabel={t("sessions.clearTranscriptConfirm")}
          variant="danger"
          onConfirm={async () => {
            setShowClearTranscriptDialog(false);
            if (session) {
              try {
                await clearTranscript(session.id);
              } catch (e) {
                console.error("Failed to clear transcript:", e);
              }
            }
          }}
          onCancel={() => setShowClearTranscriptDialog(false)}
        />

        {/* Image lightbox */}
        {lightboxIndex !== null && (
          <ImageLightbox
            images={imageAttachments}
            initialIndex={lightboxIndex}
            onClose={() => setLightboxIndex(null)}
          />
        )}
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const { t } = useTranslation();
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-lg px-2.5 py-1.5 text-xs leading-relaxed ${
          isUser
            ? "bg-accent/10 text-text"
            : "bg-background-secondary text-text"
        }`}
      >
        {isUser ? (
          <span className="whitespace-pre-wrap select-text cursor-text">
            {message.content}
          </span>
        ) : message.content ? (
          <div className="select-text cursor-text [&_ul]:list-disc [&_ul]:ml-4 [&_ol]:list-decimal [&_ol]:ml-4 [&_li]:my-0.5 [&_p]:my-1 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_strong]:font-semibold [&_code]:bg-background/50 [&_code]:px-1 [&_code]:rounded">
            <ReactMarkdown>{message.content}</ReactMarkdown>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 text-text-secondary">
            <Loader size={16} className="animate-spin-slow" />
            {t("sessions.chat.thinking")}
          </div>
        )}
      </div>
    </div>
  );
}
