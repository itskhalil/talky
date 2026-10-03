import { create } from "zustand";

/**
 * Cross-component requests that don't belong to a single view: handing a
 * question from the sidebar search to Home, and resetting Home.
 */
interface PendingAsk {
  question: string;
  environmentId: string | null;
  nonce: number;
}

interface NavigationStore {
  pendingAsk: PendingAsk | null;
  // Bumped whenever Home is asked for, so Home clears its conversation.
  homeNonce: number;
  goHome: () => void;
  askOnHome: (question: string, environmentId: string | null) => void;
  consumePendingAsk: () => PendingAsk | null;
}

export const useNavigationStore = create<NavigationStore>((set, get) => ({
  pendingAsk: null,
  homeNonce: 0,
  goHome: () => set((s) => ({ homeNonce: s.homeNonce + 1 })),
  askOnHome: (question, environmentId) =>
    set({ pendingAsk: { question, environmentId, nonce: Date.now() } }),
  consumePendingAsk: () => {
    const pending = get().pendingAsk;
    if (pending) set({ pendingAsk: null });
    return pending;
  },
}));
