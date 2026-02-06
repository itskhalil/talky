import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Plus, Trash2, Settings, Search, PanelLeftClose, FolderIcon, FolderOpen, X, ChevronRight, ChevronDown, Sparkles, Send, Loader2 } from "lucide-react";
import { useGlobalChat } from "@/hooks/useGlobalChat";
import { useOrganizationStore } from "@/stores/organizationStore";
import { commands } from "@/bindings";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

interface Session {
  id: string;
  title: string;
  started_at: number;
  ended_at: number | null;
  status: string;
  folder_id: string | null;
}

interface NotesSidebarProps {
  sessions: Session[];
  selectedId: string | null;
  recordingSessionId: string | null;
  onSelect: (id: string) => void;
  onNewNote: () => void;
  onDelete: (id: string) => void;
  onOpenSettings: () => void;
  onCollapse?: () => void;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

type DateGroup = "today" | "yesterday" | "last7Days" | "older";

function getDateGroup(timestamp: number): DateGroup {
  const now = new Date();
  const date = new Date(timestamp * 1000);

  // Reset to start of day for comparison
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 7);

  const dateStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (dateStart >= today) {
    return "today";
  } else if (dateStart >= yesterday) {
    return "yesterday";
  } else if (dateStart >= weekAgo) {
    return "last7Days";
  }
  return "older";
}

interface GroupedSessions {
  today: Session[];
  yesterday: Session[];
  last7Days: Session[];
  older: Session[];
}

function groupSessionsByDate(sessions: Session[]): GroupedSessions {
  const groups: GroupedSessions = {
    today: [],
    yesterday: [],
    last7Days: [],
    older: [],
  };

  for (const session of sessions) {
    const group = getDateGroup(session.started_at);
    groups[group].push(session);
  }

  return groups;
}


