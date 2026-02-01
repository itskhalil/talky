import React, { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Plus, Trash2, Settings, Search, PanelLeftClose } from "lucide-react";

interface Session {
  id: string;
  title: string;
  started_at: number;
  ended_at: number | null;
  status: string;
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
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const displayedSessions = searchResults ?? sessions;

  return (
    <div className="flex flex-col w-full h-full border-t border-border bg-background-sidebar">
      <div className="px-3 pt-3 pb-2">
        <button
          onClick={onNewNote}
          data-ui
          className="flex items-center justify-center gap-2 w-full px-3 py-2 rounded-lg text-base font-medium transition-colors bg-accent-soft text-accent hover:bg-accent/10 border border-border"
        >
          <Plus size={15} strokeWidth={1.5} />
          {t("sessions.newNote")}
        </button>
      </div>

      {/* Search */}
      <div className="px-3 pb-2">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-secondary" />
          <input
            type="text"
            data-search-input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("notes.searchPlaceholder")}
            className="w-full pl-8 pr-3 py-1.5 rounded-lg text-xs bg-transparent border border-border text-text placeholder:text-text-secondary focus:outline-none focus:border-border transition-colors"
          />
        </div>
      </div>

      {/* Notes list */}
      <div className="flex-1 overflow-y-auto px-2">
        {displayedSessions.map((session) => {
          const isSelected = selectedId === session.id;
          const isRecordingThis = recordingSessionId === session.id;

          return (
            <div
              key={session.id}
              className={`group flex items-start gap-2 px-2.5 py-2 rounded-lg cursor-pointer transition-colors mb-0.5 ${isSelected
                ? "bg-accent-soft"
                : "hover:bg-accent-soft"
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
                    className={`text-sm line-clamp-2 break-words ${isSelected ? "font-medium text-text" : "text-text"
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
                  onDelete(session.id);
                }}
                className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-red-500/10 text-text-secondary hover:text-red-400 transition-all shrink-0"
              >
                <Trash2 size={13} />
              </button>
            </div>
          );
        })}
      </div>

      {/* Bottom: settings + collapse */}
      <div className="flex items-center justify-between px-3 py-3 border-t border-border">
        <button
          onClick={onOpenSettings}
          className="p-2 rounded-lg hover:bg-accent-soft text-text-secondary hover:text-text transition-colors"
        >
          <Settings size={17} />
        </button>
        {onCollapse && (
          <button
            onClick={onCollapse}
            className="p-2 rounded-lg hover:bg-accent-soft text-text-secondary hover:text-text transition-colors"
            title={t("notes.collapseSidebar")}
          >
            <PanelLeftClose size={17} />
          </button>
        )}
      </div>
    </div>
  );
};
