import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import { ArrowUp, ChevronDown, Loader, Plus, Square } from "lucide-react";
import { useGlobalChat } from "@/hooks/useGlobalChat";
import { useSettingsStore } from "@/stores/settingsStore";
import { useSessionStore } from "@/stores/sessionStore";
import { useNavigationStore } from "@/stores/navigationStore";

/**
 * Home: what you see with no note open. Asking across notes lives here, always
 * within one environment, plus a short list of recent notes.
 */
export function HomeView() {
  const { t } = useTranslation();
  const sessions = useSessionStore((s) => s.sessions);
  const selectSession = useSessionStore((s) => s.selectSession);
  const createNote = useSessionStore((s) => s.createNote);
  const pendingAsk = useNavigationStore((s) => s.pendingAsk);

  const settings = useSettingsStore((s) => s.settings);
  const environments = settings?.model_environments ?? [];
  const defaultEnvId =
    settings?.default_environment_id ?? environments[0]?.id ?? null;
  const multiEnv = environments.length >= 2;

  const [envId, setEnvId] = useState<string | null>(defaultEnvId);
  const [envMenuOpen, setEnvMenuOpen] = useState(false);
  const [queued, setQueued] = useState<string | null>(null);
  const envMenuRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const env = environments.find((e) => e.id === envId);
  const chat = useGlobalChat({
    environmentId: envId,
    filterEnvironmentId: envId,
  });
  const hasConversation = chat.messages.length > 0;

  // A question handed over from the palette starts a fresh conversation in
  // the environment it was asked in.
  useEffect(() => {
    if (!pendingAsk) return;
    const pending = useNavigationStore.getState().consumePendingAsk();
    if (!pending) return;
    chat.clearMessages();
    setEnvId(pending.environmentId ?? defaultEnvId);
    setQueued(pending.question);
  }, [pendingAsk]);

  // Submit once the cleared conversation and new environment have rendered.
  useEffect(() => {
    if (queued && chat.messages.length === 0 && !chat.isLoading) {
      const q = queued;
      setQueued(null);
      void chat.handleSubmit(q);
    }
  }, [queued, chat.messages.length, chat.isLoading, chat.handleSubmit]);

  useEffect(() => {
    if (hasConversation) endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat.messages, hasConversation]);

  useEffect(() => {
    if (!envMenuOpen) return;
    const handle = (e: MouseEvent) => {
      if (envMenuRef.current && !envMenuRef.current.contains(e.target as Node))
        setEnvMenuOpen(false);
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [envMenuOpen]);

  const chooseEnv = (id: string) => {
    if (id !== envId) chat.clearMessages();
    setEnvId(id);
    setEnvMenuOpen(false);
    inputRef.current?.focus();
  };

  const recent = useMemo(() => sessions.slice(0, 8), [sessions]);

  const submit = () => {
    if (!chat.input.trim()) return;
    void chat.handleSubmit();
  };

  const envChip = multiEnv && (
    <div ref={envMenuRef} className="relative shrink-0">
      <button
        onClick={() => setEnvMenuOpen((o) => !o)}
        aria-label={t("home.chooseEnv")}
        className={`flex items-center gap-1.5 h-7 px-2 rounded-md border text-xs text-text-secondary transition-colors ${
          envMenuOpen ? "border-border-strong bg-accent/5" : "border-border"
        }`}
      >
        {env && (
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{ backgroundColor: env.color }}
          />
        )}
        <span>{t("home.envNotes", { env: env?.name ?? "" })}</span>
        <ChevronDown size={11} />
      </button>
      {envMenuOpen && (
        <div className="absolute bottom-full right-0 mb-1 z-20 min-w-[180px] p-1 bg-background border border-border rounded-lg shadow-lg">
          {environments.map((e) => (
            <button
              key={e.id}
              onClick={() => chooseEnv(e.id)}
              className={`flex items-center gap-2 w-full h-[30px] px-2.5 rounded-md text-left text-[13px] text-text ${
                e.id === envId ? "bg-accent/8" : "hover:bg-accent/5"
              }`}
            >
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{ backgroundColor: e.color }}
              />
              {t("home.envNotes", { env: e.name })}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  const askBar = (
    <div className="flex items-center gap-2 h-[46px] pl-3.5 pr-1.5 rounded-lg border border-border bg-background shadow-[0_1px_2px_rgba(0,0,0,0.04),0_6px_20px_rgba(0,0,0,0.06)]">
      <input
        ref={inputRef}
        data-chat-input
        value={chat.input}
        onChange={(e) => chat.setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={
          hasConversation ? t("home.followUp") : t("home.placeholder")
        }
        className="flex-1 min-w-0 bg-transparent outline-none text-sm text-text placeholder:text-mid-gray"
      />
      {envChip}
      {chat.isLoading ? (
        <button
          onClick={chat.stop}
          aria-label={t("home.stop")}
          className="w-[30px] h-[30px] shrink-0 flex items-center justify-center rounded-md border border-border text-text-secondary hover:text-text"
        >
          <Square size={12} fill="currentColor" />
        </button>
      ) : (
        <button
          onClick={submit}
          disabled={!chat.input.trim()}
          aria-label={t("sessions.chat.send")}
          className="w-[30px] h-[30px] shrink-0 flex items-center justify-center rounded-md bg-background-ui text-white border border-background-ui dark:border-border-strong disabled:opacity-40"
        >
          <ArrowUp size={15} strokeWidth={2.2} />
        </button>
      )}
    </div>
  );

  return (
    <div className="flex flex-col h-full">
      <div data-tauri-drag-region className="h-8 w-full shrink-0" />
      <div className="flex-1 overflow-y-auto">
        <div className="w-full max-w-[640px] mx-auto px-6 pt-10 pb-6">
          {hasConversation ? (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-2">
                {multiEnv && env && (
                  <span className="flex items-center gap-1.5 text-xs text-text-secondary">
                    <span
                      className="w-1.5 h-1.5 rounded-full"
                      style={{ backgroundColor: env.color }}
                    />
                    {t("home.envNotes", { env: env.name })}
                  </span>
                )}
                <span className="flex-1" />
                <button
                  onClick={() => {
                    chat.clearMessages();
                    inputRef.current?.focus();
                  }}
                  className="text-xs text-text-secondary hover:text-text"
                >
                  {t("home.newQuestion")}
                </button>
              </div>
              {chat.messages.map((msg, i) =>
                msg.role === "user" ? (
                  <div
                    key={i}
                    className="self-end max-w-[80%] px-3 py-2 rounded-lg bg-accent-soft text-sm text-text whitespace-pre-wrap select-text"
                  >
                    {msg.content}
                  </div>
                ) : msg.content ? (
                  <div
                    key={i}
                    className="text-sm leading-relaxed text-text select-text [&_ul]:list-disc [&_ul]:ml-5 [&_ol]:list-decimal [&_ol]:ml-5 [&_li]:my-0.5 [&_p]:my-2 [&_p:first-child]:mt-0 [&_strong]:font-semibold [&_code]:font-mono [&_code]:text-[0.9em]"
                  >
                    <ReactMarkdown>{msg.content}</ReactMarkdown>
                  </div>
                ) : (
                  <Loader
                    key={i}
                    size={16}
                    className="animate-spin-slow text-text-secondary"
                  />
                ),
              )}
              {chat.error && (
                <div className="text-xs text-red-500">{chat.error}</div>
              )}
              <div ref={endRef} />
            </div>
          ) : (
            <>
              <h1 className="text-[30px] font-normal tracking-[-0.03em] leading-tight text-text">
                {sessions.length > 0 ? t("home.title") : t("home.emptyTitle")}
              </h1>
              {sessions.length === 0 ? (
                <div className="mt-3 flex flex-col items-start gap-4">
                  <p className="text-sm text-text-secondary">
                    {t("home.emptyBody")}
                  </p>
                  <button
                    onClick={() => void createNote()}
                    className="flex items-center gap-1.5 h-8 px-3 rounded-md bg-background-ui text-white text-sm font-medium border border-background-ui dark:border-border-strong"
                  >
                    <Plus size={14} strokeWidth={2} />
                    {t("sessions.newNote")}
                  </button>
                </div>
              ) : (
                <>
                  <div className="mt-5">{askBar}</div>
                  <div className="mt-10 pb-1.5 border-b border-border-strong font-display text-[11px] uppercase text-text-secondary">
                    {t("home.recent")}
                  </div>
                  {recent.map((s) => {
                    const date = new Date(s.started_at * 1000);
                    return (
                      <button
                        key={s.id}
                        onClick={() => selectSession(s.id)}
                        className="grid grid-cols-[96px_52px_minmax(0,1fr)] gap-3 items-center w-full h-9 px-1 border-b border-border text-left hover:bg-accent/4"
                      >
                        <span className="font-mono text-xs text-text-secondary">
                          {date.toLocaleDateString(undefined, {
                            weekday: "short",
                            day: "2-digit",
                            month: "short",
                          })}
                        </span>
                        <span className="font-mono text-xs text-mid-gray">
                          {date.toLocaleTimeString(undefined, {
                            hour: "2-digit",
                            minute: "2-digit",
                            hour12: false,
                          })}
                        </span>
                        <span className="truncate text-sm font-medium text-text">
                          {s.title}
                        </span>
                      </button>
                    );
                  })}
                </>
              )}
            </>
          )}
        </div>
      </div>
      {hasConversation && (
        <div className="shrink-0 w-full max-w-[640px] mx-auto px-6 pb-5">
          {askBar}
        </div>
      )}
    </div>
  );
}
