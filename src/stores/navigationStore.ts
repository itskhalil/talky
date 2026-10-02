import { create } from "zustand";

/**
 * Cross-component requests that don't belong to a single view: handing a
 * question from the sidebar search to Home.
 */
interface PendingAsk {
  question: string;
  environmentId: string | null;
  nonce: number;
}

interface NavigationStore {
  pendingAsk: PendingAsk | null;
  askOnHome: (question: string, environmentId: string | null) => void;
  consumePendingAsk: () => PendingAsk | null;
}

export const useNavigationStore = create<NavigationStore>((set, get) => ({
  pendingAsk: null,
  askOnHome: (question, environmentId) =>
    set({ pendingAsk: { question, environmentId, nonce: Date.now() } }),
  consumePendingAsk: () => {
    const pending = get().pendingAsk;
    if (pending) set({ pendingAsk: null });
    return pending;
  },
}));
