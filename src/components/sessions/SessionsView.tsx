import { useEffect, useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  getCurrentWindow,
  LogicalSize,
  LogicalPosition,
} from "@tauri-apps/api/window";
import {
  StickyNote,
  PanelLeftOpen,
  PanelLeftClose,
  Settings,
} from "lucide-react";
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
  useStreamingEnhancedNotes,
  useEnhanceStreaming,
} from "@/stores/sessionStore";

interface SessionsViewProps {
  onOpenSettings: () => void;
}

function EmptyState({ onNewNote }: { onNewNote: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col h-full text-text-secondary">
      {/* macOS title bar drag region */}
      <div data-tauri-drag-region className="h-7 w-full shrink-0" />
      <div className="flex-1 flex flex-col items-center justify-center gap-4">
        <StickyNote size={40} strokeWidth={1} className="opacity-25" />
        <p className="text-sm">{t("notes.emptyState")}</p>
        <button
          onClick={onNewNote}
          data-ui
          className="text-sm px-4 py-2 bg-accent/5 rounded-lg hover:bg-accent/10 transition-colors text-accent border border-border"
        >
          {t("sessions.newNote")}
        </button>
      </div>
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
  const streamingEnhancedNotes = useStreamingEnhancedNotes();
  const enhanceStreaming = useEnhanceStreaming();
  const viewMode = useSessionStore((s) => s.viewMode);
  const showEnhancePrompt = useSessionStore((s) =>
    s.selectedSessionId
      ? (s.showEnhancePrompt[s.selectedSessionId] ?? false)
      : false,
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
  const AUTO_COLLAPSE_THRESHOLD = 750;

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = localStorage.getItem(SIDEBAR_STORAGE_KEY);
    return stored
      ? Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Number(stored)))
      : SIDEBAR_DEFAULT;
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
  });
  const isDragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);
  const wasAutoCollapsed = useRef(false);
  const isManuallyExpanding = useRef(false);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  // Auto-collapse/expand sidebar based on window width
  useEffect(() => {
    const handleResize = () => {
      // Skip auto-collapse if we're in the middle of a manual expand
      if (isManuallyExpanding.current) return;

      if (window.innerWidth < AUTO_COLLAPSE_THRESHOLD && !sidebarCollapsed) {
        wasAutoCollapsed.current = true;
        setSidebarCollapsed(true);
      } else if (
        window.innerWidth >= AUTO_COLLAPSE_THRESHOLD &&
        sidebarCollapsed &&
        wasAutoCollapsed.current
      ) {
        wasAutoCollapsed.current = false;
        setSidebarCollapsed(false);
      }
    };

    window.addEventListener("resize", handleResize);
    // Check on mount as well
    handleResize();

    return () => window.removeEventListener("resize", handleResize);
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
        const newWidth = Math.max(
          SIDEBAR_MIN,
          Math.min(SIDEBAR_MAX, dragStartWidth.current + delta),
        );
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

  // Handle manual sidebar expand - resize window if needed
  const handleExpandSidebar = useCallback(async () => {
    isManuallyExpanding.current = true;
    wasAutoCollapsed.current = false;
    if (window.innerWidth < AUTO_COLLAPSE_THRESHOLD) {
      try {
        const appWindow = getCurrentWindow();
        const scaleFactor = await appWindow.scaleFactor();
        const physicalSize = await appWindow.innerSize();
        const physicalPosition = await appWindow.outerPosition();
        const logicalWidth = physicalSize.width / scaleFactor;
        const logicalHeight = physicalSize.height / scaleFactor;
        const logicalX = physicalPosition.x / scaleFactor;
        const logicalY = physicalPosition.y / scaleFactor;
        const widthDelta = AUTO_COLLAPSE_THRESHOLD - logicalWidth;
        // Move window left by the amount we're expanding
        await appWindow.setPosition(
          new LogicalPosition(logicalX - widthDelta, logicalY),
        );
        await appWindow.setSize(
          new LogicalSize(AUTO_COLLAPSE_THRESHOLD, logicalHeight),
        );
      } catch (e) {
        console.error("Failed to resize window:", e);
      }
    }
    setSidebarCollapsed(false);
    isManuallyExpanding.current = false;
  }, []);

  const handleDragDoubleClick = useCallback(() => {
    if (sidebarCollapsed) {
      handleExpandSidebar();
    } else {
      wasAutoCollapsed.current = false;
      setSidebarCollapsed(true);
    }
  }, [sidebarCollapsed, handleExpandSidebar]);

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
    onExpandSidebar: handleExpandSidebar,
  });

  useEffect(() => {
    initialize();
    return () => cleanup();
  }, []);

  const isSelectedRecording =
    isRecording && recordingSessionId === selectedSessionId;

  return (
    <div className="relative flex h-full">
      <button
        onClick={() => {
          if (sidebarCollapsed) {
            handleExpandSidebar();
          } else {
            wasAutoCollapsed.current = false;
            setSidebarCollapsed(true);
          }
        }}
        className="absolute top-0.5 left-[78px] z-10 p-1 rounded hover:bg-accent/10 text-text-secondary hover:text-text transition-colors"
        title={t(
          sidebarCollapsed ? "notes.expandSidebar" : "notes.collapseSidebar",
        )}
      >
        {sidebarCollapsed ? (
          <PanelLeftOpen size={18} />
        ) : (
          <PanelLeftClose size={18} />
        )}
      </button>
      {!sidebarCollapsed && (
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
            onDismissEnhancePrompt={() =>
              dismissEnhancePrompt(selectedSessionId)
            }
            enhanceLoading={enhanceLoading}
            enhanceError={enhanceError}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            findBarOpen={findBarOpen}
            onCloseFindBar={closeFindBar}
            streamingEnhancedNotes={streamingEnhancedNotes}
            enhanceStreaming={enhanceStreaming}
          />
        ) : (
          <EmptyState onNewNote={createNote} />
        )}
      </div>
    </div>
  );
}
