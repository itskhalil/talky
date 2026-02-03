import { create } from "zustand";
import { commands, type Folder, type Tag } from "@/bindings";
import { useSessionStore } from "./sessionStore";

interface OrganizationStore {
  // State
  folders: Folder[];
  tags: Tag[];
  selectedFolderId: string | null; // null = "All Notes"
  selectedTagIds: string[];
  loading: boolean;
  error: string | null;

  // Actions
  initialize: () => Promise<void>;
  loadFolders: () => Promise<void>;
  loadTags: () => Promise<void>;

  // Folder actions
  createFolder: (name: string, color?: string) => Promise<Folder | null>;
  updateFolder: (folderId: string, name: string, color?: string) => Promise<void>;
  deleteFolder: (folderId: string) => Promise<void>;
  selectFolder: (folderId: string | null) => void;

  // Tag actions
  createTag: (name: string, color?: string) => Promise<Tag | null>;
  updateTag: (tagId: string, name: string, color?: string) => Promise<void>;
  deleteTag: (tagId: string) => Promise<void>;
  toggleTagFilter: (tagId: string) => void;
  clearTagFilters: () => void;

  // Session organization
  moveSessionToFolder: (sessionId: string, folderId: string | null) => Promise<void>;
  setSessionTags: (sessionId: string, tagIds: string[]) => Promise<void>;
  addTagToSession: (sessionId: string, tagId: string) => Promise<void>;
  removeTagFromSession: (sessionId: string, tagId: string) => Promise<void>;
  getSessionTags: (sessionId: string) => Promise<Tag[]>;
}

export const useOrganizationStore = create<OrganizationStore>((set, get) => ({
  folders: [],
  tags: [],
  selectedFolderId: null,
  selectedTagIds: [],
  loading: false,
  error: null,

  initialize: async () => {
    set({ loading: true, error: null });
    try {
      await Promise.all([get().loadFolders(), get().loadTags()]);
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ loading: false });
    }
  },

  loadFolders: async () => {
    const result = await commands.getFolders();
    if (result.status === "ok") {
      set({ folders: result.data });
    }
  },

  loadTags: async () => {
    const result = await commands.getTags();
    if (result.status === "ok") {
      set({ tags: result.data });
    }
  },

  createFolder: async (name, color) => {
    const result = await commands.createFolder(name, color ?? null);
    if (result.status === "ok") {
      set((s) => ({ folders: [...s.folders, result.data] }));
      return result.data;
    }
    return null;
  },

  updateFolder: async (folderId, name, color) => {
    const result = await commands.updateFolder(folderId, name, color ?? null);
    if (result.status === "ok") {
      set((s) => ({
        folders: s.folders.map((f) =>
          f.id === folderId ? { ...f, name, color: color ?? null } : f
        ),
      }));
    }
  },

  deleteFolder: async (folderId) => {
    const result = await commands.deleteFolder(folderId);
    if (result.status === "ok") {
      set((s) => ({
        folders: s.folders.filter((f) => f.id !== folderId),
        selectedFolderId: s.selectedFolderId === folderId ? null : s.selectedFolderId,
      }));
      // Refresh sessions since deleted folder's sessions become unfiled
      await useSessionStore.getState().loadSessions();
    }
  },

  selectFolder: (folderId) => {
    set({ selectedFolderId: folderId });
  },

  createTag: async (name, color) => {
    const result = await commands.createTag(name, color ?? null);
    if (result.status === "ok") {
      set((s) => ({ tags: [...s.tags, result.data] }));
      return result.data;
    }
    return null;
  },

  updateTag: async (tagId, name, color) => {
    const result = await commands.updateTag(tagId, name, color ?? null);
    if (result.status === "ok") {
      set((s) => ({
        tags: s.tags.map((t) =>
          t.id === tagId ? { ...t, name, color: color ?? null } : t
        ),
      }));
    }
  },

  deleteTag: async (tagId) => {
    const result = await commands.deleteTag(tagId);
    if (result.status === "ok") {
      set((s) => ({
        tags: s.tags.filter((t) => t.id !== tagId),
        selectedTagIds: s.selectedTagIds.filter((id) => id !== tagId),
      }));
    }
  },

  toggleTagFilter: (tagId) => {
    set((s) => ({
      selectedTagIds: s.selectedTagIds.includes(tagId)
        ? s.selectedTagIds.filter((id) => id !== tagId)
        : [...s.selectedTagIds, tagId],
    }));
  },

  clearTagFilters: () => {
    set({ selectedTagIds: [] });
  },

  moveSessionToFolder: async (sessionId, folderId) => {
    const result = await commands.moveSessionToFolder(sessionId, folderId);
    if (result.status === "ok") {
      // Refresh sessions to reflect the folder change
      await useSessionStore.getState().loadSessions();
    }
  },

  setSessionTags: async (sessionId, tagIds) => {
    const result = await commands.setSessionTags(sessionId, tagIds);
    if (result.status === "ok") {
      // Success
    }
  },

  addTagToSession: async (sessionId, tagId) => {
    const result = await commands.addTagToSession(sessionId, tagId);
    if (result.status === "ok") {
      // Success
    }
  },

  removeTagFromSession: async (sessionId, tagId) => {
    const result = await commands.removeTagFromSession(sessionId, tagId);
    if (result.status === "ok") {
      // Check if any sessions still use this tag
      const sessionsWithTag = await commands.getSessionsByTag(tagId);
      if (sessionsWithTag.status === "ok" && sessionsWithTag.data.length === 0) {
        // No sessions use this tag anymore, delete it
        await commands.deleteTag(tagId);
        set((s) => ({
          tags: s.tags.filter((t) => t.id !== tagId),
          selectedTagIds: s.selectedTagIds.filter((id) => id !== tagId),
        }));
      }
    }
  },

  getSessionTags: async (sessionId) => {
    const result = await commands.getSessionTags(sessionId);
    if (result.status === "ok") {
      return result.data;
    }
    return [];
  },
}));
