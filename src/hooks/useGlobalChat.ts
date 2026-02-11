import { useState, useCallback, useRef } from "react";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { streamText, tool, wrapLanguageModel } from "ai";
import { hermesToolMiddleware } from "@ai-sdk-tool/parser";
import { z } from "zod";
import * as chrono from "chrono-node";
import { commands } from "@/bindings";
import { getEffectiveEnvironment } from "@/hooks/useEffectiveEnvironment";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface UseGlobalChatOptions {
  // Optional: preload context from a specific note (for in-note global chat)
  currentNoteId?: string;
  getCurrentTranscript?: () => string;
  getCurrentNotes?: () => string;
  // Optional: use a specific environment instead of the default (for LLM calls)
  environmentId?: string | null;
  // Optional: filter search results to only include notes from this environment
  filterEnvironmentId?: string | null;
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
      const trimmed = (messageOverride ?? input).trim();
      if (!trimmed || isLoading) return;

      // Get the environment - prefer note's environment, fall back to default
      const {
        environment,
        baseUrl,
        apiKey,
        chatModel: model,
      } = getEffectiveEnvironment(options.environmentId);

      if (!environment) {
        setError(
          "No environment configured. Go to Settings > Environments to set one up.",
        );
        return;
      }

      if (!model) {
        setError(
          "No chat model configured. Go to Settings > Environments to set one up.",
        );
        return;
      }

      const isOllama = baseUrl.includes("localhost:11434");
      const effectiveApiKey = isOllama && !apiKey ? "ollama" : apiKey;

      setError(null);

      const userMessage: ChatMessage = { role: "user", content: trimmed };
      const newMessages = [...messages, userMessage];
      setMessages(newMessages);
      setInput("");
      setIsLoading(true);

      // Flush pending audio before getting transcript (for in-note chat)
      if (options.currentNoteId) {
        try {
          await commands.flushPendingAudio(options.currentNoteId);
        } catch {
          // Non-fatal
        }
      }

      // Build context from current note if provided
      let currentNoteContext = "";
      let contextInstructions = "";
      if (
        options.currentNoteId &&
        options.getCurrentTranscript &&
        options.getCurrentNotes
      ) {
        // Fetch current session info for title/date and enhanced notes
        let currentTitle = "Unknown";
        let currentDate = "";
        let enhancedNotes = "";
        try {
          const [sessionResult, notesResult] = await Promise.all([
            commands.getSession(options.currentNoteId),
            commands.getMeetingNotes(options.currentNoteId),
          ]);
          if (sessionResult.status === "ok" && sessionResult.data) {
            currentTitle = sessionResult.data.title;
            currentDate = new Date(
              sessionResult.data.started_at * 1000,
            ).toLocaleDateString();
          }
          if (notesResult.status === "ok" && notesResult.data?.enhanced_notes) {
            enhancedNotes = notesResult.data.enhanced_notes;
          }
        } catch {
          // Non-fatal
        }

        const transcript = options.getCurrentTranscript();
        const userNotes = options.getCurrentNotes();

        // If we have enhanced notes, use those instead of transcript (less redundant)
        const contentSection = enhancedNotes
          ? `### Enhanced Notes (AI Summary)\n${enhancedNotes}`
          : `### Transcript\n${transcript || "(No transcript yet)"}`;

        currentNoteContext = `
## CURRENT NOTE: "${currentTitle}" (${currentDate})

### User's Notes
${userNotes || "(No notes taken)"}

${contentSection}

---
`;
        contextInstructions = `
For questions about THIS note (${currentTitle} from ${currentDate}): Answer directly from the context.
For questions about OTHER notes or DIFFERENT dates: Use the searchNotes tool.
`;
      }

      // Fetch recent meeting titles for context
      let recentMeetingsList = "";
      try {
        const sessionsResult = await commands.getSessions();
        if (sessionsResult.status === "ok") {
          let recentSessions = sessionsResult.data;

          // Filter by environment if filterEnvironmentId is set
          if (options.filterEnvironmentId) {
            const { environment: defaultEnv } = getEffectiveEnvironment(null);
            const defaultEnvId = defaultEnv?.id ?? null;
            const filterEnvId = options.filterEnvironmentId;

            recentSessions = recentSessions.filter((s) => {
              const noteEnvId = s.environment_id ?? defaultEnvId;
              return noteEnvId === filterEnvId;
            });
          }

          recentSessions = recentSessions.slice(0, 20);
          if (recentSessions.length > 0) {
            recentMeetingsList = `
## RECENT MEETINGS
${recentSessions.map((s) => `- ${s.title} (${new Date(s.started_at * 1000).toLocaleDateString()})`).join("\n")}

`;
          }
        }
      } catch {
        // Non-fatal
      }

      const today = new Date().toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });
      const systemPrompt = `You are a helpful assistant for meeting notes. Today is ${today}.

Tool: searchNotes
- terms: Search by meeting titles, person names, or topics (e.g. "standup", "sync", "budget"). Use words from the RECENT MEETINGS list.
- dateHint: Use "yesterday", "last week", or unambiguous dates like "February 3" (NOT numeric formats like 03/02)
- Returns full content for 1-3 matches, snippets for more
${contextInstructions}
CRITICAL: Maximum brevity. Prefer terse bullets (2-4 words). Skip names/assignees unless asked. Sentences OK when clearer, but keep short.

${recentMeetingsList}${currentNoteContext}`;

      console.log("[global-chat] === REQUEST ===");
      console.log("[global-chat] system prompt:", systemPrompt);
      console.log("[global-chat] messages:", newMessages);

      const abortController = new AbortController();
      abortRef.current = abortController;

      try {
        // Build the AI SDK provider based on base_url
        let aiModel;
        const isAnthropic = baseUrl.includes("anthropic.com");
        if (isAnthropic) {
          const anthropic = createAnthropic({
            apiKey: effectiveApiKey,
            baseURL: baseUrl,
          });
          aiModel = anthropic(model);
        } else {
          const openai = createOpenAI({
            apiKey: effectiveApiKey,
            baseURL: baseUrl,
          });
          aiModel = openai.chat(model);
        }

        // Wrap model with tool middleware for providers that don't support native tools
        const supportsNativeTools =
          baseUrl.includes("anthropic.com") || baseUrl.includes("openai.com");
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
            inputSchema: z.object({
              terms: z
                .array(z.string())
                .describe(
                  "Search terms - person names, topics, keywords. Matches notes containing ANY of these.",
                ),
              dateHint: z
                .string()
                .optional()
                .describe(
                  "Date filter: 'yesterday', 'last week', 'February 2nd', etc.",
                ),
            }),
            execute: async ({
              terms,
              dateHint,
            }: {
              terms: string[];
              dateHint?: string;
            }) => {
              // Search for each term and merge results
              const allResults = new Map<
                string,
                {
                  id: string;
                  title: string;
                  started_at: number;
                  environment_id: string | null;
                }
              >();

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
                    result.data.forEach((note) =>
                      allResults.set(note.id, note),
                    );
                  }
                }
              }

              let notes = Array.from(allResults.values());

              // Apply environment filter if provided
              // Notes with null environment_id are treated as belonging to the default environment
              if (options.filterEnvironmentId) {
                const { environment: defaultEnv } =
                  getEffectiveEnvironment(null);
                const defaultEnvId = defaultEnv?.id ?? null;
                const filterEnvId = options.filterEnvironmentId;

                notes = notes.filter((n) => {
                  // If note has no environment_id, it belongs to default environment
                  const noteEnvId = n.environment_id ?? defaultEnvId;
                  return noteEnvId === filterEnvId;
                });
              }

              // Apply date filter if provided
              if (dateHint) {
                const parsed = chrono.parse(dateHint, new Date());
                console.log("[global-chat] date filter:", {
                  dateHint,
                  parsed: parsed.map((p) => ({
                    start: p.start.date(),
                    end: p.end?.date(),
                  })),
                });
                if (parsed.length > 0) {
                  const ref = parsed[0];
                  // Use start of day for filtering (midnight to midnight)
                  const startDate = ref.start.date();
                  startDate.setHours(0, 0, 0, 0);
                  const endDate = ref.end?.date() ?? new Date(startDate);
                  if (!ref.end) {
                    endDate.setHours(23, 59, 59, 999);
                  }
                  console.log("[global-chat] filtering notes:", {
                    startDate: startDate.toISOString(),
                    endDate: endDate.toISOString(),
                    noteCount: notes.length,
                    noteDates: notes.map((n) => ({
                      title: n.title,
                      date: new Date(n.started_at * 1000).toISOString(),
                    })),
                  });
                  notes = notes.filter((n) => {
                    const d = new Date(n.started_at * 1000);
                    const matches = d >= startDate && d <= endDate;
                    console.log("[global-chat] note filter:", {
                      title: n.title,
                      noteDate: d.toISOString(),
                      matches,
                    });
                    return matches;
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
                      date: new Date(
                        note.started_at * 1000,
                      ).toLocaleDateString(),
                      userNotes:
                        notesResult.status === "ok"
                          ? notesResult.data?.user_notes || ""
                          : "",
                      enhancedNotes:
                        notesResult.status === "ok"
                          ? notesResult.data?.enhanced_notes || ""
                          : "",
                      transcript:
                        transcriptResult.status === "ok"
                          ? transcriptResult.data
                              .map((seg) => `[${seg.source}] ${seg.text}`)
                              .join("\n")
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
            console.log(
              "[global-chat] tool-result:",
              part.toolName,
              part.output,
            );
            collectedToolResults.push({
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              result: part.output,
            });
          } else if (part.type === "tool-call") {
            console.log("[global-chat] tool-call:", part.toolName, part);
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

        console.log("[global-chat] === RESPONSE ===");
        console.log(
          "[global-chat] text:",
          textContent.slice(0, 500) || "(no text)",
        );
        console.log("[global-chat] tool results:", collectedToolResults.length);

        // Strip any raw tool call JSON from the response (from middleware)
        // This handles both "just JSON" and "JSON followed by text" cases
        const jsonPattern =
          /```json\s*\{[^}]*"name"\s*:\s*"[^"]+"\s*,[^}]*\}\s*```/g;
        const cleanedText = textContent.replace(jsonPattern, "").trim();

        // Update display with cleaned text
        if (cleanedText !== textContent) {
          textContent = cleanedText;
          setMessages((prev) => {
            const updated = [...prev];
            updated[assistantIdx] = {
              ...updated[assistantIdx],
              content: cleanedText,
            };
            return updated;
          });
        }

        // Manual multi-step: if we got tool results but no meaningful text, make a follow-up call
        if (collectedToolResults.length > 0 && !textContent.trim()) {
          // Format tool results as text for the follow-up
          const toolResultsText = collectedToolResults
            .map(
              (tr) =>
                `Tool "${tr.toolName}" returned:\n${JSON.stringify(tr.result, null, 2)}`,
            )
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
              content:
                "Based on those results, please answer my original question.",
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
            if (
              prev[prev.length - 1]?.role === "assistant" &&
              !prev[prev.length - 1].content
            ) {
              const updated = [...prev];
              updated[updated.length - 1] = {
                role: "assistant",
                content: `Error: ${errorMsg}`,
              };
              return updated;
            }
            return [
              ...prev,
              { role: "assistant", content: `Error: ${errorMsg}` },
            ];
          });
        }
      } finally {
        abortRef.current = null;
        setIsLoading(false);
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
