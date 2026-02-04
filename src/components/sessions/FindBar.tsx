import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ChevronUp, ChevronDown, X } from "lucide-react";
import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

const FIND_PLUGIN_KEY = new PluginKey("find-highlight");

/** Metadata stored on the plugin key to drive decoration builds. */
interface FindMeta {
  searchTerm: string;
  currentIndex: number;
}

function buildDecorations(
  doc: Editor["state"]["doc"],
  searchTerm: string,
  currentIndex: number,
): DecorationSet {
  if (!searchTerm) return DecorationSet.empty;

  const decorations: Decoration[] = [];
  const lower = searchTerm.toLowerCase();
  let matchIdx = 0;

  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const text = node.text.toLowerCase();
    let from = 0;
    for (;;) {
      const idx = text.indexOf(lower, from);
      if (idx === -1) break;
      const start = pos + idx;
      const end = start + searchTerm.length;
      const cls =
        matchIdx === currentIndex
          ? "find-highlight find-highlight--current"
          : "find-highlight";
      decorations.push(Decoration.inline(start, end, { class: cls }));
      matchIdx++;
      from = idx + 1;
    }
  });

  return DecorationSet.create(doc, decorations);
}

function countMatches(doc: Editor["state"]["doc"], searchTerm: string): number {
  if (!searchTerm) return 0;
  const lower = searchTerm.toLowerCase();
  let count = 0;
  doc.descendants((node) => {
    if (!node.isText || !node.text) return;
    const text = node.text.toLowerCase();
    let from = 0;
    for (;;) {
      const idx = text.indexOf(lower, from);
      if (idx === -1) break;
      count++;
      from = idx + 1;
    }
  });
  return count;
}

/** Get the document position of the Nth match. */
function getNthMatchPos(
  doc: Editor["state"]["doc"],
  searchTerm: string,
  n: number,
): number | null {
  if (!searchTerm) return null;
  const lower = searchTerm.toLowerCase();
  let matchIdx = 0;
  let result: number | null = null;
  doc.descendants((node, pos) => {
    if (result !== null) return false;
    if (!node.isText || !node.text) return;
    const text = node.text.toLowerCase();
    let from = 0;
    for (;;) {
      const idx = text.indexOf(lower, from);
      if (idx === -1) break;
      if (matchIdx === n) {
        result = pos + idx;
        return false;
      }
      matchIdx++;
      from = idx + 1;
    }
  });
  return result;
}

const findPlugin = new Plugin({
  key: FIND_PLUGIN_KEY,
  state: {
    init() {
      return { searchTerm: "", currentIndex: 0 };
    },
    apply(tr, value) {
      const meta = tr.getMeta(FIND_PLUGIN_KEY) as FindMeta | undefined;
      if (meta) return meta;
      return value;
    },
  },
  props: {
    decorations(state) {
      const { searchTerm, currentIndex } =
        FIND_PLUGIN_KEY.getState(state) as FindMeta;
      return buildDecorations(state.doc, searchTerm, currentIndex);
    },
  },
});

interface FindBarProps {
  editor: Editor | null;
  onClose: () => void;
}

export function FindBar({ editor, onClose }: FindBarProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [currentMatch, setCurrentMatch] = useState(0);
  const [totalMatches, setTotalMatches] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const pluginRegistered = useRef(false);

  // Register plugin on mount, unregister on unmount
  useEffect(() => {
    if (!editor) return;
    // Check if already registered
    const existing = editor.state.plugins.find(
      (p) => p.spec.key === FIND_PLUGIN_KEY,
    );
    if (!existing) {
      editor.registerPlugin(findPlugin);
    }
    pluginRegistered.current = true;

    return () => {
      if (pluginRegistered.current) {
        editor.unregisterPlugin(FIND_PLUGIN_KEY);
        pluginRegistered.current = false;
      }
    };
  }, [editor]);

  const dispatchFind = useCallback(
    (term: string, index: number) => {
      if (!editor) return;
      const tr = editor.state.tr.setMeta(FIND_PLUGIN_KEY, {
        searchTerm: term,
        currentIndex: index,
      } satisfies FindMeta);
      editor.view.dispatch(tr);
    },
    [editor],
  );

  const scrollToMatch = useCallback(
    (term: string, index: number) => {
      if (!editor) return;
      const pos = getNthMatchPos(editor.state.doc, term, index);
      if (pos == null) return;
      const dom = editor.view.domAtPos(pos);
      if (dom.node instanceof HTMLElement) {
        dom.node.scrollIntoView({ block: "center", behavior: "smooth" });
      } else if (dom.node.parentElement) {
        dom.node.parentElement.scrollIntoView({
          block: "center",
          behavior: "smooth",
        });
      }
    },
    [editor],
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!editor) return;
    const total = countMatches(editor.state.doc, query);
    setTotalMatches(total);
    setCurrentMatch(0);
    dispatchFind(query, 0);
    if (total > 0) scrollToMatch(query, 0);
  }, [query, editor, dispatchFind, scrollToMatch]);

  const goNext = () => {
    if (totalMatches === 0) return;
    const next = (currentMatch + 1) % totalMatches;
    setCurrentMatch(next);
    dispatchFind(query, next);
    scrollToMatch(query, next);
  };

  const goPrev = () => {
    if (totalMatches === 0) return;
    const prev = (currentMatch - 1 + totalMatches) % totalMatches;
    setCurrentMatch(prev);
    dispatchFind(query, prev);
    scrollToMatch(query, prev);
  };

  const handleClose = () => {
    dispatchFind("", 0);
    setQuery("");
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      handleClose();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) goPrev();
      else goNext();
    }
  };

  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-background border border-border rounded-lg shadow-md">
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t("notes.findPlaceholder", "Find in note...")}
        className="flex-1 text-sm bg-transparent border-none outline-none text-text placeholder:text-text-secondary min-w-0"
      />
      {query && (
        <span
          className="text-xs text-text-secondary whitespace-nowrap"
          data-ui
        >
          {totalMatches > 0
            ? `${currentMatch + 1} of ${totalMatches}`
            : t("notes.noMatches", "No matches")}
        </span>
      )}
      <button
        onClick={goPrev}
        disabled={totalMatches === 0}
        className="p-1 rounded text-text-secondary hover:text-text disabled:opacity-30 transition-colors"
      >
        <ChevronUp size={16} />
      </button>
      <button
        onClick={goNext}
        disabled={totalMatches === 0}
        className="p-1 rounded text-text-secondary hover:text-text disabled:opacity-30 transition-colors"
      >
        <ChevronDown size={16} />
      </button>
      <button
        onClick={handleClose}
        className="p-1 rounded text-text-secondary hover:text-text transition-colors"
      >
        <X size={16} />
      </button>
    </div>
  );
}
