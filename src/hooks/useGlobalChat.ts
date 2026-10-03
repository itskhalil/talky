import { useState, useCallback, useRef } from "react";
import { commands } from "@/bindings";
import { getEffectiveEnvironment } from "@/hooks/useEffectiveEnvironment";
import { useSettingsStore } from "@/stores/settingsStore";
import {
  acrossNotesPrompt,
  ask,
  buildModel,
  noteTools,
  oneNotePrompt,
  type AskSource,
  type NoteSource,
  type NoteSummary,
} from "@/lib/ask";
import type { Session } from "@/bindings";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  // The notes an answer drew on (asking across notes only).
  sources?: AskSource[];
}

interface UseGlobalChatOptions {
  // Ask about this one note (its content goes in the prompt, no tools).
  currentNoteId?: string;
  getCurrentTranscript?: () => string;
  getCurrentNotes?: () => string;
  // The environment whose model answers.
  environmentId?: string | null;
  // The environment whose notes the tools may return when asking across notes.
  filterEnvironmentId?: string | null;
}

const summary = (s: Session): NoteSummary => ({
  id: s.id,
  title: s.title,
  startedAt: s.started_at,
  environmentId: s.environment_id,
});

/** The app's notes, through Tauri commands. */
const tauriNotes: NoteSource = {
  async search(query) {
    const r = await commands.searchSessions(query, null, null, null, null);
    if (r.status !== "ok") throw new Error(r.error);
    // A note can match in several places; keep its first (best) hit.
    const seen = new Set<string>();
    return r.data
      .filter((hit) => !seen.has(hit.session.id) && seen.add(hit.session.id))
      .map((hit) => ({ ...summary(hit.session), snippet: hit.snippet }));
  },
  async list() {
    const r = await commands.getSessions();
    if (r.status !== "ok") throw new Error(r.error);
    return r.data.map(summary);
  },
  async get(id) {
    const r = await commands.getSession(id);
    return r.status === "ok" && r.data ? summary(r.data) : null;
  },
  async read(id) {
    const [notes, transcript] = await Promise.all([
      commands.getMeetingNotes(id),
      commands.getSessionTranscript(id),
    ]);
    return {
      userNotes: notes.status === "ok" ? (notes.data?.user_notes ?? "") : "",
      enhancedNotes:
        notes.status === "ok" ? (notes.data?.enhanced_notes ?? "") : "",
      transcript:
        transcript.status === "ok"
          ? transcript.data.map((s) => `[${s.source}] ${s.text}`).join("\n")
          : "",
    };
  },
};

export function useGlobalChat(options: UseGlobalChatOptions = {}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsLoading(false);
  }, []);

  const clearMessages = useCallback(() => {
    stop();
    setMessages([]);
    setError(null);
  }, [stop]);

  const handleInputFocus = useCallback(async () => {
    if (options.currentNoteId) {
      try {
        await commands.flushPendingAudio(options.currentNoteId);
      } catch {
        // Non-fatal
      }
    }
  }, [options.currentNoteId]);

  const handleSubmit = useCallback(
    async (messageOverride?: string) => {
      const question = (messageOverride ?? input).trim();
      if (!question || isLoading) return;

      const {
        environment,
        baseUrl,
        apiKey,
        chatModel: model,
      } = getEffectiveEnvironment(options.environmentId);
      if (!environment || !model) {
        setError(
          "No chat model configured. Go to Settings > AI environments to set one up.",
        );
        return;
      }

      const history = [
        ...messages,
        { role: "user" as const, content: question },
      ];
      setMessages([...history, { role: "assistant", content: "" }]);
      setInput("");
      setError(null);
      setIsLoading(true);

      const controller = new AbortController();
      abortRef.current = controller;
      const userName =
        useSettingsStore.getState().settings?.user_name?.trim() || undefined;
      const setAnswer = (content: string) =>
        setMessages((prev) => {
          const next = [...prev];
          next[next.length - 1] = { ...next[next.length - 1], content };
          return next;
        });
      const setSources = (sources: AskSource[]) =>
        setMessages((prev) => {
          const next = [...prev];
          next[next.length - 1] = { ...next[next.length - 1], sources };
          return next;
        });

      try {
        let system: string;
        let tools: ReturnType<typeof noteTools> | undefined;
        if (options.currentNoteId) {
          // One note: include it, with the transcript as captured so far.
          try {
            await commands.flushPendingAudio(options.currentNoteId);
          } catch {
            // Non-fatal
          }
          const [session, notes] = await Promise.all([
            commands.getSession(options.currentNoteId),
            commands.getMeetingNotes(options.currentNoteId),
          ]);
          const s = session.status === "ok" ? session.data : null;
          const enhanced =
            notes.status === "ok" ? (notes.data?.enhanced_notes ?? "") : "";
          system = oneNotePrompt(
            {
              title: s?.title ?? "Untitled",
              date: s ? new Date(s.started_at * 1000).toLocaleDateString() : "",
              userNotes: options.getCurrentNotes?.() ?? "",
              // Enhanced notes already summarise the transcript.
              content: enhanced
                ? `### Enhanced notes\n${enhanced}`
                : `### Transcript\n${options.getCurrentTranscript?.() || "(none yet)"}`,
            },
            userName,
          );
        } else {
          const envId = options.filterEnvironmentId ?? environment.id;
          const defaultEnvId =
            useSettingsStore.getState().settings?.default_environment_id ??
            null;
          system = acrossNotesPrompt(userName);
          tools = noteTools(tauriNotes, envId, defaultEnvId);
        }

        await ask({
          model: buildModel({ baseUrl, apiKey, model }),
          system,
          messages: history.map(({ role, content }) => ({ role, content })),
          tools,
          signal: controller.signal,
          onText: setAnswer,
          onSources: setSources,
        });
      } catch (err: unknown) {
        if (controller.signal.aborted) return;
        console.error("[ask] error:", err);
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setAnswer(`Error: ${msg}`);
      } finally {
        // A stopped or replaced question has already reset this.
        if (abortRef.current === controller) {
          abortRef.current = null;
          setIsLoading(false);
        }
      }
    },
    [input, isLoading, messages, options],
  );

  return {
    messages,
    input,
    setInput,
    handleSubmit,
    handleInputFocus,
    isLoading,
    stop,
    clearMessages,
    error,
  };
}
