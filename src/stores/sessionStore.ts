import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { toast } from "sonner";
import { commands, type MeetingNotes } from "@/bindings";
import { useSettingsStore } from "./settingsStore";

export interface Session {
  id: string;
  title: string;
  started_at: number;
  ended_at: number | null;
  status: string;
  folder_id: string | null;
}

export interface TranscriptSegment {
  id: number;
  session_id: string;
  text: string;
  source: string;
  start_ms: number;
  end_ms: number;
  created_at: number;
}

interface AmplitudeEvent {
  session_id: string;
  mic: number;
  speaker: number;
}

interface SessionCache {
  transcript: TranscriptSegment[];
  userNotes: string;
  enhancedNotes: string | null;
  enhancedNotesEdited: boolean; // true if user edited after AI generation
  summary: string | null;
  loadedAt: number;
}

// Detect word-level corrections in enhanced notes.
// Only detects words that REPLACE similar words (typo corrections like "Smithe" -> "Smith").
// Pure additions (new words, new lines) are ignored.
function detectWordCorrections(
  oldText: string | null,
  newText: string,
): string[] {
  if (!oldText) return [];

  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  // Find modified line pairs using LCS-based diff
  const modifiedLinePairs = findModifiedLines(oldLines, newLines);

  // For each modified line pair, find words that appear to be corrections
  // (new word that replaces a similar old word)
  const corrections: string[] = [];
  const seen = new Set<string>();

  for (const [oldLine, newLine] of modifiedLinePairs) {
    const lineCorrections = findWordCorrectionsInLine(oldLine, newLine);
    for (const word of lineCorrections) {
      const lowerWord = word.toLowerCase();
      if (!seen.has(lowerWord)) {
        corrections.push(word);
        seen.add(lowerWord);
      }
    }
  }

  return corrections.slice(0, 5); // Limit to 5 suggestions per save
}

