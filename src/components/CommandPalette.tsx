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
} from "lucide-react";
import { useSessionStore, type Session } from "@/stores/sessionStore";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

type CommandId =
  | "new-note"
  | "toggle-recording"
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
  session: Session;
}

interface CommandResult {
  kind: "command";
  command: PaletteCommand;
}

type Result = CommandResult | NoteResult;

function scoreMatch(haystack: string, needle: string): number {
  if (!needle) return 1;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (h === n) return 100;
  if (h.startsWith(n)) return 80;
  if (h.includes(n)) return 50;
  return 0;
}

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

  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [noteResults, setNoteResults] = useState<Session[] | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setQuery("");
      setActiveIndex(0);
      setNoteResults(null);
      return;
    }
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (!q) {
      setNoteResults(null);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const results = await invoke<Session[]>("search_sessions", {
          query: q,
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
  }, [query, isOpen]);

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

      const hasEnhanced = !!selectedCache?.enhancedNotes;
      list.push({
        id: "export-current",
        label: t("palette.commands.exportCurrent"),
        icon: <Download size={16} />,
        run: () => {
          close();
          store.openExportDialog("single", hasEnhanced);
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
    if (q) {
      const source = noteResults ?? sessions;
      notes = source
        .map((s) => ({ session: s, score: scoreMatch(s.title, q) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 20)
        .map<NoteResult>((x) => ({ kind: "note", session: x.session }));
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
      useSessionStore.getState().selectSession(r.session.id);
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
    query.trim() && results.some((r) => r.kind === "note");
  const showingCommandsHeader = results.some((r) => r.kind === "command");

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
                    renderedIndex++;
                    const isActive = renderedIndex === activeIndex;
                    const cmd = (r as CommandResult).command;
                    return (
                      <button
                        key={`cmd-${cmd.id}`}
                        data-palette-index={renderedIndex}
                        onMouseEnter={() => setActiveIndex(renderedIndex)}
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
                    renderedIndex++;
                    const isActive = renderedIndex === activeIndex;
                    const note = (r as NoteResult).session;
                    return (
                      <button
                        key={`note-${note.id}`}
                        data-palette-index={renderedIndex}
                        onMouseEnter={() => setActiveIndex(renderedIndex)}
                        onClick={() => runResult(r)}
                        className={`flex items-center gap-2.5 w-full px-3 py-2 text-sm text-left transition-colors ${
                          isActive ? "bg-accent/10 text-text" : "text-text"
                        }`}
                      >
                        <span className="text-text-secondary shrink-0">
                          <FileText size={16} />
                        </span>
                        <span className="flex-1 truncate">{note.title}</span>
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
