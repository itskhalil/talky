import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  Plus,
  FileText,
  Mic,
  Square,
  Download,
  Trash2,
  Search,
  Paperclip,
  Tag,
  FolderIcon,
  X,
  Calendar,
  ChevronDown,
} from "lucide-react";
import type { SearchHit } from "@/bindings";
import { useSessionStore } from "@/stores/sessionStore";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { useNoteUiIntentStore } from "@/stores/noteUiIntentStore";
import { useOrganizationStore } from "@/stores/organizationStore";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { highlightMatches } from "@/utils/highlight";

type DateRangeKey = "any" | "today" | "week" | "month" | "year";

function dateRangeBounds(key: DateRangeKey): {
  after: number | null;
  before: number | null;
} {
  if (key === "any") return { after: null, before: null };
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (key === "today") {
    return { after: Math.floor(start.getTime() / 1000), before: null };
  }
  if (key === "week") {
    start.setDate(start.getDate() - 7);
  } else if (key === "month") {
    start.setDate(start.getDate() - 30);
  } else if (key === "year") {
    start.setMonth(0, 1);
  }
  return { after: Math.floor(start.getTime() / 1000), before: null };
}

type CommandId =
  | "new-note"
  | "toggle-recording"
  | "add-attachment"
  | "add-tag"
  | "move-to-folder"
  | "export-current"
  | "delete-current";

interface PaletteCommand {
  id: CommandId;
  label: string;
  icon: React.ReactNode;
  run: () => void;
}

interface NoteResult {
  kind: "note";
  hit: SearchHit;
}

interface CommandResult {
  kind: "command";
  command: PaletteCommand;
}

type Result = CommandResult | NoteResult;

/** Simple title-only scorer; used for commands and as the offline fallback for notes. */
function scoreMatch(haystack: string, needle: string): number {
  if (!needle) return 1;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (h === n) return 100;
  if (h.startsWith(n)) return 80;
  if (h.includes(n)) return 50;
  return 0;
}

interface FilterChipProps {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  onClear?: () => void;
}

