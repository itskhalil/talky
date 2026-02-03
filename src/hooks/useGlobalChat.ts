import { useState, useCallback, useRef } from "react";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { streamText, tool } from "ai";
import { z } from "zod";
import { commands } from "@/bindings";
import { useSettingsStore } from "@/stores/settingsStore";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface UseGlobalChatOptions {
  // Optional: preload context from a specific note (for in-note global chat)
  currentNoteId?: string;
  getCurrentTranscript?: () => string;
  getCurrentNotes?: () => string;
}

export function useGlobalChat(options: UseGlobalChatOptions = {}) {
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

    const providerId =
      settings.chat_provider_id || settings.post_process_provider_id || "openai";
    const provider = settings.post_process_providers?.find(
      (p) => p.id === providerId,
    );
    if (!provider) {
      setError("No provider configured. Go to Chat settings to set one up.");
      return;
    }

    const apiKey = settings.post_process_api_keys?.[providerId] ?? "";
    const model =
      settings.chat_models?.[providerId] ??
      settings.post_process_models?.[providerId] ??
      "";

    if (!model) {
      setError("No model configured. Go to Chat settings to set one up.");
      return;
    }

    const isOllama = providerId === "ollama";
    const effectiveApiKey = isOllama && !apiKey ? "ollama" : apiKey;

    setError(null);

    const userMessage: ChatMessage = { role: "user", content: trimmed };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput("");
    setIsLoading(true);

    // Build context from current note if provided
    let currentNoteContext = "";
    if (options.currentNoteId && options.getCurrentTranscript && options.getCurrentNotes) {
      const transcript = options.getCurrentTranscript();
      const notes = options.getCurrentNotes();
      currentNoteContext = `
## CURRENT NOTE CONTEXT
You are viewing a specific note. Here is its content:

### User's Notes
${notes || "(No notes taken)"}

### Transcript
${transcript || "(No transcript yet)"}

---
`;
    }

    const systemPrompt = `You are a helpful assistant that can answer questions about the user's meeting notes.
${currentNoteContext}
You have access to tools to search across all notes and retrieve note content. Use them when needed.

When answering:
- Be concise and helpful
- If you search for notes, summarize what you found
- If you retrieve a note's content, reference the note title
- If information isn't available, say so`;

    const abortController = new AbortController();
    abortRef.current = abortController;

    try {
      // Build the AI SDK provider
      let aiModel;
      if (providerId === "anthropic") {
        const anthropic = createAnthropic({
          apiKey: effectiveApiKey,
          baseURL: provider.base_url,
        });
        aiModel = anthropic(model);
      } else {
        const openai = createOpenAI({
          apiKey: effectiveApiKey,
          baseURL: provider.base_url,
        });
        aiModel = openai.chat(model);
      }

      const apiMessages = newMessages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

      // Define tools for searching and retrieving notes
      const tools = {
        searchNotes: tool({
          description: "Search across all notes by keyword. Returns matching note titles and IDs.",
          parameters: z.object({
            query: z.string().describe("The search query to find relevant notes"),
          }),
          execute: async ({ query }) => {
            const result = await commands.searchSessions(query);
            if (result.status === "ok") {
              return result.data.slice(0, 10).map((s) => ({
                id: s.id,
                title: s.title,
                date: new Date(s.started_at * 1000).toLocaleDateString(),
              }));
            }
            return [];
          },
        }),
        getNoteContent: tool({
          description: "Get the full content of a specific note including transcript and user notes.",
          parameters: z.object({
            noteId: z.string().describe("The ID of the note to retrieve"),
          }),
          execute: async ({ noteId }) => {
            const [notesResult, transcriptResult, sessionResult] = await Promise.all([
              commands.getMeetingNotes(noteId),
              commands.getSessionTranscript(noteId),
              commands.getSession(noteId),
            ]);

            const title = sessionResult.status === "ok" ? sessionResult.data?.title : "Unknown";
            const userNotes = notesResult.status === "ok" ? notesResult.data?.user_notes : "";
            const enhancedNotes = notesResult.status === "ok" ? notesResult.data?.enhanced_notes : "";
            const transcript = transcriptResult.status === "ok"
              ? transcriptResult.data.map((seg) => `[${seg.source}] ${seg.text}`).join("\n")
              : "";

            return {
              title,
              userNotes: userNotes || "(No notes)",
              enhancedNotes: enhancedNotes || "(No enhanced notes)",
              transcript: transcript || "(No transcript)",
            };
          },
        }),
        listRecentNotes: tool({
          description: "List the most recent notes.",
          parameters: z.object({
            limit: z.number().optional().describe("Number of notes to return (default 10)"),
          }),
          execute: async ({ limit = 10 }) => {
            const result = await commands.getSessions();
            if (result.status === "ok") {
              return result.data.slice(0, limit).map((s) => ({
                id: s.id,
                title: s.title,
                date: new Date(s.started_at * 1000).toLocaleDateString(),
              }));
            }
            return [];
          },
        }),
      };

      const result = streamText({
        model: aiModel,
        system: systemPrompt,
        messages: apiMessages,
        tools,
        maxSteps: 5, // Allow multiple tool calls
        abortSignal: abortController.signal,
      });

      // Add empty assistant message and stream into it
      const assistantIdx = newMessages.length;
      setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

      const resolved = await result;

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
    } catch (err: unknown) {
      console.error("[global-chat] error:", err);
      if (err instanceof Error && err.name === "AbortError") {
        // User aborted
      } else {
        const errorMsg = err instanceof Error ? err.message : String(err);
        setError(errorMsg);
        setMessages((prev) => {
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
    }
  }, [input, isLoading, messages, options]);

  return {
    messages,
    input,
    setInput,
    handleSubmit,
    isLoading,
    stop,
    clearMessages,
    error,
  };
}
