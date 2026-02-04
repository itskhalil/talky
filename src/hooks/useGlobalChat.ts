import { useState, useCallback, useRef } from "react";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { streamText, tool, wrapLanguageModel } from "ai";
import { hermesToolMiddleware } from "@ai-sdk-tool/parser";
import { z } from "zod";
import * as chrono from "chrono-node";
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
    if (!settings) {
      return;
    }

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

    const systemPrompt = `You are a helpful assistant for meeting notes.
${currentNoteContext}
Tool: searchNotes
- Search by person names, topics, or keywords using the "terms" array
- Add dateHint for time filtering: "yesterday", "last week", "February 2nd", etc.
- Returns full content for 1-3 matches, snippets for more

Examples:
- "What did Klau discuss?" → searchNotes({terms: ["Klau"]})
- "Meetings last week?" → searchNotes({terms: [], dateHint: "last week"})
- "Action items from testing meeting?" → searchNotes({terms: ["testing", "action items"]})

Be concise. Summarize content, don't dump raw transcripts. Reference note titles when relevant.`;

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

      // Wrap model with tool middleware for providers that don't support native tools
      const supportsNativeTools = ["anthropic", "openai"].includes(providerId);
      const finalModel = supportsNativeTools
        ? aiModel
        : wrapLanguageModel({
            model: aiModel,
            middleware: hermesToolMiddleware,
          });

      const apiMessages = newMessages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

      // Single smart tool that adapts based on result count
      const tools = {
        searchNotes: tool({
          description:
            "Search meeting notes. Returns full content for few matches, snippets for many. Use for any question about note content.",
          parameters: z.object({
            terms: z
              .array(z.string())
              .describe(
                "Search terms - person names, topics, keywords. Matches notes containing ANY of these.",
              ),
            dateHint: z
              .string()
              .optional()
              .describe("Date filter: 'yesterday', 'last week', 'February 2nd', etc."),
          }),
          execute: async ({ terms, dateHint }: { terms: string[]; dateHint?: string }) => {
            // Search for each term and merge results
            const allResults = new Map<string, { id: string; title: string; started_at: number }>();

            if (terms.length === 0) {
              // No terms - get all recent notes
              const result = await commands.getSessions();
              if (result.status === "ok") {
                result.data.forEach((note) => allResults.set(note.id, note));
              }
            } else {
              // Search for each term
              for (const term of terms) {
                const result = await commands.searchSessions(term);
                if (result.status === "ok") {
                  result.data.forEach((note) => allResults.set(note.id, note));
                }
              }
            }

            let notes = Array.from(allResults.values());

            // Apply date filter if provided
            if (dateHint) {
              const parsed = chrono.parse(dateHint, new Date());
              if (parsed.length > 0) {
                const ref = parsed[0];
                const after = ref.start.date();
                const before = ref.end?.date() ?? new Date(after.getTime() + 86400000);
                notes = notes.filter((n) => {
                  const d = new Date(n.started_at * 1000);
                  return d >= after && d <= before;
                });
              }
            }

            if (notes.length === 0) {
              return { message: "No matching notes found." };
            }

            // Adaptive response based on count
            if (notes.length <= 3) {
              // Few matches → return FULL content
              return Promise.all(
                notes.map(async (note) => {
                  const [notesResult, transcriptResult] = await Promise.all([
                    commands.getMeetingNotes(note.id),
                    commands.getSessionTranscript(note.id),
                  ]);
                  return {
                    title: note.title,
                    date: new Date(note.started_at * 1000).toLocaleDateString(),
                    userNotes:
                      notesResult.status === "ok" ? notesResult.data?.user_notes || "" : "",
                    enhancedNotes:
                      notesResult.status === "ok" ? notesResult.data?.enhanced_notes || "" : "",
                    transcript:
                      transcriptResult.status === "ok"
                        ? transcriptResult.data.map((seg) => `[${seg.source}] ${seg.text}`).join("\n")
                        : "",
                  };
                }),
              );
            } else {
              // Many matches → return snippets only
              return {
                message: `Found ${notes.length} matching notes. Here are the titles:`,
                notes: notes.slice(0, 10).map((n) => ({
                  title: n.title,
                  date: new Date(n.started_at * 1000).toLocaleDateString(),
                })),
                hint: "Ask about a specific note for full details.",
              };
            }
          },
        }),
      };

      const result = streamText({
        model: finalModel,
        system: systemPrompt,
        messages: apiMessages,
        tools,
        maxSteps: 5,
        abortSignal: abortController.signal,
      });

      // Add empty assistant message and stream into it
      const assistantIdx = newMessages.length;
      setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

      const resolved = await result;

      // Collect tool results for manual multi-step
      const collectedToolResults: Array<{
        toolCallId: string;
        toolName: string;
        result: unknown;
      }> = [];

      let textContent = "";
      for await (const part of resolved.fullStream) {
        if (abortController.signal.aborted) break;

        // Collect tool results for manual multi-step
        if (part.type === "tool-result") {
          collectedToolResults.push({
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            result: part.output,
          });
        } else if (part.type === "text-delta") {
          // Try possible property names for the text delta
          const delta =
            (part as { textDelta?: string }).textDelta ??
            (part as { delta?: string }).delta ??
            (part as { text?: string }).text ??
            "";
          if (delta) {
            textContent += delta;
            setMessages((prev) => {
              const updated = [...prev];
              updated[assistantIdx] = {
                ...updated[assistantIdx],
                content: textContent,
              };
              return updated;
            });
          }
        }
      }

      // Manual multi-step: if we got tool results but no text, make a follow-up call
      if (collectedToolResults.length > 0 && !textContent.trim()) {
        // Format tool results as text for the follow-up
        const toolResultsText = collectedToolResults
          .map((tr) => `Tool "${tr.toolName}" returned:\n${JSON.stringify(tr.result, null, 2)}`)
          .join("\n\n");

        // Build follow-up messages with tool results as assistant context
        const followUpMessages = [
          ...apiMessages,
          {
            role: "assistant" as const,
            content: `I searched your notes. Here are the results:\n\n${toolResultsText}`,
          },
          {
            role: "user" as const,
            content: "Based on those results, please answer my original question.",
          },
        ];

        // Make follow-up call with base model (no middleware) for plain text response
        const followUp = streamText({
          model: aiModel,
          system: systemPrompt,
          messages: followUpMessages,
          abortSignal: abortController.signal,
        });

        const followUpResolved = await followUp;
        for await (const part of followUpResolved.fullStream) {
          if (abortController.signal.aborted) break;

          if (part.type === "text-delta") {
            const delta =
              (part as { textDelta?: string }).textDelta ??
              (part as { delta?: string }).delta ??
              (part as { text?: string }).text ??
              "";
            if (delta) {
                textContent += delta;
              setMessages((prev) => {
                const updated = [...prev];
                updated[assistantIdx] = {
                  ...updated[assistantIdx],
                  content: textContent,
                };
                return updated;
              });
            }
          }
        }
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