const FilterChip: React.FC<FilterChipProps> = ({
  icon,
  label,
  active,
  onClick,
  onClear,
}) => (
  <span
    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 cursor-pointer transition-colors ${
      active
        ? "border-accent/40 bg-accent/10 text-text"
        : "border-border text-text-secondary hover:border-border-strong"
    }`}
    onClick={onClick}
  >
    {icon}
    <span className="text-[11px]">{label}</span>
    {onClear ? (
      <button
        type="button"
        className="shrink-0 text-text-secondary hover:text-text"
        onClick={(e) => {
          e.stopPropagation();
          onClear();
        }}
        aria-label="Clear"
      >
        <X size={10} />
      </button>
    ) : (
      <ChevronDown size={10} className="text-text-secondary" />
    )}
  </span>
);

interface ChipDropdownProps {
  onClose: () => void;
  children: React.ReactNode;
}

const ChipDropdown: React.FC<ChipDropdownProps> = ({ onClose, children }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);
  return (
    <div
      ref={ref}
      className="absolute left-3 top-full z-10 mt-1 min-w-[180px] max-h-[240px] overflow-y-auto rounded-md border border-border bg-background shadow-lg py-1"
    >
      {children}
    </div>
  );
};

interface ChipDropdownItemProps {
  active: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}

const ChipDropdownItem: React.FC<ChipDropdownItemProps> = ({
  active,
  onSelect,
  children,
}) => (
  <button
    type="button"
    onClick={(e) => {
      e.stopPropagation();
      onSelect();
    }}
    className={`flex w-full items-center px-3 py-1.5 text-left text-xs ${
      active ? "bg-accent/10 text-text" : "text-text hover:bg-accent/5"
    }`}
  >
    {children}
  </button>
);

export const CommandPalette: React.FC = () => {
  const { t } = useTranslation();
  const isOpen = useCommandPaletteStore((s) => s.isOpen);
  const close = useCommandPaletteStore((s) => s.close);

  const sessions = useSessionStore((s) => s.sessions);
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);
  const isRecording = useSessionStore((s) => s.isRecording);
  const recordingSessionId = useSessionStore((s) => s.recordingSessionId);
  const selectedCache = useSessionStore((s) =>
    s.selectedSessionId ? s.cache[s.selectedSessionId] : undefined,
  );
  const folders = useOrganizationStore((s) => s.folders);
  const tags = useOrganizationStore((s) => s.tags);

  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [noteResults, setNoteResults] = useState<SearchHit[] | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [folderFilter, setFolderFilter] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [dateFilter, setDateFilter] = useState<DateRangeKey>("any");
  const [openChip, setOpenChip] = useState<"folder" | "tags" | "date" | null>(
    null,
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hasFilters =
    folderFilter !== null || tagFilter.length > 0 || dateFilter !== "any";

  useEffect(() => {
    if (!isOpen) {
      setQuery("");
      setActiveIndex(0);
      setNoteResults(null);
      setFolderFilter(null);
      setTagFilter([]);
      setDateFilter("any");
      setOpenChip(null);
      return;
    }
    // Make sure folders/tags are loaded for the filter dropdowns.
    const org = useOrganizationStore.getState();
    if (org.folders.length === 0) void org.loadFolders();
    if (org.tags.length === 0) void org.loadTags();
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    const { after, before } = dateRangeBounds(dateFilter);
    const filtersActive =
      folderFilter !== null || tagFilter.length > 0 || dateFilter !== "any";
    if (!q && !filtersActive) {
      setNoteResults(null);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const results = await invoke<SearchHit[]>("search_sessions", {
          query: q,
          folderId: folderFilter,
          tagIds: tagFilter.length > 0 ? tagFilter : null,
          startedAfter: after,
          startedBefore: before,
        });
        setNoteResults(results);
      } catch (e) {
        console.error("Palette search failed:", e);
        setNoteResults(null);
      }
    }, 120);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, folderFilter, tagFilter, dateFilter, isOpen]);

  const commands = useMemo<PaletteCommand[]>(() => {
    const store = useSessionStore.getState();
    const list: PaletteCommand[] = [
      {
        id: "new-note",
        label: t("palette.commands.newNote"),
        icon: <Plus size={16} />,
        run: () => {
          close();
          void store.createNote();
        },
      },
    ];

    if (selectedSessionId) {
      const recordingThis =
        isRecording && recordingSessionId === selectedSessionId;
      list.push({
        id: "toggle-recording",
        label: recordingThis
          ? t("palette.commands.stopRecording")
          : t("palette.commands.startRecording"),
        icon: recordingThis ? <Square size={16} /> : <Mic size={16} />,
        run: () => {
          close();
          if (recordingThis) {
            void store.stopRecording();
          } else {
            void store.startRecording(selectedSessionId);
          }
        },
      });

      const intent = useNoteUiIntentStore.getState();
      list.push({
        id: "add-attachment",
        label: t("palette.commands.addAttachment"),
        icon: <Paperclip size={16} />,
        run: () => {
          close();
          intent.openAttachmentPicker();
        },
      });

      list.push({
        id: "add-tag",
        label: t("palette.commands.addTag"),
        icon: <Tag size={16} />,
        run: () => {
          close();
          intent.openTagInput();
        },
      });

      list.push({
        id: "move-to-folder",
        label: t("palette.commands.moveToFolder"),
        icon: <FolderIcon size={16} />,
        run: () => {
          close();
          intent.openFolderPicker();
        },
      });

      const hasEnhanced = !!selectedCache?.enhancedNotes;
      const selectedSessionRow = useSessionStore
        .getState()
        .sessions.find((s) => s.id === selectedSessionId);
      const hasTranscript = !selectedSessionRow?.transcript_wiped_at;
      list.push({
        id: "export-current",
        label: t("palette.commands.exportCurrent"),
        icon: <Download size={16} />,
        run: () => {
          close();
          store.openExportDialog("single", hasEnhanced, hasTranscript);
        },
      });

      list.push({
        id: "delete-current",
        label: t("palette.commands.deleteCurrent"),
        icon: <Trash2 size={16} />,
        run: () => {
          setPendingDeleteId(selectedSessionId);
        },
      });
    }

    return list;
  }, [
    t,
    close,
    selectedSessionId,
    isRecording,
    recordingSessionId,
    selectedCache?.enhancedNotes,
  ]);

  const results = useMemo<Result[]>(() => {
    const q = query.trim();
    const filteredCommands = commands
      .map((c) => ({ cmd: c, score: scoreMatch(c.label, q) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map<CommandResult>((x) => ({ kind: "command", command: x.cmd }));

    let notes: NoteResult[] = [];
    if (noteResults) {
      // Backend already matched title + user_notes + enhanced_notes and applied filters.
      // Do NOT re-filter client-side by title — that was the old bug that hid body-only hits.
      notes = noteResults
        .slice(0, 20)
        .map<NoteResult>((hit) => ({ kind: "note", hit }));
    } else if (q) {
      // Fallback: backend errored. Zustand only has titles, so title-scoring is all we have here.
      notes = sessions
        .map((s) => ({ session: s, score: scoreMatch(s.title, q) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 20)
        .map<NoteResult>((x) => ({
          kind: "note",
          hit: { session: x.session, matched_field: "title", snippet: "" },
        }));
    }

    return [...filteredCommands, ...notes];
  }, [commands, noteResults, sessions, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (activeIndex >= results.length)
      setActiveIndex(Math.max(0, results.length - 1));
  }, [results.length, activeIndex]);

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>(
      `[data-palette-index="${activeIndex}"]`,
    );
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const runResult = (r: Result) => {
    if (r.kind === "command") {
      r.command.run();
    } else {
      close();
      useSessionStore.getState().selectSession(r.hit.session.id);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = results[activeIndex];
      if (r) runResult(r);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  if (!isOpen) return null;

  const showingNotesHeader =
    (query.trim() || hasFilters) && results.some((r) => r.kind === "note");
  const showingCommandsHeader = results.some((r) => r.kind === "command");

  const folderName = folderFilter
    ? (folders.find((f) => f.id === folderFilter)?.name ?? folderFilter)
    : null;

  const dateChipLabel = (() => {
    if (dateFilter === "today") return t("palette.filters.date.today");
    if (dateFilter === "week") return t("palette.filters.date.week");
    if (dateFilter === "month") return t("palette.filters.date.month");
    if (dateFilter === "year") return t("palette.filters.date.year");
    return null;
  })();

  let renderedIndex = -1;

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] bg-black/30"
        onMouseDown={close}
      >
        <div
          className="w-[560px] max-w-[90vw] bg-background border border-border rounded-xl shadow-2xl overflow-hidden"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border">
            <Search size={14} className="text-text-secondary shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t("palette.placeholder")}
              className="flex-1 bg-transparent outline-none text-sm text-text placeholder:text-text-secondary"
            />
          </div>
          <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border text-xs relative flex-wrap">
            <FilterChip
              icon={<FolderIcon size={12} />}
              label={folderName ?? t("palette.filters.folder.any")}
              active={folderFilter !== null}
              onClick={() =>
                setOpenChip(openChip === "folder" ? null : "folder")
              }
              onClear={
                folderFilter !== null ? () => setFolderFilter(null) : undefined
              }
            />
            {openChip === "folder" && (
              <ChipDropdown onClose={() => setOpenChip(null)}>
                <ChipDropdownItem
                  active={folderFilter === null}
                  onSelect={() => {
                    setFolderFilter(null);
                    setOpenChip(null);
                  }}
                >
                  {t("palette.filters.folder.any")}
                </ChipDropdownItem>
                {folders.map((f) => (
                  <ChipDropdownItem
                    key={f.id}
                    active={folderFilter === f.id}
                    onSelect={() => {
                      setFolderFilter(f.id);
                      setOpenChip(null);
                    }}
                  >
                    {f.name}
                  </ChipDropdownItem>
                ))}
              </ChipDropdown>
            )}

            <FilterChip
              icon={<Tag size={12} />}
              label={
                tagFilter.length === 0
                  ? t("palette.filters.tags.any")
                  : t("palette.filters.tags.count", { count: tagFilter.length })
              }
              active={tagFilter.length > 0}
              onClick={() => setOpenChip(openChip === "tags" ? null : "tags")}
              onClear={
                tagFilter.length > 0 ? () => setTagFilter([]) : undefined
              }
            />
            {openChip === "tags" && (
              <ChipDropdown onClose={() => setOpenChip(null)}>
                {tags.length === 0 && (
                  <div className="px-3 py-2 text-xs text-text-secondary">
                    {t("palette.filters.tags.empty")}
                  </div>
                )}
                {tags.map((tag) => {
                  const selected = tagFilter.includes(tag.id);
                  return (
                    <ChipDropdownItem
                      key={tag.id}
                      active={selected}
                      onSelect={() =>
                        setTagFilter((prev) =>
                          selected
                            ? prev.filter((id) => id !== tag.id)
                            : [...prev, tag.id],
                        )
                      }
                    >
                      <span
                        className="inline-block w-2 h-2 rounded-full mr-2"
                        style={{
                          backgroundColor: tag.color ?? "var(--color-border)",
                        }}
                      />
                      {tag.name}
                    </ChipDropdownItem>
                  );
                })}
              </ChipDropdown>
            )}

            <FilterChip
              icon={<Calendar size={12} />}
              label={dateChipLabel ?? t("palette.filters.date.any")}
              active={dateFilter !== "any"}
              onClick={() => setOpenChip(openChip === "date" ? null : "date")}
              onClear={
                dateFilter !== "any" ? () => setDateFilter("any") : undefined
              }
            />
            {openChip === "date" && (
              <ChipDropdown onClose={() => setOpenChip(null)}>
                {(
                  ["any", "today", "week", "month", "year"] as DateRangeKey[]
                ).map((key) => (
                  <ChipDropdownItem
                    key={key}
                    active={dateFilter === key}
                    onSelect={() => {
                      setDateFilter(key);
                      setOpenChip(null);
                    }}
                  >
                    {t(`palette.filters.date.${key}`)}
                  </ChipDropdownItem>
                ))}
              </ChipDropdown>
            )}

            <div className="ml-auto text-[10px] text-text-secondary">
              {t("palette.filters.searchingHint")}
            </div>
          </div>
          <div ref={listRef} className="max-h-[50vh] overflow-y-auto py-1">
            {results.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-text-secondary">
                {t("palette.empty")}
              </div>
            ) : (
              <>
                {showingCommandsHeader && (
                  <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
                    {t("palette.sections.commands")}
                  </div>
                )}
                {results
                  .filter((r) => r.kind === "command")
                  .map((r) => {
                    const idx = ++renderedIndex;
                    const isActive = idx === activeIndex;
                    const cmd = (r as CommandResult).command;
                    return (
                      <button
                        key={`cmd-${cmd.id}`}
                        data-palette-index={idx}
                        onMouseEnter={() => setActiveIndex(idx)}
                        onClick={() => runResult(r)}
                        className={`flex items-center gap-2.5 w-full px-3 py-2 text-sm text-left transition-colors ${
                          isActive ? "bg-accent/10 text-text" : "text-text"
                        }`}
                      >
                        <span className="text-text-secondary shrink-0">
                          {cmd.icon}
                        </span>
                        <span className="flex-1 truncate">{cmd.label}</span>
                      </button>
                    );
                  })}
                {showingNotesHeader && (
                  <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
                    {t("palette.sections.notes")}
                  </div>
                )}
                {results
                  .filter((r) => r.kind === "note")
                  .map((r) => {
                    const idx = ++renderedIndex;
                    const isActive = idx === activeIndex;
                    const hit = (r as NoteResult).hit;
                    const note = hit.session;
                    const q = query.trim();
                    const badge =
                      hit.matched_field === "user_notes"
                        ? t("palette.matched.body")
                        : hit.matched_field === "enhanced_notes"
                          ? t("palette.matched.enhanced")
                          : null;
                    return (
                      <button
                        key={`note-${note.id}`}
                        data-palette-index={idx}
                        onMouseEnter={() => setActiveIndex(idx)}
                        onClick={() => runResult(r)}
                        className={`flex items-start gap-2.5 w-full px-3 py-2 text-sm text-left transition-colors ${
                          isActive ? "bg-accent/10 text-text" : "text-text"
                        }`}
                      >
                        <span className="text-text-secondary shrink-0 mt-0.5">
                          <FileText size={16} />
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="flex items-center gap-2">
                            <span className="flex-1 truncate">
                              {highlightMatches(note.title, q)}
                            </span>
                            {badge && (
                              <span className="shrink-0 rounded-sm bg-border/60 px-1.5 py-0.5 text-[10px] font-medium text-text-secondary">
                                {badge}
                              </span>
                            )}
                          </span>
                          {hit.snippet && (
                            <span className="mt-0.5 block text-xs text-text-secondary line-clamp-2 break-words">
                              {highlightMatches(hit.snippet, q)}
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })}
              </>
            )}
          </div>
        </div>
      </div>
      <ConfirmDialog
        open={pendingDeleteId !== null}
        title={t("sessions.deleteConfirmTitle")}
        message={t("sessions.deleteConfirmMessage")}
        variant="danger"
        onConfirm={() => {
          const id = pendingDeleteId;
          setPendingDeleteId(null);
          close();
          if (id) void useSessionStore.getState().deleteSession(id);
        }}
        onCancel={() => setPendingDeleteId(null)}
      />
    </>
  );
};
