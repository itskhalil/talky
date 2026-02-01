import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { StickyNote } from "lucide-react";
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
  const sessions = useSessionStore((s) => s.sessions);
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);
  const recordingSessionId = useSessionStore((s) => s.recordingSessionId);
  const isRecording = useSessionStore((s) => s.isRecording);
  const amplitude = useSessionStore((s) => s.amplitude);
  const notesLoaded = useSessionStore((s) => s.notesLoaded);
  const summaryLoading = useSessionStore((s) => s.summaryLoading);
  const summaryError = useSessionStore((s) => s.summaryError);
  const enhanceLoading = useSessionStore((s) => s.enhanceLoading);
  const enhanceError = useSessionStore((s) => s.enhanceError);
  const viewMode = useSessionStore((s) => s.viewMode);

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
    setViewMode,
    cleanup,
  } = useSessionStore.getState();

  useEffect(() => {
    initialize();
    return () => cleanup();
  }, []);

  const isSelectedRecording =
    isRecording && recordingSessionId === selectedSessionId;

  return (
    <div className="flex h-full">
      <NotesSidebar
        sessions={sessions}
        selectedId={selectedSessionId}
        recordingSessionId={isRecording ? recordingSessionId : null}
        onSelect={selectSession}
        onNewNote={createNote}
        onDelete={deleteSession}
        onOpenSettings={onOpenSettings}
      />
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
            onEnhanceNotes={enhanceNotes}
            enhanceLoading={enhanceLoading}
            enhanceError={enhanceError}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
          />
        ) : (
          <EmptyState onNewNote={createNote} />
        )}
      </div>
    </div>
  );
}