export const NotesSidebar: React.FC<NotesSidebarProps> = ({
  sessions,
  selectedId,
  recordingSessionId,
  onSelect,
  onNewNote,
  onDelete,
  onOpenSettings,
  onCollapse,
}) => {
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Session[] | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [isAddingFolder, setIsAddingFolder] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [sessionTagsMap, setSessionTagsMap] = useState<Record<string, string[]>>({});
  const [foldersExpanded, setFoldersExpanded] = useState(true);
  const [notesExpanded, setNotesExpanded] = useState(true);
  const [chatExpanded, setChatExpanded] = useState(false);
  const [chatHeight, setChatHeight] = useState(192); // default ~max-h-48
  const [suggestionCount, setSuggestionCount] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const chatInputRef = useRef<HTMLInputElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const globalChat = useGlobalChat();

  // Scroll to latest chat message
  useEffect(() => {
    if (chatExpanded && globalChat.messages.length > 0) {
      chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [chatExpanded, globalChat.messages]);

  // Chat resize handlers
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizeRef.current = { startY: e.clientY, startHeight: chatHeight };

    const handleMouseMove = (e: MouseEvent) => {
      if (!resizeRef.current) return;
      const delta = resizeRef.current.startY - e.clientY;
      const newHeight = Math.max(100, Math.min(500, resizeRef.current.startHeight + delta));
      setChatHeight(newHeight);
    };

    const handleMouseUp = () => {
      resizeRef.current = null;
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, [chatHeight]);

  const {
    folders,
    tags,
    selectedFolderId,
    selectedTagIds,
    selectFolder,
    toggleTagFilter,
    createFolder,
    deleteFolder,
    loadTags,
    initialize: initOrganization,
  } = useOrganizationStore();

  // Initialize organization store on mount
  useEffect(() => {
    initOrganization();
  }, [initOrganization]);

  // Reload tags when sessions change (to clean up orphaned tags)
  useEffect(() => {
    loadTags();
  }, [sessions, loadTags]);

  // Fetch word suggestion count for settings badge
  useEffect(() => {
    const fetchSuggestionCount = async () => {
      const suggestions = await commands.getWordSuggestions();
      setSuggestionCount(suggestions.length);
    };
    fetchSuggestionCount();
    // Refetch when suggestions change or window regains focus
    const handleChange = () => fetchSuggestionCount();
    window.addEventListener("word-suggestions-changed", handleChange);
    window.addEventListener("focus", handleChange);
    return () => {
      window.removeEventListener("word-suggestions-changed", handleChange);
      window.removeEventListener("focus", handleChange);
    };
  }, []);

  // Fetch session tags when tags are selected for filtering
  useEffect(() => {
    if (selectedTagIds.length === 0) return;

    const fetchSessionTags = async () => {
      const newMap: Record<string, string[]> = {};
      for (const session of sessions) {
        const result = await commands.getSessionTags(session.id);
        if (result.status === "ok") {
          newMap[session.id] = result.data.map((t) => t.id);
        }
      }
      setSessionTagsMap(newMap);
    };
    fetchSessionTags();
  }, [sessions, selectedTagIds.length]);

  const doSearch = useCallback(async (query: string) => {
    if (!query.trim()) {
      setSearchResults(null);
      return;
    }
    try {
      const results = await invoke<Session[]>("search_sessions", { query: query.trim() });
      setSearchResults(results);
    } catch (e) {
      console.error("Search failed:", e);
      setSearchResults(null);
    }
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(searchQuery), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchQuery, doSearch]);

  // Filter sessions by folder and tags
  const filteredSessions = useMemo(() => {
    let result = searchResults ?? sessions;

    // Filter by folder
    if (selectedFolderId !== null) {
      result = result.filter((s) => s.folder_id === selectedFolderId);
    }

    // Filter by tags (must have ALL selected tags)
    if (selectedTagIds.length > 0) {
      result = result.filter((s) => {
        const sessionTags = sessionTagsMap[s.id] ?? [];
        return selectedTagIds.every((tagId) => sessionTags.includes(tagId));
      });
    }

    return result;
  }, [searchResults, sessions, selectedFolderId, selectedTagIds, sessionTagsMap]);

  // Count sessions per folder
  const folderCounts = useMemo(() => {
    const counts: Record<string, number> = { all: sessions.length };
    for (const s of sessions) {
      if (s.folder_id) {
        counts[s.folder_id] = (counts[s.folder_id] || 0) + 1;
      }
    }
    return counts;
  }, [sessions]);

  // Group filtered sessions by date
  const groupedSessions = useMemo(
    () => groupSessionsByDate(filteredSessions),
    [filteredSessions]
  );

  const dateGroupOrder: DateGroup[] = ["today", "yesterday", "last7Days", "older"];

  const handleAddFolder = async () => {
    if (newFolderName.trim()) {
      await createFolder(newFolderName.trim());
      setNewFolderName("");
      setIsAddingFolder(false);
    }
  };

  useEffect(() => {
    if (isAddingFolder && folderInputRef.current) {
      folderInputRef.current.focus();
    }
  }, [isAddingFolder]);

  return (
    <div className="flex flex-col w-full h-full border-t border-border bg-background-sidebar sidebar-gradient">
      {/* macOS title bar drag region */}
      <div data-tauri-drag-region className="h-7 w-full shrink-0" />
      {/* Search bar + New Note button */}
      <div className="flex items-center gap-2 px-3 pt-1 pb-2">
        <div className="relative flex-1">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-secondary" />
          <input
            type="text"
            data-search-input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("notes.searchPlaceholder")}
            className="w-full pl-8 pr-3 py-1.5 rounded-lg text-xs bg-transparent border border-border text-text placeholder:text-text-secondary focus:outline-none focus:border-border transition-colors"
          />
        </div>
        <button
          onClick={onNewNote}
          data-ui
          className="w-8 h-8 flex items-center justify-center rounded-full bg-background-ui text-white hover:bg-background-ui/90 transition-colors shrink-0"
          title={t("sessions.newNote")}
        >
          <Plus size={16} strokeWidth={2} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Folders section */}
        <div className="px-3 pb-2">
          <div className="flex items-center justify-between mb-1">
            <button
              onClick={() => setFoldersExpanded(!foldersExpanded)}
              className="flex items-center gap-1 text-xs font-medium text-text-secondary uppercase tracking-wide hover:text-text transition-colors font-display"
            >
              {foldersExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              {t("notes.folders", "Folders")}
            </button>
            <button
              onClick={() => setIsAddingFolder(true)}
              className="p-0.5 rounded hover:bg-accent-soft text-text-secondary hover:text-text transition-colors"
            >
              <Plus size={12} />
            </button>
          </div>

          {/* Add folder input */}
          {foldersExpanded && isAddingFolder && (
            <div className="flex items-center gap-1 mb-1">
              <input
                ref={folderInputRef}
                type="text"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAddFolder();
                  if (e.key === "Escape") {
                    setIsAddingFolder(false);
                    setNewFolderName("");
                  }
                }}
                placeholder={t("notes.newFolderName", "Folder name")}
                className="flex-1 px-2 py-1 text-xs rounded border border-border bg-transparent text-text focus:outline-none focus:border-accent"
              />
              <button
                onClick={handleAddFolder}
                className="p-1 rounded hover:bg-accent-soft text-accent"
              >
                <Plus size={12} />
              </button>
              <button
                onClick={() => {
                  setIsAddingFolder(false);
                  setNewFolderName("");
                }}
                className="p-1 rounded hover:bg-accent-soft text-text-secondary"
              >
                <X size={12} />
              </button>
            </div>
          )}

          {/* All Notes and Folder list */}
          {foldersExpanded && (
            <>
              <button
                onClick={() => selectFolder(null)}
                className={`flex items-center gap-2 w-full px-2 py-1.5 rounded-lg text-sm transition-colors ${
                  selectedFolderId === null ? "bg-accent/10 text-accent" : "text-text hover:bg-accent-soft"
                }`}
              >
                <FolderOpen size={16} />
                <span className="flex-1 text-left">{t("notes.allNotes", "All Notes")}</span>
                <span className="text-xs text-text-secondary">{folderCounts.all}</span>
              </button>

              {folders.map((folder) => (
                <div
                  key={folder.id}
                  className={`group relative flex items-center gap-2 w-full px-2 py-1.5 rounded-lg text-sm transition-colors cursor-pointer ${
                    selectedFolderId === folder.id ? "bg-accent/10 text-accent" : "text-text hover:bg-accent-soft"
                  }`}
                  onClick={() => selectFolder(folder.id)}
                >
                  <FolderIcon size={16} style={folder.color ? { color: folder.color } : undefined} />
                  <span className="flex-1 text-left truncate">{folder.name}</span>
                  <span className="text-xs text-text-secondary group-hover:opacity-0 transition-opacity">{folderCounts[folder.id] || 0}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteFolder(folder.id);
                    }}
                    className="absolute right-2 p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-red-500/10 text-text-secondary hover:text-red-400 transition-all"
                    title={t("notes.deleteFolder", "Delete folder")}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </>
          )}
        </div>

        {/* Tags section */}
        {tags.length > 0 && (
          <div className="px-3 pb-2">
            <span className="text-xs font-medium text-text-secondary uppercase tracking-wide block mb-1 font-display">
              {t("notes.tags", "Tags")}
            </span>
            <div className="flex flex-wrap gap-1">
              {tags.map((tag) => (
                <button
                  key={tag.id}
                  onClick={() => toggleTagFilter(tag.id)}
                  className={`px-2 py-0.5 rounded-full text-xs transition-colors ${
                    selectedTagIds.includes(tag.id)
                      ? "bg-background-ui text-white"
                      : "bg-accent-soft text-text hover:bg-accent/20"
                  }`}
                  style={tag.color && !selectedTagIds.includes(tag.id) ? { backgroundColor: `${tag.color}20`, color: tag.color } : undefined}
                >
                  {tag.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Divider */}
        <div className="border-t border-border mx-3 my-2" />

        {/* Notes list */}
        <div className="px-3 pb-2">
          <button
            onClick={() => setNotesExpanded(!notesExpanded)}
            className="flex items-center gap-1 text-xs font-medium text-text-secondary uppercase tracking-wide hover:text-text transition-colors mb-1 font-display"
          >
            {notesExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {t("notes.notes", "Notes")}
            <span className="text-text-secondary/50 ml-1">({filteredSessions.length})</span>
          </button>
        </div>
        {notesExpanded && (
          <div className="px-2">
            {dateGroupOrder.map((group) => {
              const sessionsInGroup = groupedSessions[group];
              if (sessionsInGroup.length === 0) return null;

              return (
                <div key={group}>
                  <div className="px-2.5 py-1.5 text-xs font-medium text-text-secondary font-display">
                    {t(`notes.dateGroups.${group}`)}
                  </div>
                  {sessionsInGroup.map((session) => {
                    const isSelected = selectedId === session.id;
                    const isRecordingThis = recordingSessionId === session.id;

                    return (
                      <div
                        key={session.id}
                        className={`group flex items-start gap-2 px-2.5 py-2 rounded-lg cursor-pointer transition-colors mb-0.5 ${
                          isSelected ? "bg-accent/10" : "hover:bg-accent-soft"
                        }`}
                        onClick={() => onSelect(session.id)}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            {isRecordingThis && (
                              <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse shrink-0" />
                            )}
                            <span
                              data-ui
                              className={`text-sm line-clamp-2 break-words ${
                                isSelected ? "font-medium text-text" : "text-text"
                              }`}
                            >
                              {session.title}
                            </span>
                          </div>
                          <div data-ui className="text-xs text-text-secondary mt-0.5">
                            {formatDate(session.started_at)}
                          </div>
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteConfirmId(session.id);
                          }}
                          className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-red-500/10 text-text-secondary hover:text-red-400 transition-all shrink-0"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Global Chat */}
      <div className="border-t border-border">
        {/* Chat messages (when expanded) */}
        {chatExpanded && (
          <>
            {/* Resize handle with collapse button */}
            <div className="flex items-center group">
              <div
                onMouseDown={handleResizeStart}
                className="flex-1 h-2 cursor-ns-resize flex items-center justify-center"
              >
                <div className="w-8 h-0.5 rounded-full bg-border group-hover:bg-text-secondary transition-colors" />
              </div>
              <button
                onClick={() => setChatExpanded(false)}
                className="px-1.5 py-0.5 text-text-secondary hover:text-text transition-colors"
              >
                <ChevronDown size={12} />
              </button>
            </div>
            <div style={{ height: chatHeight }} className="overflow-y-auto px-3 py-2 space-y-2">
            {globalChat.messages.length === 0 ? (
              <p className="text-xs text-text-secondary text-center py-4">
                {t("chat.askAboutNotes", "Ask anything about your notes...")}
              </p>
            ) : (
              globalChat.messages.map((msg, i) => (
                <div key={i} className={`text-xs ${msg.role === "user" ? "flex justify-end" : ""}`}>
                  {msg.role === "user" ? (
                    <div className="bg-accent/10 text-text rounded-lg px-2.5 py-1.5 max-w-[85%]">
                      <span className="whitespace-pre-wrap select-text cursor-text">{msg.content}</span>
                    </div>
                  ) : msg.content ? (
                    <div className="text-text select-text cursor-text [&_ul]:list-disc [&_ul]:ml-4 [&_ol]:list-decimal [&_ol]:ml-4 [&_li]:my-0.5 [&_p]:my-1 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_strong]:font-semibold [&_code]:bg-mid-gray/10 [&_code]:px-1 [&_code]:rounded">
                      <ReactMarkdown>{msg.content}</ReactMarkdown>
                    </div>
                  ) : (
                    <Loader2 size={16} className="animate-spin text-text-secondary" />
                  )}
                </div>
              ))
            )}
            {globalChat.error && (
              <div className="text-xs text-red-400 px-1">{globalChat.error}</div>
            )}
            <div ref={chatEndRef} />
          </div>
          </>
        )}

        {/* Chat input bar */}
        <div className="flex items-center gap-2 px-3 py-3">
          <button
            onClick={() => setChatExpanded(!chatExpanded)}
            className={`p-1.5 rounded-md transition-colors ${
              chatExpanded ? "bg-accent-soft text-accent" : "text-text-secondary hover:bg-accent-soft hover:text-text"
            }`}
          >
            <Sparkles size={16} />
          </button>
          <input
            ref={chatInputRef}
            type="text"
            value={globalChat.input}
            onChange={(e) => globalChat.setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                setChatExpanded(true);
                globalChat.handleSubmit();
              }
            }}
            onFocus={() => setChatExpanded(true)}
            placeholder={t("chat.placeholder", "Ask about your notes...")}
            className="flex-1 text-xs bg-transparent outline-none placeholder:text-text-secondary min-w-0"
          />
          {globalChat.isLoading ? (
            <button
              onClick={globalChat.stop}
              className="p-1 rounded-md text-text-secondary hover:text-text transition-colors"
            >
              <X size={16} />
            </button>
          ) : (
            globalChat.input.trim() && (
              <button
                onClick={() => {
                  setChatExpanded(true);
                  globalChat.handleSubmit();
                }}
                className="p-1 rounded-md text-accent hover:text-accent/70 transition-colors"
              >
                <Send size={16} />
              </button>
            )
          )}
        </div>
      </div>

      {/* Bottom: settings + collapse */}
      <div className="flex items-center justify-between px-3 h-[50px] border-t border-border">
        <button
          onClick={onOpenSettings}
          className="relative p-2 rounded-lg hover:bg-accent-soft text-text-secondary hover:text-text transition-colors"
        >
          <Settings size={20} />
          {suggestionCount > 0 && (
            <span className="absolute top-1 right-1 w-2 h-2 bg-amber-500 rounded-full" />
          )}
        </button>
        {onCollapse && (
          <button
            onClick={onCollapse}
            className="p-2 rounded-lg hover:bg-accent-soft text-text-secondary hover:text-text transition-colors"
            title={t("notes.collapseSidebar")}
          >
            <PanelLeftClose size={20} />
          </button>
        )}
      </div>

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={deleteConfirmId !== null}
        title={t("sessions.deleteConfirmTitle")}
        message={t("sessions.deleteConfirmMessage")}
        variant="danger"
        onConfirm={() => {
          if (deleteConfirmId) {
            onDelete(deleteConfirmId);
          }
          setDeleteConfirmId(null);
        }}
        onCancel={() => setDeleteConfirmId(null)}
      />
    </div>
  );
};
