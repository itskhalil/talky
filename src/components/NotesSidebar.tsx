import React from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2, Settings } from "lucide-react";

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
  activeSessionId: string | undefined;
  isRecording: boolean;
  onSelect: (id: string) => void;
  onNewNote: () => void;
  onDelete: (id: string) => void;
  onOpenSettings: () => void;
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
  activeSessionId,
  isRecording,
  onSelect,
  onNewNote,
  onDelete,
  onOpenSettings,
}) => {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col w-56 h-full border-r border-t border-border bg-background-sidebar">
      <div className="px-3 pt-3 pb-2">
        <button
          onClick={onNewNote}
          data-ui
          className="flex items-center justify-center gap-2 w-full px-3 py-2 rounded-lg text-sm font-medium transition-colors bg-accent-soft text-accent hover:bg-accent/10 border border-border"
        >
          <Plus size={15} strokeWidth={1.5} />
          {t("sessions.newNote")}
        </button>
      </div>

      {/* Notes list */}
      <div className="flex-1 overflow-y-auto px-2">
        {sessions.map((session) => {
          const isSelected = selectedId === session.id;
          const isActive = activeSessionId === session.id;

          return (
            <div
              key={session.id}
              className={`group flex items-start gap-2 px-2.5 py-2 rounded-lg cursor-pointer transition-colors mb-0.5 ${
                isSelected
                  ? "bg-accent-soft"
                  : "hover:bg-accent-soft"
              }`}
              onClick={() => onSelect(session.id)}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  {isActive && isRecording && (
                    <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse shrink-0" />
                  )}
                  <span
                    data-ui
                    className={`text-sm truncate ${
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
              {!isActive && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(session.id);
                  }}
                  className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-red-500/10 text-text-secondary hover:text-red-400 transition-all shrink-0"
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Bottom: settings gear */}
      <div className="px-3 py-3 border-t border-border">
        <button
          onClick={onOpenSettings}
          className="p-2 rounded-lg hover:bg-accent-soft text-text-secondary hover:text-text transition-colors"
        >
          <Settings size={17} />
        </button>
      </div>
    </div>
  );
};
