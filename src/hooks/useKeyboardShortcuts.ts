import { useEffect } from "react";
import { useSessionStore } from "@/stores/sessionStore";

function isTextInput(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return true;
  if ((el as HTMLElement).isContentEditable) return true;
  if (el.closest(".ProseMirror")) return true;
  return false;
}

interface KeyboardShortcutsOptions {
  onOpenSettings: () => void;
  onToggleFindBar?: () => void;
  onCloseFindBar?: () => void;
  findBarOpen?: boolean;
  onExpandSidebar?: () => void;
}

export function useKeyboardShortcuts({
  onOpenSettings,
  onToggleFindBar,
  onCloseFindBar,
  findBarOpen,
  onExpandSidebar,
}: KeyboardShortcutsOptions) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key === "n") {
        e.preventDefault();
        useSessionStore.getState().createNote();
        return;
      }

      if (mod && e.key === "k") {
        e.preventDefault();
        onExpandSidebar?.();
        requestAnimationFrame(() => {
          const input = document.querySelector<HTMLInputElement>(
            "[data-search-input]",
          );
          input?.focus();
        });
        return;
      }

      if (mod && e.key === "/") {
        e.preventDefault();
        const input =
          document.querySelector<HTMLInputElement>("[data-chat-input]");
        input?.focus();
        return;
      }

      if (mod && e.key === ",") {
        e.preventDefault();
        onOpenSettings();
        return;
      }

      if (mod && e.key === "1") {
        e.preventDefault();
        useSessionStore.getState().setViewMode("notes");
        return;
      }

      if (mod && e.key === "2") {
        e.preventDefault();
        useSessionStore.getState().setViewMode("enhanced");
        return;
      }

      if (mod && e.key === "f") {
        e.preventDefault();
        onToggleFindBar?.();
        return;
      }

      // Non-modifier shortcuts — only when not in a text input
      if (!isTextInput(document.activeElement)) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          useSessionStore.getState().selectNextSession();
          return;
        }

        if (e.key === "ArrowUp") {
          e.preventDefault();
          useSessionStore.getState().selectPreviousSession();
          return;
        }

        if (e.key === "Enter") {
          return;
        }
      }

      if (e.key === "Escape") {
        e.preventDefault();
        if (findBarOpen) {
          onCloseFindBar?.();
        } else {
          useSessionStore.getState().deselectSession();
        }
        return;
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onOpenSettings, onToggleFindBar, onCloseFindBar, findBarOpen, onExpandSidebar]);
}
