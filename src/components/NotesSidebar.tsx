import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Plus,
  Trash2,
  Settings,
  Search,
  Home,
  FolderIcon,
  Hash,
  X,
  Check,
  ChevronDown,
  ArrowDown,
} from "lucide-react";
import { useOrganizationStore } from "@/stores/organizationStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useSessionStore } from "@/stores/sessionStore";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { commands } from "@/bindings";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useUpdateChecker } from "@/components/update-checker";

interface Session {
  id: string;
  title: string;
  started_at: number;
  ended_at: number | null;
  status: string;
  folder_id: string | null;
  environment_id: string | null;
}

interface NotesSidebarProps {
  sessions: Session[];
  selectedId: string | null;
  recordingSessionId: string | null;
  onSelect: (id: string) => void;
  onNewNote: () => void | Promise<void>;
  onDelete: (id: string) => void;
  onOpenSettings: () => void;
}

interface LogGroup {
  key: string;
  label: string;
  /** Day groups show a time per row; month groups show the day. */
  kind: "day" | "month";
  items: Session[];
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * The log is grouped by day for the last week (Today, Yesterday, then each
 * date), and by month before that, so older notes don't collapse into one
 * undated heap.
 */
function groupForLog(
  sessions: Session[],
  labels: { today: string; yesterday: string },
): LogGroup[] {
  const today = startOfDay(new Date());
  const weekAgo = new Date(today);
  weekAgo.setDate(today.getDate() - 6);
  const thisYear = today.getFullYear();
  const groups: LogGroup[] = [];
  const byKey = new Map<string, LogGroup>();

  for (const s of sessions) {
    const date = new Date(s.started_at * 1000);
    const day = startOfDay(date);
    let key: string;
    let label: string;
    let kind: LogGroup["kind"];
    if (day >= weekAgo) {
      kind = "day";
      key = `d-${day.getTime()}`;
      const diffDays = Math.round(
        (today.getTime() - day.getTime()) / 86_400_000,
      );
      label =
        diffDays === 0
          ? labels.today
          : diffDays === 1
            ? labels.yesterday
            : date.toLocaleDateString(undefined, {
                weekday: "short",
                day: "numeric",
                month: "short",
              });
    } else {
      kind = "month";
      key = `m-${date.getFullYear()}-${date.getMonth()}`;
      label = date.toLocaleDateString(undefined, {
        month: "long",
        ...(date.getFullYear() !== thisYear ? { year: "numeric" } : {}),
      });
    }
    let group = byKey.get(key);
    if (!group) {
      group = { key, label, kind, items: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.items.push(s);
  }
  return groups;
}

/** Left-column label: a time in day groups, weekday + date in month groups. */
function formatLogTime(timestamp: number, kind: LogGroup["kind"]): string {
  const date = new Date(timestamp * 1000);
  if (kind === "day") {
    return date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
  });
}

const iconButton =
  "w-7 h-7 shrink-0 flex items-center justify-center rounded-md text-text-secondary hover:bg-accent/8 hover:text-text transition-colors";

export const NotesSidebar: React.FC<NotesSidebarProps> = ({
  sessions,
  selectedId,
  recordingSessionId,
  onSelect,
  onNewNote,
  onDelete,
  onOpenSettings,
}) => {
  const { t } = useTranslation();
  const {
    updateAvailable,
    updateChecksEnabled,
    isInstalling,
    downloadProgress,
    installUpdate,
  } = useUpdateChecker();
  const deselectSession = useSessionStore((s) => s.deselectSession);

  const { settings } = useSettingsStore();
  const environments = settings?.model_environments ?? [];
  const defaultEnvId =
    settings?.default_environment_id ?? environments[0]?.id ?? null;
  const multiEnv = environments.length >= 2;
  const envById = useMemo(
    () => Object.fromEntries(environments.map((e) => [e.id, e])),
    [environments],
  );

  const {
    folders,
    tags,
    selectedFolderId,
    selectedTagIds,
    selectFolder,
    toggleTagFilter,
    clearTagFilters,
    createFolder,
    deleteFolder,
    loadTags,
    moveSessionToFolder,
    initialize: initOrganization,
  } = useOrganizationStore();

  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [suggestionCount, setSuggestionCount] = useState(0);
  const [sessionTagsMap, setSessionTagsMap] = useState<
    Record<string, string[]>
  >({});

  // View menu ("All notes ▾")
  const [menuOpen, setMenuOpen] = useState(false);
  const [isAddingFolder, setIsAddingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    initOrganization();
  }, [initOrganization]);

  // Reload tags when sessions change (cleans up orphaned tags)
  useEffect(() => {
    loadTags();
  }, [sessions, loadTags]);

  // Word-suggestion count for the settings badge
  useEffect(() => {
    const fetchSuggestionCount = async () => {
      const suggestions = await commands.getWordSuggestions();
      setSuggestionCount(suggestions.length);
    };
    fetchSuggestionCount();
    const handleChange = () => fetchSuggestionCount();
    window.addEventListener("word-suggestions-changed", handleChange);
    window.addEventListener("focus", handleChange);
    return () => {
      window.removeEventListener("word-suggestions-changed", handleChange);
      window.removeEventListener("focus", handleChange);
    };
  }, []);

  // Tag view needs each session's tags
  useEffect(() => {
    if (selectedTagIds.length === 0) return;
    const fetchSessionTags = async () => {
      const newMap: Record<string, string[]> = {};
      for (const session of sessions) {
        const result = await commands.getSessionTags(session.id);
        if (result.status === "ok") {
          newMap[session.id] = result.data.map((tag) => tag.id);
        }
      }
      setSessionTagsMap(newMap);
    };
    fetchSessionTags();
  }, [sessions, selectedTagIds.length]);

  // Close the view menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handle = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setIsAddingFolder(false);
        setNewFolderName("");
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [menuOpen]);