// Find word corrections within a single modified line pair.
// Simple rule: if words were removed AND a capitalized word was added, it's a correction.
function findWordCorrectionsInLine(oldLine: string, newLine: string): string[] {
  const extractWords = (text: string): string[] =>
    text.match(/[A-Za-z][A-Za-z0-9'-]*/g) || [];

  const oldWords = extractWords(oldLine);
  const newWords = extractWords(newLine);

  const oldWordSet = new Set(oldWords.map((w) => w.toLowerCase()));
  const newWordSet = new Set(newWords.map((w) => w.toLowerCase()));

  const removedWords = oldWords.filter((w) => !newWordSet.has(w.toLowerCase()));
  const addedWords = newWords.filter((w) => !oldWordSet.has(w.toLowerCase()));

  // Must have removed at least one word (actual replacement, not just appending)
  if (removedWords.length === 0) return [];

  // Common words to ignore
  const commonWords = new Set([
    "the",
    "a",
    "an",
    "and",
    "or",
    "but",
    "in",
    "on",
    "at",
    "to",
    "for",
    "of",
    "with",
    "by",
    "from",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "could",
    "should",
    "may",
    "might",
    "must",
    "can",
    "this",
    "that",
    "these",
    "those",
    "it",
    "its",
    "we",
    "our",
    "you",
    "your",
    "they",
    "their",
    "he",
    "his",
    "she",
    "her",
    "not",
    "all",
    "some",
    "any",
    "no",
    "yes",
    "so",
    "if",
    "then",
  ]);

  const corrections: string[] = [];

  for (const word of addedWords) {
    const lowerWord = word.toLowerCase();

    // Skip common words, short words, long words
    if (commonWords.has(lowerWord)) continue;
    if (word.length < 3 || word.length > 30) continue;

    // Must be capitalized (proper noun or technical term)
    if (
      word[0] === word[0].toUpperCase() &&
      word[0] !== word[0].toLowerCase()
    ) {
      corrections.push(word);
    }
  }

  return corrections;
}

// Find lines that were modified (changed) rather than purely added or removed.
// Returns pairs of [oldLine, newLine] for lines that were modified.
function findModifiedLines(
  oldLines: string[],
  newLines: string[],
): [string, string][] {
  // Compute LCS to identify unchanged lines
  const lcs = computeLCS(oldLines, newLines);

  // Find unmatched lines
  const unmatchedOld: { index: number; line: string }[] = [];
  const unmatchedNew: { index: number; line: string }[] = [];

  for (let i = 0; i < oldLines.length; i++) {
    const isMatched = lcs.some(([oi]) => oi === i);
    if (!isMatched) {
      unmatchedOld.push({ index: i, line: oldLines[i] });
    }
  }

  for (let j = 0; j < newLines.length; j++) {
    const isMatched = lcs.some(([, nj]) => nj === j);
    if (!isMatched) {
      unmatchedNew.push({ index: j, line: newLines[j] });
    }
  }

  // Match unmatched lines to find modifications (vs pure additions/deletions)
  // A modification is when an old line was replaced by a new line with significant overlap
  const modifiedPairs: [string, string][] = [];
  const usedOld = new Set<number>();

  for (const newItem of unmatchedNew) {
    let bestMatch: { index: number; line: string; score: number } | null = null;

    for (const oldItem of unmatchedOld) {
      if (usedOld.has(oldItem.index)) continue;

      // Calculate word overlap score
      const score = wordOverlapScore(oldItem.line, newItem.line);
      if (score > 0.3 && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { ...oldItem, score };
      }
    }

    if (bestMatch) {
      modifiedPairs.push([bestMatch.line, newItem.line]);
      usedOld.add(bestMatch.index);
    }
  }

  return modifiedPairs;
}

// Compute LCS of line indices - returns array of [oldIndex, newIndex] pairs
function computeLCS(
  oldLines: string[],
  newLines: string[],
): [number, number][] {
  const m = oldLines.length;
  const n = newLines.length;

  // DP table for LCS length
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0),
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find the actual LCS pairs
  const result: [number, number][] = [];
  let i = m,
    j = n;
  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      result.unshift([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return result;
}

// Calculate word overlap score between two lines (0-1)
function wordOverlapScore(line1: string, line2: string): number {
  const extractWords = (text: string): string[] =>
    (text.match(/[A-Za-z][A-Za-z0-9'-]*/g) || []).map((w) => w.toLowerCase());

  const words1 = extractWords(line1);
  const words2 = extractWords(line2);

  if (words1.length === 0 && words2.length === 0) return 0;
  if (words1.length === 0 || words2.length === 0) return 0;

  const set1 = new Set(words1);
  const set2 = new Set(words2);

  let intersection = 0;
  for (const word of set1) {
    if (set2.has(word)) intersection++;
  }

  // Jaccard similarity
  const union = set1.size + set2.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/** Strip blank lines and standalone tags from LLM-generated enhanced notes */
function stripBlankLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed === "[ai]" || trimmed === "[noted]") return false;
      if (trimmed.length >= 3 && /^[-*_]+$/.test(trimmed)) return false;
      return true;
    })
    .join("\n");
}

const MAX_CACHE_SIZE = 20;

interface SaveTimers {
  user: ReturnType<typeof setTimeout> | null;
  enhanced: ReturnType<typeof setTimeout> | null;
}

// Stable defaults for selectors — never create new references
const EMPTY_TRANSCRIPT: TranscriptSegment[] = [];

interface EnhanceNotesChunkEvent {
  session_id: string;
  chunk: string;
  done: boolean;
}

interface SessionStore {
  sessions: Session[];
  selectedSessionId: string | null;
  recordingSessionId: string | null;
  isRecording: boolean;
  amplitude: { mic: number; speaker: number };
  cache: Record<string, SessionCache>;
  loading: Record<string, boolean>;
  notesLoaded: boolean;

  // UI state not worth caching
  summaryLoading: boolean;
  summaryError: string | null;
  enhanceLoading: Record<string, boolean>;
  enhanceError: Record<string, string | null>;
  showEnhancePrompt: Record<string, boolean>;
  viewMode: "notes" | "enhanced";

  // Streaming state
  streamingEnhancedNotes: Record<string, string>;
  enhanceStreaming: Record<string, boolean>;

  // Actions
  selectSession: (id: string) => void;
  loadSessions: () => Promise<void>;
  initialize: () => Promise<void>;
  createNote: () => Promise<void>;
  startRecording: (sessionId: string) => Promise<void>;
  stopRecording: () => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  updateTitle: (title: string) => Promise<void>;
  setUserNotes: (notes: string) => void;
  setEnhancedNotes: (tagged: string) => void;
  generateSummary: () => Promise<void>;
  enhanceNotes: () => Promise<void>;
  dismissEnhancePrompt: (sessionId: string) => void;
  setViewMode: (mode: "notes" | "enhanced") => void;
  selectNextSession: () => void;
  selectPreviousSession: () => void;
  deselectSession: () => void;

  // Internal
  _fetchSessionData: (sessionId: string) => Promise<void>;
  _saveTimers: Map<string, SaveTimers>;
  _lastSavedEnhancedNotes: Map<string, string>; // Baseline for correction detection
  _unlisteners: UnlistenFn[];
  _listenersInitialized: boolean;
  _setupListeners: () => Promise<void>;
  _evictCache: () => void;
  cleanup: () => void;
}

export const useSessionStore = create<SessionStore>()((set, get) => ({
  sessions: [],
  selectedSessionId: null,
  recordingSessionId: null,
  isRecording: false,
  amplitude: { mic: 0, speaker: 0 },
  cache: {},
  loading: {},
  notesLoaded: false,

  summaryLoading: false,
  summaryError: null,
  enhanceLoading: {},
  enhanceError: {},
  showEnhancePrompt: {},
  viewMode: "enhanced",

  // Streaming state
  streamingEnhancedNotes: {},
  enhanceStreaming: {},

  _saveTimers: new Map(),
  _lastSavedEnhancedNotes: new Map(),
  _unlisteners: [],
  _listenersInitialized: false,

  selectSession: (id: string) => {
    const state = get();
    // Flush any pending saves for the session we're leaving
    if (state.selectedSessionId) {
      flushSaves(state, state.selectedSessionId);
    }

    const cached = state.cache[id];
    set({
      selectedSessionId: id,
      notesLoaded: !!cached,
      summaryError: null,
      summaryLoading: false,
      viewMode: cached?.enhancedNotes ? "enhanced" : "notes",
    });

    localStorage.setItem("lastSelectedSessionId", id);
    // Skip refetch if already cached and not actively recording
    if (!cached || get().recordingSessionId === id) {
      get()._fetchSessionData(id);
    }
  },

  _fetchSessionData: async (sessionId: string) => {
    const state = get();
    if (state.loading[sessionId]) return;

    const wasAlreadyCached = !!state.cache[sessionId];
    set((s) => ({ loading: { ...s.loading, [sessionId]: true } }));

    try {
      const [transcript, meetingNotes] = await Promise.all([
        invoke<TranscriptSegment[]>("get_session_transcript", { sessionId }),
        invoke<MeetingNotes | null>("get_meeting_notes", { sessionId }),
      ]);
      const enhancedNotes = meetingNotes?.enhanced_notes || null;

      const entry: SessionCache = {
        transcript,
        userNotes: meetingNotes?.user_notes ?? "",
        enhancedNotes,
        enhancedNotesEdited: meetingNotes?.enhanced_notes_edited ?? false,
        summary: meetingNotes?.summary || null,
        loadedAt: Date.now(),
      };

      set((s) => {
        const { [sessionId]: _, ...restLoading } = s.loading;
        // Preserve local enhanced/summary edits that arrived while we were fetching
        const prev = s.cache[sessionId];
        if (prev) {
          if (prev.enhancedNotes && !entry.enhancedNotes) {
            entry.enhancedNotes = prev.enhancedNotes;
          }
          if (prev.summary && !entry.summary) {
            entry.summary = prev.summary;
          }
          // Preserve the edited flag if we preserved the enhanced notes
          if (prev.enhancedNotesEdited) {
            entry.enhancedNotesEdited = prev.enhancedNotesEdited;
          }
        }
        const newCache = { ...s.cache, [sessionId]: entry };
        const updates: Partial<SessionStore> = {
          cache: newCache,
          loading: restLoading,
        };
        if (s.selectedSessionId === sessionId) {
          updates.notesLoaded = true;
          // Only set viewMode on initial load, not background refresh
          if (!wasAlreadyCached) {
            updates.viewMode = enhancedNotes ? "enhanced" : "notes";
          }
        }
        return updates;
      });

      get()._evictCache();
    } catch (e) {
      console.error("Failed to fetch session data:", e);
      set((s) => {
        const { [sessionId]: _, ...restLoading } = s.loading;
        const updates: Partial<SessionStore> = { loading: restLoading };
        if (s.selectedSessionId === sessionId) {
          updates.notesLoaded = true;
        }
        return updates;
      });
    }
  },

  _evictCache: () => {
    const { cache } = get();
    const keys = Object.keys(cache);
    if (keys.length <= MAX_CACHE_SIZE) return;

    const sorted = keys.sort((a, b) => cache[a].loadedAt - cache[b].loadedAt);
    const toEvict = sorted.slice(0, keys.length - MAX_CACHE_SIZE);
    const newCache = { ...cache };
    for (const key of toEvict) {
      delete newCache[key];
    }
    set({ cache: newCache });
  },

  loadSessions: async () => {
    try {
      const result = await invoke<Session[]>("get_sessions");
      set({ sessions: result });
    } catch (e) {
      console.error("Failed to load sessions:", e);
    }
  },

  initialize: async () => {
    const state = get();
    await state.loadSessions();
    await state._setupListeners();

    try {
      const active = await invoke<Session | null>("get_active_session");
      if (active) {
        set({ selectedSessionId: active.id });
        localStorage.setItem("lastSelectedSessionId", active.id);
        const recording = await invoke<boolean>("is_recording");
        if (recording) {
          set({ recordingSessionId: active.id, isRecording: true });
        }
        get()._fetchSessionData(active.id);
        return;
      }
    } catch (e) {
      console.error("Failed to load active session:", e);
    }

    const lastId = localStorage.getItem("lastSelectedSessionId");
    const { sessions } = get();
    if (lastId && sessions.some((s) => s.id === lastId)) {
      set({ selectedSessionId: lastId });
      get()._fetchSessionData(lastId);
    } else if (sessions.length > 0) {
      set({ selectedSessionId: sessions[0].id });
      localStorage.setItem("lastSelectedSessionId", sessions[0].id);
      get()._fetchSessionData(sessions[0].id);
    }
  },

  _setupListeners: async () => {
    // Guard against double-registration (can happen with React Strict Mode)
    // Must be synchronous check BEFORE any async operations
    if (get()._listenersInitialized) {
      return;
    }
    // Set flag synchronously to prevent race conditions
    set({ _listenersInitialized: true });

    const unlisteners: UnlistenFn[] = [];

    unlisteners.push(
      await listen<{ session_id: string; segment: TranscriptSegment }>(
        "transcript-segment",
        (event) => {
          const { session_id, segment } = event.payload;
          set((s) => {
            const existing = s.cache[session_id];
            if (!existing) return s;
            // Avoid duplicates — the segment may already exist from a fetch
            if (existing.transcript.some((t) => t.id === segment.id)) return s;
            return {
              cache: {
                ...s.cache,
                [session_id]: {
                  ...existing,
                  transcript: [...existing.transcript, segment],
                },
              },
            };
          });
        },
      ),
    );

    unlisteners.push(
      await listen<Session>("session-started", (event) => {
        const newSession = event.payload;
        set((s) => ({
          recordingSessionId: newSession.id,
          selectedSessionId: newSession.id,
          sessions: s.sessions.some((sess) => sess.id === newSession.id)
            ? s.sessions
            : [newSession, ...s.sessions],
        }));
      }),
    );

    unlisteners.push(
      await listen<Session>("session-ended", (event) => {
        const ended = event.payload;
        set((s) => ({
          recordingSessionId: null,
          isRecording: false,
          amplitude: { mic: 0, speaker: 0 },
          sessions: s.sessions.map((sess) =>
            sess.id === ended.id ? ended : sess,
          ),
        }));
      }),
    );

    unlisteners.push(
      await listen<AmplitudeEvent>("session-amplitude", (event) => {
        const { recordingSessionId } = get();
        if (event.payload.session_id === recordingSessionId) {
          set({
            amplitude: {
              mic: event.payload.mic,
              speaker: event.payload.speaker,
            },
          });
        }
      }),
    );

    // Listen for tray stop recording request (uses same code path as UI button)
    unlisteners.push(
      await listen("tray-stop-recording", () => {
        const { stopRecording } = get();
        stopRecording();
      }),
    );

    // Listen for system sleep notification (backend already stopped recording)
    unlisteners.push(
      await listen("system-will-sleep", () => {
        console.log(
          "[system-will-sleep] Recording stopped due to system sleep",
        );
        set({
          isRecording: false,
          recordingSessionId: null,
          amplitude: { mic: 0, speaker: 0 },
        });
      }),
    );

    // Listen for meeting ended notification (when meeting app stops using mic)
    // Shows window and toast with option to stop recording
    unlisteners.push(
      await listen<string>("meeting-ended", async (event) => {
        const appName = event.payload;
        // Show and focus the window (wrapped in try-catch so toast still shows)
        try {
          const win = getCurrentWindow();
          await win.show();
          await win.setFocus();
        } catch {
          // Window operations may fail if permissions not granted
        }
        // Show toast with stop recording action (persists until dismissed)
        toast(`${appName} ended`, {
          description: "Still recording - stop now?",
          action: {
            label: "Stop",
            onClick: () => {
              const { stopRecording } = get();
              stopRecording();
            },
          },
          cancel: {
            label: "Dismiss",
            onClick: () => {},
          },
          duration: Infinity,
        });
      }),
    );

    // Listen for tray new note request (uses same code path as UI button)
    unlisteners.push(
      await listen("tray-new-note", () => {
        const { createNote } = get();
        createNote();
      }),
    );

    // Listen for transcription flush complete to show enhancement prompt
    unlisteners.push(
      await listen<string>("transcription-flush-complete", (event) => {
        const { selectedSessionId, cache } = get();
        const sessionId = event.payload;
        // Only show prompt if this session is still selected and has a transcript
        if (sessionId === selectedSessionId) {
          const transcript = cache[selectedSessionId]?.transcript;
          if (transcript && transcript.length > 0) {
            set((s) => ({
              showEnhancePrompt: { ...s.showEnhancePrompt, [sessionId]: true },
            }));
          }
        }
      }),
    );

    // Listen for streaming enhanced notes chunks
    unlisteners.push(
      await listen<EnhanceNotesChunkEvent>("enhance-notes-chunk", (event) => {
        const { session_id, chunk, done } = event.payload;

        if (done) {
          // Stream complete - move accumulated text to cache and clear streaming state
          set((s) => {
            const accumulatedText = stripBlankLines(
              s.streamingEnhancedNotes[session_id] || "",
            );
            const existing = s.cache[session_id];
            const { [session_id]: _stream, ...restStreaming } =
              s.streamingEnhancedNotes;
            const { [session_id]: _flag, ...restEnhanceStreaming } =
              s.enhanceStreaming;

            return {
              streamingEnhancedNotes: restStreaming,
              enhanceStreaming: restEnhanceStreaming,
              enhanceLoading: { ...s.enhanceLoading, [session_id]: false },
              cache: existing
                ? {
                    ...s.cache,
                    [session_id]: {
                      ...existing,
                      enhancedNotes: accumulatedText,
                      enhancedNotesEdited: false,
                    },
                  }
                : s.cache,
            };
          });
        } else {
          // Accumulate chunk, stripping blank lines in real-time
          set((s) => ({
            streamingEnhancedNotes: {
              ...s.streamingEnhancedNotes,
              [session_id]: stripBlankLines(
                (s.streamingEnhancedNotes[session_id] || "") + chunk,
              ),
            },
            enhanceStreaming: {
              ...s.enhanceStreaming,
              [session_id]: true,
            },
          }));
        }
      }),
    );

    set({ _unlisteners: unlisteners });
  },

  createNote: async () => {
    const state = get();
    try {
      if (state.isRecording && state.recordingSessionId) {
        await invoke("stop_session_recording", {
          sessionId: state.recordingSessionId,
        });
        set({
          isRecording: false,
          recordingSessionId: null,
          amplitude: { mic: 0, speaker: 0 },
        });
      }

      const result = await invoke<Session>("start_session", { title: null });

      set((s) => ({
        selectedSessionId: result.id,
        recordingSessionId: result.id,
        notesLoaded: true,
        summaryError: null,
        viewMode: "notes" as const,
        isRecording: false,
        cache: {
          ...s.cache,
          [result.id]: {
            transcript: [],
            userNotes: "",
            enhancedNotes: null,
            enhancedNotesEdited: false,
            summary: null,
            loadedAt: Date.now(),
          },
        },
      }));

      localStorage.setItem("lastSelectedSessionId", result.id);

      try {
        await invoke("start_session_recording", { sessionId: result.id });
        set({ isRecording: true });
      } catch (e) {
        console.error("Failed to auto-start recording:", e);
      }
    } catch (e) {
      console.error("Failed to create note:", e);
    }
  },

  startRecording: async (sessionId: string) => {
    try {
      await invoke<Session>("reactivate_session", { sessionId });
      await invoke("start_session_recording", { sessionId });
      set({ recordingSessionId: sessionId, isRecording: true });
    } catch (e) {
      console.error("Failed to start recording:", e);
    }
  },

  stopRecording: async () => {
    const { recordingSessionId } = get();
    if (!recordingSessionId) return;
    try {
      await invoke("stop_session_recording", {
        sessionId: recordingSessionId,
      });
      set({ isRecording: false, amplitude: { mic: 0, speaker: 0 } });
      // Enhancement is triggered by transcription-flush-complete event listener
    } catch (e) {
      console.error("Failed to stop recording:", e);
    }
  },

  deleteSession: async (sessionId: string) => {
    const state = get();
    try {
      if (sessionId === state.recordingSessionId && state.isRecording) {
        await invoke("stop_session_recording", { sessionId });
        set({
          isRecording: false,
          recordingSessionId: null,
          amplitude: { mic: 0, speaker: 0 },
        });
      }
      await invoke("delete_session", { sessionId });

      set((s) => {
        const { [sessionId]: _, ...restCache } = s.cache;
        const deletedIndex = s.sessions.findIndex(
          (sess) => sess.id === sessionId,
        );
        const newSessions = s.sessions.filter((sess) => sess.id !== sessionId);
        const updates: Partial<SessionStore> = {
          cache: restCache,
          sessions: newSessions,
        };
        if (s.selectedSessionId === sessionId) {
          const nextSession =
            newSessions[Math.min(deletedIndex, newSessions.length - 1)] ?? null;
          updates.selectedSessionId = nextSession?.id ?? null;
          updates.notesLoaded = nextSession
            ? !!restCache[nextSession.id]
            : false;
          if (nextSession) {
            localStorage.setItem("lastSelectedSessionId", nextSession.id);
          }
        }
        return updates;
      });

      // Fetch data for newly selected session if needed
      const { selectedSessionId, cache } = get();
      if (selectedSessionId && !cache[selectedSessionId]) {
        get()._fetchSessionData(selectedSessionId);
      }
    } catch (e) {
      console.error("Failed to delete note:", e);
    }
  },

  updateTitle: async (title: string) => {
    const { selectedSessionId } = get();
    if (!selectedSessionId) return;
    try {
      await invoke("update_session_title", {
        sessionId: selectedSessionId,
        title,
      });
      set((s) => ({
        sessions: s.sessions.map((sess) =>
          sess.id === selectedSessionId ? { ...sess, title } : sess,
        ),
      }));
    } catch (e) {
      console.error("Failed to update title:", e);
    }
  },

  setUserNotes: (notes: string) => {
    const { selectedSessionId, _saveTimers } = get();
    if (!selectedSessionId) return;

    // Update cache immediately
    set((s) => {
      const existing = s.cache[selectedSessionId];
      if (!existing) return s;
      return {
        cache: {
          ...s.cache,
          [selectedSessionId]: { ...existing, userNotes: notes },
        },
      };
    });

    // Debounced save with per-session timer
    let timers = _saveTimers.get(selectedSessionId);
    if (!timers) {
      timers = { user: null, enhanced: null };
      _saveTimers.set(selectedSessionId, timers);
    }
    if (timers.user) clearTimeout(timers.user);
    timers.user = setTimeout(async () => {
      try {
        await invoke("save_user_notes", {
          sessionId: selectedSessionId,
          notes,
        });
      } catch (e) {
        console.error("Failed to save user notes:", e);
      }
      timers!.user = null;
    }, 500);
  },

  setEnhancedNotes: (tagged: string) => {
    const {
      selectedSessionId,
      _saveTimers,
      _lastSavedEnhancedNotes,
      cache,
      sessions,
    } = get();
    if (!selectedSessionId) return;

    // Initialize baseline from cache if not set (first edit of this session)
    if (!_lastSavedEnhancedNotes.has(selectedSessionId)) {
      const currentNotes = cache[selectedSessionId]?.enhancedNotes;
      if (currentNotes) {
        _lastSavedEnhancedNotes.set(selectedSessionId, currentNotes);
      }
    }

    // Update cache immediately and mark as edited by user
    set((s) => {
      const existing = s.cache[selectedSessionId];
      if (!existing) return s;
      return {
        cache: {
          ...s.cache,
          [selectedSessionId]: {
            ...existing,
            enhancedNotes: tagged,
            enhancedNotesEdited: true,
          },
        },
      };
    });

    // Debounced save with per-session timer
    let timers = _saveTimers.get(selectedSessionId);
    if (!timers) {
      timers = { user: null, enhanced: null };
      _saveTimers.set(selectedSessionId, timers);
    }
    if (timers.enhanced) clearTimeout(timers.enhanced);
    timers.enhanced = setTimeout(async () => {
      try {
        await invoke("save_enhanced_notes", {
          sessionId: selectedSessionId,
          notes: tagged,
        });

        // Detect word corrections against the LAST SAVED version (not previous keystroke)
        // Use longer delay (1.5s) to avoid detecting partial words while typing
        const settings = useSettingsStore.getState().settings;
        if (settings?.word_suggestions_enabled !== false) {
          const baseline = _lastSavedEnhancedNotes.get(selectedSessionId);
          const corrections = detectWordCorrections(baseline ?? null, tagged);
          if (corrections.length > 0) {
            const session = sessions.find((s) => s.id === selectedSessionId);
            const sessionTitle = session?.title || "Untitled";
            for (const word of corrections) {
              await commands.addWordSuggestion(
                word,
                sessionTitle,
                selectedSessionId,
              );
            }
            // Notify sidebar that suggestions changed
            window.dispatchEvent(new CustomEvent("word-suggestions-changed"));
          }
        }

        // Update baseline to current saved state
        _lastSavedEnhancedNotes.set(selectedSessionId, tagged);
      } catch (e) {
        console.error("Failed to save enhanced notes:", e);
      }
      timers!.enhanced = null;
    }, 1500);
  },

  generateSummary: async () => {
    const { selectedSessionId } = get();
    if (!selectedSessionId) return;
    set({ summaryLoading: true, summaryError: null });
    try {
      const result = await invoke<string>("generate_session_summary", {
        sessionId: selectedSessionId,
      });
      set((s) => {
        const existing = s.cache[selectedSessionId];
        if (!existing) return { summaryLoading: false };
        return {
          summaryLoading: false,
          cache: {
            ...s.cache,
            [selectedSessionId]: { ...existing, summary: result },
          },
        };
      });
    } catch (e) {
      console.error("Failed to generate summary:", e);
      set({ summaryLoading: false, summaryError: String(e) });
    }
  },

  enhanceNotes: async () => {
    const { selectedSessionId } = get();
    if (!selectedSessionId) return;
    const sessionId = selectedSessionId; // Capture for closure

    set((s) => {
      const { [sessionId]: _, ...restPrompt } = s.showEnhancePrompt;
      return {
        enhanceLoading: { ...s.enhanceLoading, [sessionId]: true },
        enhanceError: { ...s.enhanceError, [sessionId]: null },
        showEnhancePrompt: restPrompt,
        viewMode: "enhanced" as const,
        // Initialize streaming state
        streamingEnhancedNotes: {
          ...s.streamingEnhancedNotes,
          [sessionId]: "",
        },
        enhanceStreaming: { ...s.enhanceStreaming, [sessionId]: true },
      };
    });

    try {
      console.log(
        "[enhanceNotes] starting streaming for sessionId:",
        sessionId,
      );
      // Use streaming command - results come via enhance-notes-chunk events
      await invoke("generate_session_summary_stream", { sessionId });
      // The event listener handles updating cache and clearing loading state
    } catch (e) {
      console.error("Failed to enhance notes:", e);
      set((s) => {
        const { [sessionId]: _stream, ...restStreaming } =
          s.streamingEnhancedNotes;
        const { [sessionId]: _flag, ...restEnhanceStreaming } =
          s.enhanceStreaming;
        return {
          enhanceLoading: { ...s.enhanceLoading, [sessionId]: false },
          enhanceError: { ...s.enhanceError, [sessionId]: String(e) },
          streamingEnhancedNotes: restStreaming,
          enhanceStreaming: restEnhanceStreaming,
        };
      });
    }
  },

  dismissEnhancePrompt: (sessionId: string) => {
    set((s) => {
      const { [sessionId]: _, ...rest } = s.showEnhancePrompt;
      return { showEnhancePrompt: rest };
    });
  },

  setViewMode: (mode) => set({ viewMode: mode }),

  selectNextSession: () => {
    const { sessions, selectedSessionId } = get();
    if (sessions.length === 0) return;
    const idx = sessions.findIndex((s) => s.id === selectedSessionId);
    const nextIdx = idx < sessions.length - 1 ? idx + 1 : idx;
    if (sessions[nextIdx]) get().selectSession(sessions[nextIdx].id);
  },

  selectPreviousSession: () => {
    const { sessions, selectedSessionId } = get();
    if (sessions.length === 0) return;
    const idx = sessions.findIndex((s) => s.id === selectedSessionId);
    const prevIdx = idx > 0 ? idx - 1 : 0;
    if (sessions[prevIdx]) get().selectSession(sessions[prevIdx].id);
  },

  deselectSession: () => {
    set({ selectedSessionId: null });
  },

  cleanup: () => {
    const state = get();
    for (const [sessionId] of state._saveTimers) {
      flushSaves(state, sessionId);
    }
    for (const fn of state._unlisteners) {
      fn();
    }
    set({ _unlisteners: [], _listenersInitialized: false });
  },
}));

function flushSaves(state: SessionStore, sessionId: string) {
  const timers = state._saveTimers.get(sessionId);
  if (!timers) return;

  const cached = state.cache[sessionId];
  if (!cached) return;

  if (timers.user) {
    clearTimeout(timers.user);
    timers.user = null;
    invoke("save_user_notes", { sessionId, notes: cached.userNotes }).catch(
      (e) => console.error("Failed to flush user notes:", e),
    );
  }
  if (timers.enhanced) {
    clearTimeout(timers.enhanced);
    timers.enhanced = null;
    if (cached.enhancedNotes) {
      invoke("save_enhanced_notes", {
        sessionId,
        notes: cached.enhancedNotes,
      }).catch((e) => console.error("Failed to flush enhanced notes:", e));
    }
  }
}

// Selectors — return stable references for primitives/nulls,
// and direct object references from the cache (stable between updates)
export function useSelectedCache() {
  return useSessionStore((s) =>
    s.selectedSessionId ? s.cache[s.selectedSessionId] : undefined,
  );
}

export function useSelectedSession() {
  return useSessionStore((s) =>
    s.selectedSessionId
      ? (s.sessions.find((sess) => sess.id === s.selectedSessionId) ?? null)
      : null,
  );
}

export function useTranscript() {
  return useSessionStore(
    (s) =>
      (s.selectedSessionId && s.cache[s.selectedSessionId]?.transcript) ||
      EMPTY_TRANSCRIPT,
  );
}

export function useUserNotes() {
  return useSessionStore(
    (s) =>
      (s.selectedSessionId && s.cache[s.selectedSessionId]?.userNotes) ?? "",
  );
}

export function useEnhancedNotes() {
  return useSessionStore(
    (s) =>
      (s.selectedSessionId && s.cache[s.selectedSessionId]?.enhancedNotes) ??
      null,
  );
}

export function useSummary() {
  return useSessionStore(
    (s) =>
      (s.selectedSessionId && s.cache[s.selectedSessionId]?.summary) ?? null,
  );
}

export function useEnhanceLoading() {
  return useSessionStore(
    (s) =>
      (s.selectedSessionId && s.enhanceLoading[s.selectedSessionId]) || false,
  );
}

export function useEnhanceError() {
  return useSessionStore(
    (s) => (s.selectedSessionId && s.enhanceError[s.selectedSessionId]) || null,
  );
}

export function useStreamingEnhancedNotes() {
  return useSessionStore(
    (s) =>
      (s.selectedSessionId && s.streamingEnhancedNotes[s.selectedSessionId]) ||
      null,
  );
}

export function useEnhanceStreaming() {
  return useSessionStore(
    (s) =>
      (s.selectedSessionId && s.enhanceStreaming[s.selectedSessionId]) || false,
  );
}
