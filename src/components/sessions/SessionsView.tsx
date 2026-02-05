import { useEffect, useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { StickyNote, PanelLeftOpen, Settings } from "lucide-react";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { NotesSidebar } from "../NotesSidebar";
import { NoteView } from "./NoteView";
import {
  useSessionStore,
  useSelectedSession,
  useTranscript,
  useUserNotes,
  useEnhancedNotes,
  useSummary,
  useSelectedCache,
  useEnhanceLoading,
  useEnhanceError,
} from "@/stores/sessionStore";

interface SessionsViewProps {
  onOpenSettings: () => void;
}

function EmptyState({ onNewNote }: { onNewNote: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center h-full text-text-secondary gap-4">
      <StickyNote size={40} strokeWidth={1} className="opacity-25" />
      <p className="text-sm">{t("notes.emptyState")}</p>
      <button
        onClick={onNewNote}
        data-ui
        className="text-sm px-4 py-2 bg-accent-soft rounded-lg hover:bg-accent/10 transition-colors text-accent border border-border"
      >
        {t("sessions.newNote")}
      </button>
    </div>
  );
}

export function SessionsView({ onOpenSettings }: SessionsViewProps) {
  const { t } = useTranslation();
  const sessions = useSessionStore((s) => s.sessions);
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);
  const recordingSessionId = useSessionStore((s) => s.recordingSessionId);
  const isRecording = useSessionStore((s) => s.isRecording);
  const amplitude = useSessionStore((s) => s.amplitude);
  const notesLoaded = useSessionStore((s) => s.notesLoaded);
  const summaryLoading = useSessionStore((s) => s.summaryLoading);
  const summaryError = useSessionStore((s) => s.summaryError);
  const enhanceLoading = useEnhanceLoading();
  const enhanceError = useEnhanceError();
  const viewMode = useSessionStore((s) => s.viewMode);
  const showEnhancePrompt = useSessionStore((s) =>
    s.selectedSessionId ? s.showEnhancePrompt[s.selectedSessionId] ?? false : false
  );

  const session = useSelectedSession();
  const transcript = useTranscript();
  const userNotes = useUserNotes();
  const enhancedNotes = useEnhancedNotes();
  const summary = useSummary();
  const selectedCache = useSelectedCache();

  const {
    initialize,
    selectSession,
    createNote,
    startRecording,
    stopRecording,
    deleteSession,
    updateTitle,
    setUserNotes,
    setEnhancedNotes,
    generateSummary,
    enhanceNotes,
    dismissEnhancePrompt,
    setViewMode,
    cleanup,
  } = useSessionStore.getState();

  const [findBarOpen, setFindBarOpen] = useState(false);

  // Resizable sidebar
  const SIDEBAR_MIN = 200;
  const SIDEBAR_MAX = 400;
  const SIDEBAR_DEFAULT = 260;
  const SIDEBAR_STORAGE_KEY = "talky-sidebar-width";
  const SIDEBAR_COLLAPSED_KEY = "talky-sidebar-collapsed";

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = localStorage.getItem(SIDEBAR_STORAGE_KEY);
    return stored ? Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Number(stored))) : SIDEBAR_DEFAULT;
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
  });
  const isDragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;
      dragStartX.current = e.clientX;
      dragStartWidth.current = sidebarWidth;

      const onMouseMove = (ev: MouseEvent) => {
        if (!isDragging.current) return;
        const delta = ev.clientX - dragStartX.current;
        const newWidth = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, dragStartWidth.current + delta));
        setSidebarWidth(newWidth);
      };

      const onMouseUp = () => {
        isDragging.current = false;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [sidebarWidth],
  );

  const handleDragDoubleClick = useCallback(() => {
    setSidebarCollapsed((prev) => !prev);
  }, []);

  const toggleFindBar = useCallback(() => {
    setFindBarOpen((prev) => !prev);
  }, []);

  const closeFindBar = useCallback(() => {
    setFindBarOpen(false);
  }, []);

  useKeyboardShortcuts({
    onOpenSettings,
    onToggleFindBar: toggleFindBar,
    onCloseFindBar: closeFindBar,
    findBarOpen,
  });

  useEffect(() => {
    initialize();
    return () => cleanup();
  }, []);

  const isSelectedRecording =
    isRecording && recordingSessionId === selectedSessionId;

  return (
    <div className="flex h-full">
      {sidebarCollapsed ? (
        <div className="flex flex-col items-center justify-end py-3 px-1 border-r border-t border-border bg-background-sidebar h-full">
          <div className="flex flex-col items-center gap-1">
            <button
              onClick={onOpenSettings}
              className="p-2 rounded-lg hover:bg-accent-soft text-text-secondary hover:text-text transition-colors"
            >
              <Settings size={20} />
            </button>
            <button
              onClick={() => setSidebarCollapsed(false)}
              className="p-2 rounded-lg hover:bg-accent-soft text-text-secondary hover:text-text transition-colors"
              title={t("notes.expandSidebar")}
            >
              <PanelLeftOpen size={20} />
            </button>
          </div>
        </div>
      ) : (
        <>
          <div style={{ width: sidebarWidth, minWidth: sidebarWidth }}>
            <NotesSidebar
              sessions={sessions}
              selectedId={selectedSessionId}
              recordingSessionId={isRecording ? recordingSessionId : null}
              onSelect={selectSession}
              onNewNote={createNote}
              onDelete={deleteSession}
              onOpenSettings={onOpenSettings}
              onCollapse={() => setSidebarCollapsed(true)}
            />
          </div>
          {/* Drag handle */}
          <div
            className="w-1 cursor-col-resize hover:bg-accent/20 active:bg-accent/30 transition-colors shrink-0"
            onMouseDown={handleDragStart}
            onDoubleClick={handleDragDoubleClick}
          />
        </>
      )}
      <div className="flex-1 overflow-hidden">
        {selectedSessionId ? (
          <NoteView
            key={selectedSessionId}
            session={session}
            isRecording={isSelectedRecording}
            amplitude={amplitude}
            transcript={transcript}
            userNotes={userNotes}
            notesLoaded={notesLoaded || !!selectedCache}
            summary={summary}
            summaryLoading={summaryLoading}
            summaryError={summaryError}
            onNotesChange={setUserNotes}
            onEnhancedNotesChange={setEnhancedNotes}
            onTitleChange={updateTitle}
            onStartRecording={() => startRecording(selectedSessionId)}
            onStopRecording={stopRecording}
            onGenerateSummary={generateSummary}
            enhancedNotes={enhancedNotes}
            enhancedNotesEdited={selectedCache?.enhancedNotesEdited ?? false}
            showEnhancePrompt={showEnhancePrompt}
            onEnhanceNotes={enhanceNotes}
            onDismissEnhancePrompt={() => dismissEnhancePrompt(selectedSessionId)}
            enhanceLoading={enhanceLoading}
            enhanceError={enhanceError}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            findBarOpen={findBarOpen}
            onCloseFindBar={closeFindBar}
          />
        ) : (
          <EmptyState onNewNote={createNote} />
        )}
      </div>
    </div>
  );
}
