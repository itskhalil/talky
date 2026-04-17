import { create } from "zustand";

/**
 * One-shot signals from the command palette (or anywhere else) to the
 * currently-mounted NoteView. Each field is a monotonically increasing
 * counter — NoteView uses the counter in an effect dep to detect a new
 * request and pop the corresponding UI. Callers don't care about the value.
 */
interface NoteUiIntentStore {
  folderPickerTick: number;
  tagInputTick: number;
  attachmentPickerTick: number;
  openFolderPicker: () => void;
  openTagInput: () => void;
  openAttachmentPicker: () => void;
}

export const useNoteUiIntentStore = create<NoteUiIntentStore>()((set) => ({
  folderPickerTick: 0,
  tagInputTick: 0,
  attachmentPickerTick: 0,
  openFolderPicker: () =>
    set((s) => ({ folderPickerTick: s.folderPickerTick + 1 })),
  openTagInput: () => set((s) => ({ tagInputTick: s.tagInputTick + 1 })),
  openAttachmentPicker: () =>
    set((s) => ({ attachmentPickerTick: s.attachmentPickerTick + 1 })),
}));
