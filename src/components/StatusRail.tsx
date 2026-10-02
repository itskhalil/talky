import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, Check, Mic } from "lucide-react";
import { useUpdateChecker } from "@/components/update-checker/UpdateChecker";
import { useSessionStore } from "@/stores/sessionStore";
import { useModelStore } from "@/stores/modelStore";
import { useSettings } from "@/hooks/useSettings";
import { commands } from "@/bindings";

function formatElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const h = Math.floor(secs / 3600);
  const mm = String(Math.floor((secs % 3600) / 60)).padStart(2, "0");
  const ss = String(secs % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * The window's status line. It only reports things that change or are worth
 * a glance: what's recording (click to go back to it), background work, and
 * which microphone is listening. Everything here is machine state, so mono.
 */
export function StatusRail({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useTranslation();
  const isRecording = useSessionStore((s) => s.isRecording);
  const recordingSessionId = useSessionStore((s) => s.recordingSessionId);
  const recordingSession = useSessionStore((s) =>
    s.sessions.find((x) => x.id === s.recordingSessionId),
  );
  const recordingTranscript = useSessionStore((s) =>
    s.recordingSessionId ? s.cache[s.recordingSessionId]?.transcript : null,
  );
  const selectSession = useSessionStore((s) => s.selectSession);
  const downloadProgress = useModelStore((s) => s.downloadProgress);
  const extracting = useModelStore((s) => s.extractingModels.size > 0);
  const { getSetting, updateSetting, audioDevices, refreshAudioDevices } =
    useSettings();
  const {
    updateAvailable,
    updateChecksEnabled,
    isInstalling,
    downloadProgress: updateProgress,
    installUpdate,
  } = useUpdateChecker();

  // Recorded time continues across Record/Resume: segments carry on from
  // the last segment's end, so start the clock from that.
  const [run, setRun] = useState<{ since: number; baseMs: number } | null>(
    null,
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isRecording) {
      setRun(null);
      return;
    }
    const baseMs = (recordingTranscript ?? []).reduce(
      (max, seg) => Math.max(max, seg.end_ms),
      0,
    );
    setRun((r) => r ?? { since: Date.now(), baseMs });
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
    // The base is captured once per run; later segments are on the run clock.
  }, [isRecording, recordingSessionId]);

  const download = useMemo(() => {
    const first = downloadProgress?.values().next();
    return first && !first.done ? first.value : null;
  }, [downloadProgress]);

  // Microphone: the setting, or the system default's real name.
  const micSetting = getSetting("selected_microphone");
  const isDefaultMic = !micSetting || micSetting.toLowerCase() === "default";
  const systemDefault = audioDevices.find(
    (d) => d.is_default && d.name.toLowerCase() !== "default",
  );
  const micLabel = isDefaultMic
    ? (systemDefault?.name ?? t("status.defaultMic"))
    : micSetting;

  // Load the device list once so the system default shows its real name.
  useEffect(() => {
    if (audioDevices.length === 0) void refreshAudioDevices();
    // Only on mount; the picker refreshes when it opens.
  }, []);

  // Word suggestions waiting for review (Settings › custom words).
  const [suggestionCount, setSuggestionCount] = useState(0);
  useEffect(() => {
    const fetchCount = async () => {
      const suggestions = await commands.getWordSuggestions();
      setSuggestionCount(suggestions.length);
    };
    void fetchCount();
    window.addEventListener("word-suggestions-changed", fetchCount);
    window.addEventListener("focus", fetchCount);
    return () => {
      window.removeEventListener("word-suggestions-changed", fetchCount);
      window.removeEventListener("focus", fetchCount);
    };
  }, []);

  const [micOpen, setMicOpen] = useState(false);
  const micRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!micOpen) return;
    void refreshAudioDevices();
    const onDown = (e: MouseEvent) => {
      if (!micRef.current?.contains(e.target as Node)) setMicOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [micOpen, refreshAudioDevices]);

  // Buttons reset text-transform, so the uppercase is repeated on each item.
  const item = "flex items-center gap-1.5 h-full px-1.5 -mx-1.5 uppercase";

  return (
    <div className="h-6 shrink-0 flex items-center gap-4 px-3 border-t border-border bg-background-sidebar font-mono text-label uppercase tracking-[0.05em] text-text-secondary select-none">
      <span className="text-text">{t("status.app")}</span>
      {isRecording && recordingSessionId ? (
        <button
          onClick={() => selectSession(recordingSessionId)}
          title={t("status.goToRecording")}
          className={`${item} min-w-0 hover:bg-accent/5 hover:text-text transition-colors`}
        >
          <span className="text-text">{t("status.rec")}</span>
          <span>{formatElapsed(run ? run.baseMs + (now - run.since) : 0)}</span>
          {recordingSession?.title && (
            <span className="truncate normal-case tracking-normal font-sans text-xs">
              {recordingSession.title}
            </span>
          )}
        </button>
      ) : download ? (
        <span className={item}>
          {t("status.downloading", {
            percent: Math.round(download.percentage ?? 0),
          })}
        </span>
      ) : extracting ? (
        <span className={item}>{t("status.preparing")}</span>
      ) : (
        <span className={`${item} text-mid-gray`}>{t("status.ready")}</span>
      )}

      <span className="flex-1" />

      {suggestionCount > 0 && (
        <button
          onClick={onOpenSettings}
          className={`${item} hover:bg-accent/5 hover:text-text transition-colors`}
        >
          {t("status.suggestions", { count: suggestionCount })}
        </button>
      )}

      {updateChecksEnabled && updateAvailable && (
        <button
          onClick={installUpdate}
          disabled={isInstalling}
          className={`${item} text-text hover:bg-accent/5 transition-colors disabled:opacity-60`}
        >
          <ArrowDown size={11} className="shrink-0" />
          {isInstalling
            ? updateProgress === 100
              ? t("footer.installing")
              : updateProgress > 0
                ? t("footer.downloading", {
                    progress: updateProgress.toString().padStart(3),
                  })
                : t("footer.preparing")
            : t("status.update")}
        </button>
      )}

      <div ref={micRef} className="relative h-full">
        <button
          onClick={() => setMicOpen((o) => !o)}
          title={t("status.changeMic")}
          className={`${item} max-w-[260px] hover:bg-accent/5 hover:text-text transition-colors ${micOpen ? "bg-accent/5 text-text" : ""}`}
        >
          <Mic size={11} className="shrink-0" />
          <span className="truncate">{micLabel}</span>
        </button>
        {micOpen && (
          <div className="absolute bottom-full right-0 mb-1 z-40 min-w-[240px] p-1 bg-background border border-border-strong rounded-lg shadow-lg normal-case tracking-normal font-sans">
            {audioDevices.map((d) => {
              const selected = isDefaultMic
                ? d.name.toLowerCase() === "default"
                : d.name === micSetting;
              return (
                <button
                  key={d.index + d.name}
                  onClick={async () => {
                    setMicOpen(false);
                    await updateSetting("selected_microphone", d.name);
                  }}
                  className="flex items-center gap-2 w-full h-[30px] px-2.5 rounded-md text-left text-ui text-text hover:bg-accent/5"
                >
                  <span className="flex-1 truncate">
                    {d.name.toLowerCase() === "default"
                      ? t("status.systemDefault")
                      : d.name}
                  </span>
                  {selected && <Check size={13} />}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
