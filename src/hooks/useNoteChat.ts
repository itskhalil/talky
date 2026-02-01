import { useState, useCallback, useRef } from "react";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { streamText } from "ai";
import { commands } from "@/bindings";
import { useSettingsStore } from "@/stores/settingsStore";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface UseNoteChatOptions {
  sessionId: string;
  getTranscript: () => string;
  getUserNotes: () => string;
}

export function useNoteChat({
  sessionId,
  getTranscript,
  getUserNotes,
}: UseNoteChatOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const clearMessages = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setMessages([]);
    setIsLoading(false);
  }, []);

  const stop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setIsLoading(false);
  }, []);

  const handleSubmit = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;

    const settings = useSettingsStore.getState().settings;
    if (!settings) return;

    // Use chat-specific provider, fall back to post-process provider
    const providerId =
      settings.chat_provider_id || settings.post_process_provider_id || "openai";
    const provider = settings.post_process_providers?.find(
      (p) => p.id === providerId,
    );
    if (!provider) {
      setError("No provider configured. Go to Chat settings to set one up.");
      return;
    }

    const apiKey =
      settings.chat_api_keys?.[providerId] ??
      settings.post_process_api_keys?.[providerId] ??
      "";
    const model =
      settings.chat_models?.[providerId] ??
      settings.post_process_models?.[providerId] ??
      "";

    if (!model) {
      setError("No model configured. Go to Chat settings to set one up.");
      return;
    }

    setError(null);

    console.log("[chat] provider:", providerId, "model:", model, "baseURL:", provider.base_url);
    console.log("[chat] apiKey present:", !!apiKey, "length:", apiKey.length);

    // Flush pending audio before sending
    try {
      console.log("[chat] flushing pending audio...");
      await commands.flushPendingAudio(sessionId);
      console.log("[chat] flush done");
    } catch (e) {
      console.warn("[chat] flush error (non-fatal):", e);
    }

    // Get latest transcript & notes
    const transcript = getTranscript();
    const userNotes = getUserNotes();
    console.log("[chat] transcript length:", transcript.length, "notes length:", userNotes.length);

    const userMessage: ChatMessage = { role: "user", content: trimmed };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput("");
    setIsLoading(true);

    const systemPrompt = `You are a helpful assistant answering questions about a meeting. Use the transcript and notes below as context.

## USER'S NOTES
${userNotes || "(No notes taken)"}

## TRANSCRIPT
${transcript || "(No transcript yet)"}

Answer concisely based on the context above. If the information isn't in the context, say so.`;

    const abortController = new AbortController();
    abortRef.current = abortController;

    try {
      // Build the AI SDK provider
      let aiModel;
      if (providerId === "anthropic") {
        console.log("[chat] using Anthropic provider");
        const anthropic = createAnthropic({
          apiKey,
          baseURL: provider.base_url,
        });
        aiModel = anthropic(model);
      } else {
        console.log("[chat] using OpenAI-compatible provider");
        const openai = createOpenAI({
          apiKey,
          baseURL: provider.base_url,
        });
        aiModel = openai.chat(model);
      }

      const apiMessages = newMessages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

      console.log("[chat] calling streamText with", apiMessages.length, "messages");
      const result = streamText({
        model: aiModel,
        system: systemPrompt,
        messages: apiMessages,
        abortSignal: abortController.signal,
      });

      // Add empty assistant message and stream into it
      const assistantIdx = newMessages.length;
      setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

      console.log("[chat] awaiting result...");
      const resolved = await result;
      console.log("[chat] got result, iterating textStream...");

      for await (const chunk of resolved.textStream) {
        if (abortController.signal.aborted) break;
        setMessages((prev) => {
          const updated = [...prev];
          updated[assistantIdx] = {
            ...updated[assistantIdx],
            content: updated[assistantIdx].content + chunk,
          };
          return updated;
        });
      }
      console.log("[chat] stream complete");
    } catch (err: unknown) {
      console.error("[chat] error:", err);
      if (err instanceof Error && err.name === "AbortError") {
        console.log("[chat] aborted by user");
      } else {
        const errorMsg =
          err instanceof Error ? err.message : String(err);
        setError(errorMsg);
        setMessages((prev) => {
          // Add error as assistant message if there isn't one already
          if (prev[prev.length - 1]?.role === "assistant" && !prev[prev.length - 1].content) {
            const updated = [...prev];
            updated[updated.length - 1] = {
              role: "assistant",
              content: `Error: ${errorMsg}`,
            };
            return updated;
          }
          return [...prev, { role: "assistant", content: `Error: ${errorMsg}` }];
        });
      }
    } finally {
      abortRef.current = null;
      setIsLoading(false);
      console.log("[chat] done, isLoading=false");
    }
  }, [input, isLoading, messages, sessionId, getTranscript, getUserNotes]);

  const handleInputFocus = useCallback(async () => {
    try {
      await commands.flushPendingAudio(sessionId);
    } catch {
      // Non-fatal
    }
  }, [sessionId]);

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
