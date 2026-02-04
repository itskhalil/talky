import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
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
  summary: string | null;
  loadedAt: number;
}

// Detect word-level corrections in enhanced notes
// Returns words that appear to be corrections (replaced words)
function detectWordCorrections(oldText: string | null, newText: string): string[] {
  if (!oldText) return [];

  // Extract words from both texts, keeping case
  const extractWords = (text: string): string[] =>
    text.match(/[A-Za-z][A-Za-z0-9'-]*/g) || [];

  const oldWords = new Set(extractWords(oldText).map((w) => w.toLowerCase()));
  const newWords = extractWords(newText);

  // Find words in new text that:
  // 1. Aren't in old text (possible corrections)
  // 2. Look like proper nouns or technical terms (capitalized or unusual)
  // 3. Aren't common words
  const commonWords = new Set([
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "must", "can", "this", "that", "these", "those",
    "it", "its", "we", "our", "you", "your", "they", "their", "he", "his",
    "she", "her", "not", "all", "some", "any", "no", "yes", "so", "if", "then",
  ]);

  const corrections: string[] = [];
  const seen = new Set<string>();

  for (const word of newWords) {
    const lowerWord = word.toLowerCase();
    // Skip if already in old text, is common, or already seen
    if (oldWords.has(lowerWord) || commonWords.has(lowerWord) || seen.has(lowerWord)) {
      continue;
    }
    // Skip very short or very long words
    if (word.length < 3 || word.length > 30) continue;
    // Looks like a proper noun or technical term (capitalized)
    if (word[0] === word[0].toUpperCase() && word[0] !== word[0].toLowerCase()) {
      corrections.push(word);
      seen.add(lowerWord);
    }
  }

  return corrections.slice(0, 5); // Limit to 5 suggestions per save
}

const MAX_CACHE_SIZE = 20;

interface SaveTimers {
  user: ReturnType<typeof setTimeout> | null;
  enhanced: ReturnType<typeof setTimeout> | null;
}

// Stable defaults for selectors — never create new references
const EMPTY_TRANSCRIPT: TranscriptSegment[] = [];

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
  viewMode: "notes" | "enhanced";

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
  setViewMode: (mode: "notes" | "enhanced") => void;
  selectNextSession: () => void;
  selectPreviousSession: () => void;
  deselectSession: () => void;

  // Internal
  _fetchSessionData: (sessionId: string) => Promise<void>;
  _saveTimers: Map<string, SaveTimers>;
  _unlisteners: UnlistenFn[];
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
  viewMode: "enhanced",

  _saveTimers: new Map(),
  _unlisteners: [],

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

    // Listen for tray new note request (uses same code path as UI button)
    unlisteners.push(
      await listen("tray-new-note", () => {
        const { createNote } = get();
        createNote();
      }),
    );

    // Listen for transcription flush complete to trigger enhancement
    unlisteners.push(
      await listen<string>("transcription-flush-complete", (event) => {
        const { selectedSessionId, enhanceNotes, cache } = get();
        // Only auto-enhance if this session is still selected and has a transcript
        if (event.payload === selectedSessionId) {
          const transcript = cache[selectedSessionId]?.transcript;
          if (transcript && transcript.length > 0) {
            enhanceNotes();
          }
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
        const deletedIndex = s.sessions.findIndex((sess) => sess.id === sessionId);
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
    const { selectedSessionId, _saveTimers, cache, sessions } = get();
    if (!selectedSessionId) return;

    // Get old enhanced notes for correction detection
    const oldEnhancedNotes = cache[selectedSessionId]?.enhancedNotes;

    // Update cache immediately
    set((s) => {
      const existing = s.cache[selectedSessionId];
      if (!existing) return s;
      return {
        cache: {
          ...s.cache,
          [selectedSessionId]: { ...existing, enhancedNotes: tagged },
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

        // Detect word corrections and add suggestions (if enabled)
        const settings = useSettingsStore.getState().settings;
        if (settings?.word_suggestions_enabled !== false) {
          const corrections = detectWordCorrections(oldEnhancedNotes, tagged);
          if (corrections.length > 0) {
            const session = sessions.find((s) => s.id === selectedSessionId);
            const sessionTitle = session?.title || "Untitled";
            for (const word of corrections) {
              await commands.addWordSuggestion(word, sessionTitle, selectedSessionId);
            }
            // Notify sidebar that suggestions changed
            window.dispatchEvent(new CustomEvent("word-suggestions-changed"));
          }
        }
      } catch (e) {
        console.error("Failed to save enhanced notes:", e);
      }
      timers!.enhanced = null;
    }, 500);
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

    set((s) => ({
      enhanceLoading: { ...s.enhanceLoading, [sessionId]: true },
      enhanceError: { ...s.enhanceError, [sessionId]: null },
      viewMode: "enhanced" as const,
    }));

    try {
      console.log("[enhanceNotes] sending sessionId:", sessionId);
      const result = await invoke<string>("generate_session_summary", {
        sessionId,
      });
      console.log("[enhanceNotes] result:", result);
      set((s) => {
        const existing = s.cache[sessionId];
        if (!existing) {
          return {
            enhanceLoading: { ...s.enhanceLoading, [sessionId]: false },
          };
        }
        return {
          enhanceLoading: { ...s.enhanceLoading, [sessionId]: false },
          cache: {
            ...s.cache,
            [sessionId]: { ...existing, enhancedNotes: result },
          },
        };
      });
    } catch (e) {
      console.error("Failed to enhance notes:", e);
      set((s) => ({
        enhanceLoading: { ...s.enhanceLoading, [sessionId]: false },
        enhanceError: { ...s.enhanceError, [sessionId]: String(e) },
      }));
    }
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
    set({ _unlisteners: [] });
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
    (s) =>
      (s.selectedSessionId && s.enhanceError[s.selectedSessionId]) || null,
  );
}
