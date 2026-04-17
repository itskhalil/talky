import { useEffect, useRef } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Link from "@tiptap/extension-link";
import { TaskList } from "@tiptap/extension-task-list";
import { TaskItem } from "@tiptap/extension-task-item";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableCell } from "@tiptap/extension-table-cell";
import { Markdown } from "tiptap-markdown";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AiSourceExtension,
  setSuppressSourcePromotion,
} from "./AiSourceExtension";
import { Extension, JSONContent } from "@tiptap/core";
import { NotesEditorToolbar } from "./NotesEditorToolbar";
import { TableContextBar } from "./TableContextBar";
import "./notes-editor.css";

// Augment TipTap's Storage type so `editor.storage.markdown.getMarkdown()`
// typechecks. The Markdown extension from `tiptap-markdown` registers this
// storage key at runtime but doesn't ship type augmentations.
declare module "@tiptap/core" {
  interface Storage {
    markdown: {
      getMarkdown: () => string;
    };
  }
}

function promptForUrl(existing?: string): string | null {
  const input = window.prompt("Enter URL", existing ?? "https://");
  if (input === null) return null;
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

// Custom extension for paste without formatting (Cmd+Shift+Option+V on Mac)
const PasteUnformatted = Extension.create({
  name: "pasteUnformatted",
  addKeyboardShortcuts() {
    return {
      "Mod-Shift-Alt-v": ({ editor }) => {
        navigator.clipboard.readText().then((text) => {
          if (text) editor.commands.insertContent(text);
        });
        return true;
      },
    };
  },
});

// Shortcuts for features StarterKit doesn't already cover.
const MarkdownShortcuts = Extension.create({
  name: "markdownShortcuts",
  addKeyboardShortcuts() {
    return {
      "Mod-k": ({ editor }) => {
        const existing = editor.getAttributes("link").href as
          | string
          | undefined;
        const url = promptForUrl(existing);
        if (url === null) return true;
        if (url === "") {
          editor.chain().focus().unsetLink().run();
        } else {
          editor
            .chain()
            .focus()
            .extendMarkRange("link")
            .setLink({ href: url })
            .run();
        }
        return true;
      },
      "Mod-Shift-9": ({ editor }) =>
        editor.chain().focus().toggleTaskList().run(),
      "Mod-Alt-h": ({ editor }) =>
        editor.chain().focus().setHorizontalRule().run(),
      "Mod-Alt-t": ({ editor }) =>
        editor
          .chain()
          .focus()
          .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
          .run(),
    };
  },
});

interface NotesEditorProps {
  content: string;
  onChange: (md: string) => void;
  disabled?: boolean;
  placeholder?: string;
  mode?: "plain" | "enhanced";
  initialJSON?: JSONContent | null;
  onJSONChange?: (json: JSONContent) => void;
  onEditorReady?: (editor: ReturnType<typeof useEditor>) => void;
  onPasteImage?: (file: File) => void;
}

export function NotesEditor({
  content,
  onChange,
  disabled,
  placeholder,
  mode = "plain",
  initialJSON,
  onJSONChange,
  onEditorReady,
  onPasteImage,
}: NotesEditorProps) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onJSONChangeRef = useRef(onJSONChange);
  onJSONChangeRef.current = onJSONChange;
  const onPasteImageRef = useRef(onPasteImage);
  onPasteImageRef.current = onPasteImage;
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const isEnhanced = mode === "enhanced";
  const initialJSONAppliedRef = useRef<JSONContent | null>(null);
  const suppressUpdateRef = useRef(false);

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2, 3, 4] },
        }),
        Placeholder.configure({ placeholder }),
        PasteUnformatted,
        MarkdownShortcuts,
        Link.configure({
          openOnClick: false,
          autolink: true,
          linkOnPaste: true,
          protocols: ["http", "https", "mailto"],
          HTMLAttributes: {
            rel: "noopener noreferrer nofollow",
            target: "_blank",
          },
          validate: (href) => /^(https?:|mailto:)/i.test(href),
        }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Table.configure({ resizable: true }),
        TableRow,
        TableHeader,
        TableCell,
        // Markdown extension — parses setContent(string) and serializes via getMarkdown().
        // transformCopiedText=true makes Cmd+C emit markdown instead of plain text.
        Markdown.configure({
          transformPastedText: true,
          transformCopiedText: true,
          breaks: true,
          linkify: true,
        }),
        ...(isEnhanced ? [AiSourceExtension] : []),
      ],
      content: "",
      editable: !disabled,
      editorProps: {
        handlePaste: (view, event) => {
          // Image paste — intercept before any text handling
          if (onPasteImageRef.current && event.clipboardData) {
            const items = event.clipboardData.items;
            for (let i = 0; i < items.length; i++) {
              const item = items[i];
              if (item.kind === "file" && item.type.startsWith("image/")) {
                const file = item.getAsFile();
                if (file) {
                  onPasteImageRef.current(file);
                  return true;
                }
              }
            }
          }
          // Shift+paste = paste as plain text (Cmd+Shift+V / Ctrl+Shift+V)
          // Cast to access keyboard modifiers from the original event
          if ((event as ClipboardEvent & { shiftKey?: boolean }).shiftKey) {
            const text = event.clipboardData?.getData("text/plain");
            if (text) {
              // Insert plain text at current cursor position
              const { state } = view;
              const { tr } = state;
              tr.insertText(text);
              view.dispatch(tr);
              return true;
            }
          }
          return false; // Let default handler process
        },
      },
      onUpdate: ({ editor }) => {
        if (suppressUpdateRef.current) return;
        if (modeRef.current === "enhanced") {
          onJSONChangeRef.current?.(editor.getJSON());
        } else {
          const text = editor.storage.markdown.getMarkdown();
          onChangeRef.current(text);
        }
      },
    },
    [mode],
  );

  // Reset the ref when the editor instance changes so new editors get content
  useEffect(() => {
    initialJSONAppliedRef.current = null;
  }, [mode, editor]);

  // Expose editor instance to parent
  useEffect(() => {
    onEditorReady?.(editor);
  }, [editor, onEditorReady]);

  // Set content from initialJSON or markdown string
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    // Ensure view is mounted before accessing commands
    if (!editor.view?.dom) return;

    if (isEnhanced && initialJSON) {
      // Skip content sync while user is actively editing to preserve cursor position
      if (editor.isFocused) return;
      // Only apply if this is a genuinely new JSON payload (not one we already set)
      if (initialJSON !== initialJSONAppliedRef.current) {
        initialJSONAppliedRef.current = initialJSON;
        suppressUpdateRef.current = true;
        setSuppressSourcePromotion(true);
        editor.commands.setContent(initialJSON);
        // Prevent TipTap from scrolling the container past the title
        // Skip during streaming (disabled=true) so user can scroll freely
        if (!disabled) {
          requestAnimationFrame(() => {
            if (!editor || editor.isDestroyed || !editor.view?.dom) return;
            const scrollParent = editor.view.dom.closest(".overflow-y-scroll");
            scrollParent?.scrollTo(0, 0);
          });
        }
        setSuppressSourcePromotion(false);
        suppressUpdateRef.current = false;
      }
    } else if (!isEnhanced) {
      const current = editor.storage.markdown.getMarkdown();
      if (current !== content) {
        suppressUpdateRef.current = true;
        // tiptap-markdown's Markdown extension parses markdown strings in setContent.
        editor.commands.setContent(content);
        suppressUpdateRef.current = false;
      }
    }
  }, [content, initialJSON, editor, isEnhanced, disabled]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    suppressUpdateRef.current = true;
    editor.setEditable(!disabled);
    suppressUpdateRef.current = false;
  }, [disabled, editor]);

  // Open clicked links in the system browser via Tauri's opener plugin
  // so the WebView doesn't navigate away from the app.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const dom = editor.view?.dom;
    if (!dom) return;
    const handler = (event: MouseEvent) => {
      const anchor = (event.target as HTMLElement | null)?.closest?.("a");
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href) return;
      // In editable mode only intercept modified clicks; plain clicks place caret.
      if (editor.isEditable && !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      void openUrl(href).catch(() => {});
    };
    dom.addEventListener("click", handler);
    return () => dom.removeEventListener("click", handler);
  }, [editor]);

  if (!editor) return null;

  return (
    <div
      className={`notes-editor ${isEnhanced ? "notes-editor--enhanced" : ""}`}
    >
      {!disabled && <NotesEditorToolbar editor={editor} />}
      <TableContextBar editor={editor} />
      <EditorContent editor={editor} />
    </div>
  );
}

export { promptForUrl };
