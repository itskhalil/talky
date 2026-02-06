import { useEffect, useRef } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import {
  AiSourceExtension,
  setSuppressSourcePromotion,
} from "./AiSourceExtension";
import { Extension, JSONContent } from "@tiptap/core";
import "./notes-editor.css";

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

interface NotesEditorProps {
  content: string;
  onChange: (md: string) => void;
  disabled?: boolean;
  placeholder?: string;
  mode?: "plain" | "enhanced";
  initialJSON?: JSONContent | null;
  onJSONChange?: (json: JSONContent) => void;
  onEditorReady?: (editor: ReturnType<typeof useEditor>) => void;
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
}: NotesEditorProps) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onJSONChangeRef = useRef(onJSONChange);
  onJSONChangeRef.current = onJSONChange;
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
          codeBlock: false,
          code: false,
          blockquote: false,
          horizontalRule: false,
        }),
        Placeholder.configure({ placeholder }),
        PasteUnformatted,
        ...(isEnhanced ? [AiSourceExtension] : []),
        ...(!isEnhanced
          ? [Markdown.configure({ transformPastedText: true, breaks: true })]
          : []),
      ],
      content: "",
      editable: !disabled,
      editorProps: {
        handlePaste: (view, event) => {
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
        // Clean text serialization for native Cmd+C copy
        clipboardTextSerializer: (slice) => {
          const lines: string[] = [];

          // Recursive function to serialize nodes with proper indentation
          const serializeNode = (
            node: typeof slice.content.firstChild,
            indent: number = 0,
          ): void => {
            if (!node) return;
            const prefix = "  ".repeat(indent);

            if (node.type.name === "heading") {
              const level = node.attrs?.level ?? 2;
              lines.push("#".repeat(level) + " " + node.textContent);
            } else if (node.type.name === "paragraph") {
              lines.push(prefix + node.textContent);
            } else if (node.type.name === "bulletList") {
              node.content.forEach((li) => {
                // Get the paragraph text from list item
                const para = li.content.firstChild;
                if (para && para.type.name === "paragraph") {
                  lines.push(prefix + "- " + para.textContent);
                }
                // Handle nested lists within the list item
                li.content.forEach((child) => {
                  if (
                    child.type.name === "bulletList" ||
                    child.type.name === "orderedList"
                  ) {
                    serializeNode(child, indent + 1);
                  }
                });
              });
            } else if (node.type.name === "orderedList") {
              let idx = 1;
              node.content.forEach((li) => {
                const para = li.content.firstChild;
                if (para && para.type.name === "paragraph") {
                  lines.push(prefix + `${idx}. ` + para.textContent);
                }
                li.content.forEach((child) => {
                  if (
                    child.type.name === "bulletList" ||
                    child.type.name === "orderedList"
                  ) {
                    serializeNode(child, indent + 1);
                  }
                });
                idx++;
              });
            } else if (node.content) {
              // Generic fallback for other block nodes
              node.content.forEach((child) => serializeNode(child, indent));
            }
          };

          slice.content.forEach((node) => serializeNode(node, 0));
          return lines.join("\n");
        },
      },
      onUpdate: ({ editor }) => {
        if (suppressUpdateRef.current) return;
        if (modeRef.current === "enhanced") {
          onJSONChangeRef.current?.(editor.getJSON());
        } else {
          const md =
            (editor.storage as Record<string, any>).markdown?.getMarkdown() ??
            "";
          onChangeRef.current(md);
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
        requestAnimationFrame(() => {
          if (!editor || editor.isDestroyed || !editor.view?.dom) return;
          const scrollParent = editor.view.dom.closest(".overflow-y-scroll");
          scrollParent?.scrollTo(0, 0);
        });
        setSuppressSourcePromotion(false);
        suppressUpdateRef.current = false;
      }
    } else if (!isEnhanced) {
      const current =
        (editor.storage as Record<string, any>).markdown?.getMarkdown() ?? "";
      if (current !== content) {
        suppressUpdateRef.current = true;
        setSuppressSourcePromotion(true);
        editor.commands.setContent(content);
        setSuppressSourcePromotion(false);
        suppressUpdateRef.current = false;
      }
    }
  }, [content, initialJSON, editor, isEnhanced]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    suppressUpdateRef.current = true;
    editor.setEditable(!disabled);
    suppressUpdateRef.current = false;
  }, [disabled, editor]);

  if (!editor) return null;

  return (
    <div
      className={`notes-editor ${isEnhanced ? "notes-editor--enhanced" : ""}`}
    >
      <EditorContent editor={editor} />
    </div>
  );
}
