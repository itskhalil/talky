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
  Tag,
  Plus,
  Globe,
  Search,
  Paperclip,
  Lock,
} from "lucide-react";
import { NotesEditor } from "./NotesEditor";
import { FindBar } from "./FindBar";
import {
  AttachmentsRow,
  MAX_ATTACHMENTS,
  type AttachmentsRowHandle,
} from "./AttachmentsRow";
import { ImageLightbox } from "@/components/ui/ImageLightbox";
import { WaveformBars } from "@/components/ui/WaveformBars";
import { useAttachments } from "@/stores/sessionStore";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
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
  const [tagInputValue, setTagInputValue] = useState("");
  const [transcriptSearchOpen, setTranscriptSearchOpen] = useState(false);
  const [transcriptSearchQuery, setTranscriptSearchQuery] = useState("");
  const [transcriptCurrentMatch, setTranscriptCurrentMatch] = useState(0);
  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  const transcriptSearchInputRef = useRef<HTMLInputElement>(null);
  const [localFolderId, setLocalFolderId] = useState<string | null>(
    session?.folder_id ?? null,
  );
  const folderDropdownRef = useRef<HTMLDivElement>(null);
  const envDropdownRef = useRef<HTMLDivElement>(null);
  const tagInputRef = useRef<HTMLInputElement>(null);
  const attachmentsRowRef = useRef<AttachmentsRowHandle>(null);
  const [folderFilter, setFolderFilter] = useState("");
  const [activeFolderIndex, setActiveFolderIndex] = useState(0);
  const folderFilterInputRef = useRef<HTMLInputElement>(null);

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
      setFolderFilter("");
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
      if (
        folderDropdownRef.current &&
        !folderDropdownRef.current.contains(e.target as Node)
      ) {
        setFolderDropdownOpen(false);
      }
    };
    if (folderDropdownOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () =>
        document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [folderDropdownOpen]);

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

  // Focus tag input when opened
  useEffect(() => {
    if (tagInputOpen && tagInputRef.current) {
      tagInputRef.current.focus();
    }
  }, [tagInputOpen]);

  // Focus folder filter when dropdown opens
  useEffect(() => {
    if (folderDropdownOpen) {
      setActiveFolderIndex(0);
      folderFilterInputRef.current?.focus();
    } else {
      setFolderFilter("");
    }
  }, [folderDropdownOpen]);

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
  const availableTags = allTags.filter(
    (t) => !sessionTags.some((st) => st.id === t.id),
  );

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

  // Re-adjust title height after fonts load (Cabinet Grotesk swaps in after system-ui)
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

  const chat = useGlobalChat({
    currentNoteId: session?.id ?? "",
    getCurrentTranscript: getTranscriptText,
    getCurrentNotes: getUserNotesText,
    environmentId: session?.environment_id,
    filterEnvironmentId: session?.environment_id,
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

  const handleWhatDidIMiss = useCallback(() => {
    setPanelOpen(true);
    setPanelMode("chat");
    chat.handleSubmit(
      "I lost focus for a moment during this meeting. Quickly scan the latest portion of the transcript and get me back on track.\n- Skip any preamble and go straight to the summary\n- Only cover what was just discussed, not earlier topics\n- Keep it to 1-3 bullet points max\n- Avoid using direct quotes\n- Make sure to include the last thing that was said\n- Be brief—I need to rejoin the conversation seamlessly",
    );
  }, [chat]);

  const hasTranscript = transcript.length > 0;
  const hasEnhanced =
    enhancedNotes != null ||
    enhanceLoading ||
    enhanceError != null ||
    enhanceStreaming;

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
      {/* macOS title bar drag region */}
      <div data-tauri-drag-region className="h-7 w-full shrink-0" />
      {findBarOpen && onCloseFindBar && (
        <div className="absolute top-8 right-4 z-20 w-80">
          <FindBar
            editor={activeEditor}
            onClose={onCloseFindBar}
            showReplace={showReplace}
            editable={activeEditor?.isEditable ?? false}
          />
        </div>
      )}
      {/* Pinned toggle + copy controls */}
      <div className="absolute top-8 left-1/2 -translate-x-1/2 w-full max-w-3xl px-4 flex justify-end pointer-events-none z-10">
        <div className="flex items-center gap-1.5 pointer-events-auto">
          {hasEnhanced && (
            <div className="flex bg-background-sidebar rounded-lg p-0.5">
              <button
                onClick={() => onViewModeChange("enhanced")}
                className={`p-1.5 rounded-md transition-colors ${viewMode === "enhanced" ? "bg-background text-text shadow-sm" : "text-text-secondary/50 hover:text-text-secondary"}`}
                title={t("sessions.enhancedNotes")}
              >
                <Sparkles size={16} />
              </button>
              <button
                onClick={() => onViewModeChange("notes")}
                className={`p-1.5 rounded-md transition-colors ${viewMode === "notes" ? "bg-background text-text shadow-sm" : "text-text-secondary/50 hover:text-text-secondary"}`}
                title={t("sessions.yourNotes")}
              >
                <PenLine size={16} />
              </button>
            </div>
          )}
          <div className="flex items-center bg-background-sidebar rounded-lg p-0.5">
            <button
              onClick={handleCopyNotes}
              className="p-1.5 rounded-md text-text-secondary/40 hover:text-text-secondary transition-colors"
              title={t("sessions.copyNotes")}
            >
              {notesCopied ? (
                <Check size={16} className="text-green-500" />
              ) : (
                <Copy size={16} />
              )}
            </button>
            {copyAsBulletsEnabled && (
              <button
                onClick={handleCopyAsBullets}
                className="p-1.5 rounded-md text-text-secondary/40 hover:text-text-secondary transition-colors"
                title={t("sessions.copyAsBullets")}
              >
                {bulletsCopied ? (
                  <Check size={16} className="text-green-500" />
                ) : (
                  <List size={16} />
                )}
              </button>
            )}
          </div>
        </div>
      </div>
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-scroll overflow-x-hidden px-6 md:px-12 pt-2 pb-32 scroll-pb-24 w-full cursor-text select-text"
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
            className="w-full text-2xl leading-tight font-semibold bg-transparent border-none outline-none placeholder:text-mid-gray/30 tracking-tight pr-16 resize-none overflow-hidden font-display p-0"
          />

          {/* Metadata line: date, folder, tags, attachments, add buttons */}
          {session && (
            <div className="flex items-center gap-x-5 gap-y-2 mt-1.5 flex-wrap text-xs text-text-secondary">
              {/* Date + time */}
              <span>
                {new Date(session.started_at * 1000).toLocaleDateString(
                  undefined,
                  { month: "short", day: "numeric" },
                )}
                {", "}
                {new Date(session.started_at * 1000).toLocaleTimeString(
                  undefined,
                  { hour: "numeric", minute: "2-digit" },
                )}
              </span>

              {/* Environment selector - only show if 2+ environments */}
              {showEnvSelector && (
                <>
                  <div ref={envDropdownRef} className="relative">
                    <button
                      onClick={() => setEnvDropdownOpen(!envDropdownOpen)}
                      className="flex items-center gap-1 rounded-md hover:text-text transition-colors"
                    >
                      <span
                        className="w-1.5 h-1.5 rounded-full"
                        style={{
                          backgroundColor: currentEnv?.color || "#6b7280",
                        }}
                      />
                      <span>
                        {currentEnv?.name ?? t("sessions.environment")}
                      </span>
                    </button>
                    {envDropdownOpen && (
                      <div className="absolute top-full left-0 mt-1 bg-background border border-border rounded-lg shadow-lg z-20 min-w-[140px] py-1">
                        {environments.map((env) => (
                          <button
                            key={env.id}
                            onClick={() => handleEnvSelect(env.id)}
                            className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-accent/10 transition-colors flex items-center gap-2"
                          >
                            <span
                              className="w-2 h-2 rounded-full"
                              style={{ backgroundColor: env.color }}
                            />
                            {env.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* Folder selector */}
              <div ref={folderDropdownRef} className="relative">
                <button
                  onClick={() => setFolderDropdownOpen(!folderDropdownOpen)}
                  className="flex items-center gap-1 rounded-md hover:text-text transition-colors"
                >
                  <FolderIcon
                    size={11}
                    style={
                      currentFolder?.color
                        ? { color: currentFolder.color }
                        : undefined
                    }
                  />
                  <span>
                    {currentFolder?.name ?? t("notes.noFolder", "Notes")}
                  </span>
                </button>
                {folderDropdownOpen &&
                  (() => {
                    const q = folderFilter.trim().toLowerCase();
                    const filteredFolders = q
                      ? folders.filter((f) => f.name.toLowerCase().includes(q))
                      : folders;
                    const noFolderLabel = t("notes.noFolder", "Notes");
                    const showNoFolder =
                      !q || noFolderLabel.toLowerCase().includes(q);
                    type Option = {
                      id: string | null;
                      label: string;
                      color?: string | null;
                    };
                    const options: Option[] = [];
                    if (showNoFolder) {
                      options.push({ id: null, label: noFolderLabel });
                    }
                    for (const f of filteredFolders) {
                      options.push({ id: f.id, label: f.name, color: f.color });
                    }
                    const boundedIndex = Math.min(
                      activeFolderIndex,
                      Math.max(0, options.length - 1),
                    );
                    return (
                      <div className="absolute top-full left-0 mt-1 bg-background border border-border rounded-lg shadow-lg z-20 min-w-[180px] py-1">
                        <input
                          ref={folderFilterInputRef}
                          type="text"
                          value={folderFilter}
                          onChange={(e) => {
                            setFolderFilter(e.target.value);
                            setActiveFolderIndex(0);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "ArrowDown") {
                              e.preventDefault();
                              setActiveFolderIndex((i) =>
                                options.length === 0
                                  ? 0
                                  : (i + 1) % options.length,
                              );
                            } else if (e.key === "ArrowUp") {
                              e.preventDefault();
                              setActiveFolderIndex((i) =>
                                options.length === 0
                                  ? 0
                                  : (i - 1 + options.length) % options.length,
                              );
                            } else if (e.key === "Enter") {
                              e.preventDefault();
                              const pick = options[boundedIndex];
                              if (pick) handleFolderSelect(pick.id);
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              setFolderDropdownOpen(false);
                            }
                          }}
                          placeholder={t(
                            "notes.folderFilterPlaceholder",
                            "Filter folders",
                          )}
                          className="w-full px-3 py-1.5 text-xs bg-transparent border-b border-border text-text placeholder:text-text-secondary focus:outline-none"
                        />
                        {options.map((opt, i) => {
                          const isActive = i === boundedIndex;
                          return (
                            <button
                              key={opt.id ?? "__none__"}
                              onMouseEnter={() => setActiveFolderIndex(i)}
                              onClick={() => handleFolderSelect(opt.id)}
                              className={`w-full text-left px-3 py-1.5 text-xs text-text transition-colors flex items-center gap-2 ${
                                isActive ? "bg-accent/10" : ""
                              }`}
                            >
                              {opt.id !== null && (
                                <FolderIcon
                                  size={12}
                                  style={
                                    opt.color ? { color: opt.color } : undefined
                                  }
                                />
                              )}
                              {opt.label}
                            </button>
                          );
                        })}
                        {options.length === 0 && (
                          <div className="px-3 py-1.5 text-xs text-text-secondary">
                            {t("palette.empty")}
                          </div>
                        )}
                      </div>
                    );
                  })()}
              </div>

              {/* Tags (content — only rendered when they exist) */}
              {sessionTags.map((tag) => (
                <span key={tag.id} className="inline-flex items-center">
                  <span
                    className="hover:text-text transition-colors cursor-default group inline-flex items-center gap-1"
                    style={tag.color ? { color: tag.color } : undefined}
                  >
                    <Tag size={10} />
                    {tag.name}
                    <button
                      onClick={() => handleRemoveTag(tag.id)}
                      className="hidden group-hover:inline-flex hover:text-red-400"
                    >
                      <X size={10} />
                    </button>
                  </span>
                </span>
              ))}

              {/* Attachment names (content — only when attachments exist) */}
              {attachments.map((att) => (
                <span key={att.id} className="inline-flex items-center">
                  <span className="relative hover:text-text transition-colors cursor-default group/att inline-flex items-center gap-1">
                    <Paperclip size={10} />
                    <button
                      onClick={async () => {
                        if (att.mime_type.startsWith("image/")) {
                          const idx = imageAttachments.findIndex(
                            (a) => a.id === att.id,
                          );
                          if (idx !== -1) setLightboxIndex(idx);
                        } else {
                          try {
                            await invoke("open_attachment", {
                              attachmentId: att.id,
                            });
                          } catch (e) {
                            console.error("Failed to open attachment:", e);
                          }
                        }
                      }}
                      className="hover:underline"
                    >
                      {att.filename}
                    </button>
                    <button
                      onClick={async () => {
                        try {
                          await invoke("delete_attachment", {
                            attachmentId: att.id,
                          });
                          refreshAttachments(session.id);
                        } catch (e) {
                          console.error("Failed to delete attachment:", e);
                        }
                      }}
                      className="hidden group-hover/att:inline-flex hover:text-red-400"
                    >
                      <X size={10} />
                    </button>
                    {/* Image hover preview */}
                    {att.mime_type.startsWith("image/") && (
                      <div className="hidden group-hover/att:block absolute top-full left-0 mt-2 p-1 bg-background border border-border rounded-lg shadow-lg z-50">
                        <img
                          src={convertFileSrc(att.file_path)}
                          alt={att.filename}
                          className="max-w-[200px] max-h-[150px] rounded object-contain"
                        />
                      </div>
                    )}
                  </span>
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
                    className="w-20 px-1.5 py-0 text-xs rounded border border-border bg-transparent focus:outline-none focus:border-accent"
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
                          className="px-1.5 py-0 rounded text-xs text-text-secondary hover:text-text transition-colors"
                          style={tag.color ? { color: tag.color } : undefined}
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
                  className="flex items-center gap-0.5 rounded-md hover:text-text transition-colors"
                  title={t("notes.addTag", "Add tag")}
                >
                  <Tag size={10} />
                  <Plus size={8} />
                </button>
              )}

              {/* Add attachment */}
              <AttachmentsRow
                ref={attachmentsRowRef}
                sessionId={session.id}
                attachments={[]}
                onAttachmentsChange={() => refreshAttachments(session.id)}
                disabled={false}
              />

              {/* Sealed status pill — past-tense state, not an action.
                  The Clear action itself lives in the bottom bar next to
                  Re-enhance, since it's a post-enhancement move. */}
              {isSealed && (
                <span
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-text/5 border border-border-strong text-text-secondary cursor-default"
                  title={t("sessions.transcriptClearedPlaceholder", {
                    date: transcriptClearedDate,
                  })}
                >
                  <Lock size={11} />
                  <span>
                    {t("sessions.sealedBadge", {
                      date: transcriptClearedDateShort,
                    })}
                  </span>
                </span>
              )}
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
        </div>
      </div>

      {/* Floating recording panel — always show for any note */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 w-full max-w-3xl px-4 flex gap-2 items-end">
        <div className="flex-1 min-w-0 bg-background border border-border-strong rounded-2xl shadow-sm overflow-hidden">
          {/* Expandable area — transcript or chat */}
          {panelOpen && (
            <div className="border-b border-border">
              {/* Tab switcher */}
              <div className="flex items-center gap-1 px-4 pt-2 pb-1.5">
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
                  <span className="text-[10px] text-text-secondary/50 tabular-nums shrink-0">
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
                className="max-h-64 overflow-y-auto px-5 pt-2 pb-2 select-text"
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
                                className="text-xs text-text-secondary/50 shrink-0 pt-0.5 w-9 text-right tabular-nums select-none"
                              >
                                {formatMs(seg.start_ms)}
                              </span>
                              <span
                                data-ui
                                className={`text-xs shrink-0 pt-0.5 w-8 select-none ${seg.source === "mic" ? "text-blue-500" : "text-text-secondary/50"}`}
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
            {/* Section 1: Audio controls */}
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={() => setPanelOpen(!panelOpen)}
                className={`flex items-center gap-0.5 p-1.5 rounded-md transition-colors hover:bg-text/8 ${isRecording ? "text-green-500" : "text-text-secondary/60"}`}
              >
                {!isSealed && (
                  <WaveformBars
                    amplitude={amplitude}
                    isRecording={isRecording}
                  />
                )}
                {panelOpen ? (
                  <ChevronDown size={16} />
                ) : (
                  <ChevronUp size={16} />
                )}
              </button>
              {isRecording ? (
                <button
                  onClick={onStopRecording}
                  className="p-1.5 rounded-md bg-text/8 hover:bg-text/12 transition-colors text-text-secondary/60"
                  title={t("sessions.stopRecording")}
                >
                  <Square size={11} fill="currentColor" />
                </button>
              ) : (
                !isSealed && (
                  <button
                    onClick={onStartRecording}
                    className="text-xs font-medium text-accent hover:text-accent/70 transition-colors whitespace-nowrap"
                  >
                    {hasTranscript
                      ? t("sessions.resumeRecording")
                      : t("sessions.startRecording")}
                  </button>
                )
              )}
            </div>

            <span className="w-px h-3.5 bg-border-strong mx-4 shrink-0" />

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
                  placeholder={t("sessions.chat.placeholder")}
                  className="flex-1 text-xs bg-transparent outline-none placeholder:text-text-secondary min-w-0"
                />
                {chat.isLoading ? (
                  <button
                    onClick={chat.stop}
                    className="p-1 rounded-md text-text-secondary/50 hover:text-text-secondary transition-colors shrink-0"
                  >
                    <X size={16} />
                  </button>
                ) : (
                  chat.input.trim() && (
                    <button
                      onClick={handleChatSubmit}
                      className="p-1 rounded-md text-accent hover:text-accent/70 transition-colors shrink-0"
                    >
                      <Send size={16} />
                    </button>
                  )
                )}
                {isRecording && hasTranscript && (
                  <button
                    onClick={handleWhatDidIMiss}
                    className="px-2.5 py-1 text-xs font-medium text-accent border border-border-strong rounded-full hover:bg-accent/10 transition-colors whitespace-nowrap shrink-0"
                  >
                    {t("sessions.chat.whatDidIMiss")}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Post-enhancement action cluster. `group-hover/cluster:delay-0` keeps
            the collapse delay at 0 as long as the cursor is anywhere inside the
            cluster's bounding box — including the 8px gap between buttons,
            because in CSS the parent is :hover whenever the cursor is over any
            part of its box. So mousing between siblings never triggers the
            delay-150 base; both transitions fire with the same delay-0. The
            base delay-150 only re-engages when the cursor fully leaves the
            cluster, preserving the linger-on-exit feel. */}
        {!isRecording && hasTranscript && !enhanceLoading && !isSealed && (
          <div className="group/cluster flex gap-2 items-end">
            {canClearTranscript && (
              <button
                onClick={() => setShowClearTranscriptDialog(true)}
                title={t("sessions.clearTranscript")}
                aria-label={t("sessions.clearTranscript")}
                className="group/clear relative flex flex-row-reverse items-center px-3.5 h-[50px] rounded-2xl shadow-sm text-xs font-medium shrink-0 bg-background text-text-secondary hover:text-text hover:bg-accent-soft focus:text-text focus:bg-accent-soft border border-border-strong transition-all duration-200"
              >
                <Lock size={14} className="shrink-0" />
                <span className="whitespace-nowrap overflow-hidden max-w-0 mr-0 group-hover/clear:max-w-[200px] group-hover/clear:mr-1.5 group-focus/clear:max-w-[200px] group-focus/clear:mr-1.5 transition-all duration-200 ease-linear delay-150 group-hover/cluster:delay-0 group-focus-within/cluster:delay-0">
                  {t("sessions.clearTranscript")}
                </span>
                {/* Transparent hit-area extender covering the left half of the
                    gap. Keeps Clear `:hover` until the cursor reaches the
                    midpoint, where Re-enhance's mirror extender takes over.
                    Both transitions fire in the same frame at the crossover. */}
                <span
                  aria-hidden
                  className="absolute top-0 bottom-0 left-full w-1"
                />
              </button>
            )}

            <button
              onClick={() => {
                if (enhancedNotes && enhancedNotesEdited) {
                  setShowReenhanceWarning(true);
                } else {
                  onDismissEnhancePrompt();
                  onEnhanceNotes();
                }
              }}
              title={
                enhancedNotes
                  ? t("sessions.reenhance")
                  : t("sessions.enhanceNotes")
              }
              aria-label={
                enhancedNotes
                  ? t("sessions.reenhance")
                  : t("sessions.enhanceNotes")
              }
              className={
                enhancedNotes
                  ? "group/reenhance relative flex flex-row-reverse items-center px-3.5 h-[50px] rounded-2xl shadow-sm text-xs font-medium shrink-0 bg-background text-accent hover:bg-accent-soft focus:bg-accent-soft border border-border-strong transition-all duration-200"
                  : "flex items-center gap-1.5 px-4 h-[50px] rounded-2xl shadow-sm transition-colors text-xs font-medium shrink-0 bg-background-ui text-white hover:bg-background-ui/90"
              }
            >
              <Sparkles size={14} className="shrink-0" />
              {enhancedNotes ? (
                <span className="whitespace-nowrap overflow-hidden max-w-0 mr-0 group-hover/reenhance:max-w-[200px] group-hover/reenhance:mr-1.5 group-focus/reenhance:max-w-[200px] group-focus/reenhance:mr-1.5 transition-all duration-200 ease-linear delay-150 group-hover/cluster:delay-0 group-focus-within/cluster:delay-0">
                  {t("sessions.reenhance")}
                </span>
              ) : (
                t("sessions.enhanceNotes")
              )}
              {/* Mirror extender on the left, covering the right half of the
                  gap. See the matching extender on the Clear button above. */}
              {enhancedNotes && (
                <span
                  aria-hidden
                  className="absolute top-0 bottom-0 right-full w-1"
                />
              )}
            </button>
          </div>
        )}
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
