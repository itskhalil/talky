import React from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2, Settings } from "lucide-react";
import HandyTextLogo from "./icons/HandyTextLogo";

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

function formatDuration(startedAt: number, endedAt: number | null): string {
  const end = endedAt ?? Math.floor(Date.now() / 1000);
  const seconds = end - startedAt;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
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
    <div className="flex flex-col w-56 h-full border-r border-mid-gray/20 bg-background">
      {/* Logo */}
      <div className="flex items-center justify-center px-3 pt-4 pb-2">
        <HandyTextLogo width={100} />
      </div>

      {/* New Note button */}
      <div className="px-3 pb-2">
        <button
          onClick={onNewNote}
          className="flex items-center justify-center gap-2 w-full px-3 py-2 bg-logo-primary/80 rounded-lg hover:bg-logo-primary transition-colors text-sm font-medium"
        >
          <Plus size={16} />
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
              className={`group flex items-start gap-2 px-2 py-2 rounded-lg cursor-pointer transition-colors mb-0.5 ${
                isSelected
                  ? "bg-logo-primary/10"
                  : "hover:bg-mid-gray/10"
              }`}
              onClick={() => onSelect(session.id)}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  {isActive && isRecording && (
                    <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse shrink-0" />
                  )}
                  <span className="text-sm font-medium truncate">
                    {session.title}
                  </span>
                </div>
                <div className="text-xs text-mid-gray mt-0.5">
                  {formatDate(session.started_at)}
                  {" · "}
                  {formatDuration(session.started_at, session.ended_at)}
                </div>
              </div>
              {!isActive && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(session.id);
                  }}
                  className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-red-500/20 text-mid-gray hover:text-red-400 transition-all shrink-0"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Bottom: settings gear */}
      <div className="px-3 py-3 border-t border-mid-gray/20">
        <button
          onClick={onOpenSettings}
          className="p-2 rounded-lg hover:bg-mid-gray/20 text-mid-gray hover:text-foreground transition-colors"
        >
          <Settings size={18} />
        </button>
      </div>
    </div>
  );
};