  useEffect(() => {
    if (isAddingFolder) folderInputRef.current?.focus();
  }, [isAddingFolder]);

  // ---- current view ----
  const selectedTag = tags.find((tag) => tag.id === selectedTagIds[0]);
  const selectedFolder = folders.find((f) => f.id === selectedFolderId);
  const viewLabel = selectedFolder
    ? selectedFolder.name
    : selectedTag
      ? `#${selectedTag.name}`
      : t("sidebar.allNotes");
  const isAllNotes = !selectedFolder && !selectedTag;

  const showAll = useCallback(() => {
    selectFolder(null);
    clearTagFilters();
  }, [selectFolder, clearTagFilters]);

  const chooseFolder = (id: string) => {
    clearTagFilters();
    selectFolder(id);
    setMenuOpen(false);
  };

  const chooseTag = (id: string) => {
    selectFolder(null);
    clearTagFilters();
    toggleTagFilter(id);
    setMenuOpen(false);
  };

  const handleAddFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    const folder = await createFolder(name);
    setNewFolderName("");
    setIsAddingFolder(false);
    if (folder) chooseFolder(folder.id);
  };

  // A note started while viewing a folder belongs in that folder.
  const handleNewNote = async () => {
    const folderId = selectedFolderId;
    await onNewNote();
    const newId = useSessionStore.getState().selectedSessionId;
    if (folderId && newId) await moveSessionToFolder(newId, folderId);
  };

  const filteredSessions = useMemo(() => {
    let result = sessions;
    if (selectedFolderId !== null) {
      result = result.filter((s) => s.folder_id === selectedFolderId);
    }
    if (selectedTagIds.length > 0) {
      result = result.filter((s) => {
        const sessionTags = sessionTagsMap[s.id] ?? [];
        return selectedTagIds.every((tagId) => sessionTags.includes(tagId));
      });
    }
    return result;
  }, [sessions, selectedFolderId, selectedTagIds, sessionTagsMap]);

  const logGroups = useMemo(
    () =>
      groupForLog(
        // the live note is pinned above the groups
        filteredSessions.filter((s) => s.id !== recordingSessionId),
        {
          today: t("notes.dateGroups.today"),
          yesterday: t("notes.dateGroups.yesterday"),
        },
      ),
    [filteredSessions, recordingSessionId, t],
  );

  const folderCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const s of sessions) {
      if (s.folder_id) counts[s.folder_id] = (counts[s.folder_id] || 0) + 1;
    }
    return counts;
  }, [sessions]);

  const liveSession = recordingSessionId
    ? sessions.find((s) => s.id === recordingSessionId)
    : undefined;

  const envDotFor = (s: Session) => {
    if (!multiEnv) return null;
    const envId = s.environment_id ?? defaultEnvId;
    if (!envId || envId === defaultEnvId) return null;
    return envById[envId]?.color ?? null;
  };

  const renderSessionRow = (s: Session, timeLabel: string, live = false) => {
    const isSelected = selectedId === s.id;
    const dot = live ? "var(--color-live)" : envDotFor(s);
    return (
      <div
        key={s.id}
        onClick={() => onSelect(s.id)}
        className={`group grid grid-cols-[48px_minmax(0,1fr)_14px] items-center gap-2 h-[30px] pl-3 pr-2 border-b border-border cursor-pointer transition-colors ${
          isSelected
            ? "bg-accent/8 text-text font-medium"
            : "text-text-secondary hover:bg-accent/4 hover:text-text"
        }`}
      >
        <span
          className={`font-mono text-[11px] ${live ? "text-live uppercase tracking-wider" : "text-mid-gray"}`}
        >
          {timeLabel}
        </span>
        <span data-ui className="text-[13px] truncate">
          {s.title}
        </span>
        <span className="relative flex items-center justify-center">
          {dot && (
            <span
              className="w-1.5 h-1.5 rounded-full group-hover:opacity-0 transition-opacity"
              style={{ backgroundColor: dot }}
            />
          )}
          {!live && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setDeleteConfirmId(s.id);
              }}
              aria-label={t("sidebar.deleteNote")}
              title={t("sidebar.deleteNote")}
              className="absolute opacity-0 group-hover:opacity-100 text-mid-gray hover:text-red-500 transition-opacity"
            >
              <Trash2 size={12} />
            </button>
          )}
        </span>
      </div>
    );
  };

  const dayHeader = (label: string) => (
    <div className="px-3 pt-3 pb-1 border-b border-border-strong font-display text-[11px] uppercase text-text-secondary">
      {label}
    </div>
  );

  const menuRow = (
    key: string,
    label: React.ReactNode,
    icon: React.ReactNode,
    count: number | null,
    selected: boolean,
    onClick: () => void,
    onDeleteRow?: () => void,
  ) => (
    <div
      key={key}
      onClick={onClick}
      className={`group flex items-center gap-2 h-[30px] px-2.5 rounded-md cursor-pointer text-[13px] text-text ${
        selected ? "bg-accent/8" : "hover:bg-accent/5"
      }`}
    >
      <span className="w-3.5 flex justify-center text-mid-gray">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {count !== null && (
        <span className="font-mono text-[11px] text-mid-gray group-hover:hidden">
          {count}
        </span>
      )}
      {onDeleteRow && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDeleteRow();
          }}
          aria-label={t("sidebar.deleteFolder")}
          title={t("sidebar.deleteFolder")}
          className="hidden group-hover:block text-mid-gray hover:text-red-500"
        >
          <Trash2 size={12} />
        </button>
      )}
      {selected && <Check size={13} className="text-text" />}
    </div>
  );

  return (
    <div className="flex flex-col w-full h-full">
      {/* macOS title bar drag region (traffic lights + sidebar toggle live here) */}
      <div data-tauri-drag-region className="h-8 w-full shrink-0" />

      {/* Home · New · Search */}
      <div className="flex items-center gap-1 px-2.5 pb-2">
        <button
          onClick={deselectSession}
          className={`${iconButton} ${selectedId === null ? "bg-accent/8 text-text" : ""}`}
          aria-label={t("sidebar.home")}
          title={t("sidebar.home")}
        >
          <Home size={15} />
        </button>
        <button
          onClick={handleNewNote}
          data-ui
          className={iconButton}
          aria-label={t("sidebar.newNote")}
          title={t("sidebar.newNote")}
        >
          <Plus size={16} strokeWidth={2} />
        </button>
        <button
          onClick={() => useCommandPaletteStore.getState().open()}
          className={iconButton}
          aria-label={t("palette.openTitle")}
          title={t("palette.openTitle")}
        >
          <Search size={15} />
        </button>
      </div>

      {/* View header: All notes ▾ */}
      <div
        ref={menuRef}
        className="relative flex items-center h-8 pl-1.5 pr-2 border-t border-border"
      >
        <button
          onClick={() => setMenuOpen((o) => !o)}
          aria-label={t("sidebar.viewMenu")}
          className={`flex items-center gap-1.5 h-6 px-1.5 rounded-md text-[13px] font-medium text-text min-w-0 ${
            menuOpen ? "bg-accent/8" : "hover:bg-accent/5"
          }`}
        >
          <span className="truncate">{viewLabel}</span>
          <ChevronDown size={12} className="shrink-0 text-text-secondary" />
        </button>
        <span className="flex-1" />
        {isAllNotes ? (
          <span className="font-mono text-[11px] text-mid-gray">
            {filteredSessions.length}
          </span>
        ) : (
          <button
            onClick={showAll}
            aria-label={t("sidebar.showAll")}
            title={t("sidebar.showAll")}
            className="text-mid-gray hover:text-text"
          >
            <X size={12} />
          </button>
        )}

        {menuOpen && (
          <div className="absolute left-2 top-8 z-30 w-[250px] p-1 bg-background border border-border rounded-lg shadow-lg flex flex-col gap-px">
            {menuRow(
              "all",
              t("sidebar.allNotes"),
              null,
              sessions.length,
              isAllNotes,
              () => {
                showAll();
                setMenuOpen(false);
              },
            )}
            {folders.length > 0 && (
              <div className="px-2.5 pt-2 pb-1 font-display text-[10px] uppercase text-mid-gray">
                {t("sidebar.folders")}
              </div>
            )}
            {folders.map((f) =>
              menuRow(
                f.id,
                f.name,
                <FolderIcon size={13} />,
                folderCounts[f.id] || 0,
                selectedFolderId === f.id,
                () => chooseFolder(f.id),
                () => {
                  if (selectedFolderId === f.id) showAll();
                  deleteFolder(f.id);
                },
              ),
            )}
            {tags.length > 0 && (
              <div className="px-2.5 pt-2 pb-1 font-display text-[10px] uppercase text-mid-gray">
                {t("sidebar.tags")}
              </div>
            )}
            {tags.map((tag) =>
              menuRow(
                tag.id,
                tag.name,
                <Hash size={12} />,
                null,
                selectedTagIds[0] === tag.id,
                () => chooseTag(tag.id),
              ),
            )}
            <div className="h-px bg-border mx-1.5 my-1" />
            {isAddingFolder ? (
              <div className="flex items-center gap-1 px-1.5 h-[30px]">
                <input
                  ref={folderInputRef}
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleAddFolder();
                    if (e.key === "Escape") {
                      setIsAddingFolder(false);
                      setNewFolderName("");
                    }
                  }}
                  placeholder={t("sidebar.folderName")}
                  className="flex-1 min-w-0 h-6 px-2 text-[13px] rounded border border-border bg-transparent text-text outline-none focus:border-border-strong"
                />
                <button
                  onClick={handleAddFolder}
                  aria-label={t("sidebar.newFolder")}
                  className="p-1 text-text-secondary hover:text-text"
                >
                  <Check size={13} />
                </button>
              </div>
            ) : (
              menuRow(
                "new-folder",
                t("sidebar.newFolder"),
                <Plus size={13} />,
                null,
                false,
                () => setIsAddingFolder(true),
              )
            )}
          </div>
        )}
      </div>

      {/* The list */}
      <div className="flex-1 overflow-y-auto border-t border-border-strong">
        {liveSession && renderSessionRow(liveSession, t("sidebar.live"), true)}
        {logGroups.map((group) => (
          <div key={group.key}>
            {dayHeader(group.label)}
            {group.items.map((s) =>
              renderSessionRow(s, formatLogTime(s.started_at, group.kind)),
            )}
          </div>
        ))}
        {filteredSessions.length === 0 && (
          <div className="px-4 pt-6 text-center text-[13px] text-text-secondary">
            {t("sidebar.noNotesInView")}
          </div>
        )}
      </div>

      {/* Settings + update */}
      <div className="flex items-center gap-2 px-2 py-1.5 border-t border-border">
        <button
          onClick={onOpenSettings}
          aria-label={t("sidebar.settings")}
          title={t("sidebar.settings")}
          className={`${iconButton} relative`}
        >
          <Settings size={16} />
          {suggestionCount > 0 && (
            <span className="absolute top-1 right-1 w-1.5 h-1.5 bg-amber-500 rounded-full" />
          )}
        </button>
        {updateChecksEnabled && updateAvailable && (
          <button
            onClick={installUpdate}
            disabled={isInstalling}
            className="flex items-center gap-1.5 ml-auto px-2.5 py-1 rounded-md bg-background-ui text-white text-xs font-medium hover:bg-background-ui/90 transition-colors disabled:opacity-50"
          >
            <span className="truncate">
              {isInstalling
                ? downloadProgress === 100
                  ? t("footer.installing")
                  : downloadProgress > 0
                    ? t("footer.downloading", {
                        progress: downloadProgress.toString().padStart(3),
                      })
                    : t("footer.preparing")
                : t("settings.general.updateBanner.message")}
            </span>
            <ArrowDown size={12} strokeWidth={2.5} />
          </button>
        )}
      </div>

      <ConfirmDialog
        open={deleteConfirmId !== null}
        title={t("sessions.deleteConfirmTitle")}
        message={t("sessions.deleteConfirmMessage")}
        variant="danger"
        onConfirm={() => {
          if (deleteConfirmId) onDelete(deleteConfirmId);
          setDeleteConfirmId(null);
        }}
        onCancel={() => setDeleteConfirmId(null)}
      />
    </div>
  );
};
