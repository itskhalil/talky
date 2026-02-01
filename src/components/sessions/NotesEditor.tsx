import { useEffect, useRef } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import { AiSourceExtension, setSuppressSourcePromotion } from "./AiSourceExtension";
import { JSONContent } from "@tiptap/core";
import "./notes-editor.css";

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
          heading: { levels: [1, 2, 3] },
          codeBlock: false,
          code: false,
          blockquote: false,
          horizontalRule: false,
        }),
        Placeholder.configure({ placeholder }),
        ...(isEnhanced ? [AiSourceExtension] : []),
        ...(!isEnhanced
          ? [Markdown.configure({ transformPastedText: true })]
          : []),
      ],
      content: "",
      editable: !disabled,
      onUpdate: ({ editor }) => {
        if (suppressUpdateRef.current) return;
        if (modeRef.current === "enhanced") {
          onJSONChangeRef.current?.(editor.getJSON());
        } else {
          const md = (editor.storage as Record<string, any>).markdown?.getMarkdown() ?? "";
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
    if (!editor) return;
    if (isEnhanced && initialJSON) {
      // Only apply if this is a genuinely new JSON payload (not one we already set)
      if (initialJSON !== initialJSONAppliedRef.current) {
        initialJSONAppliedRef.current = initialJSON;
        suppressUpdateRef.current = true;
        setSuppressSourcePromotion(true);
        editor.commands.setContent(initialJSON);
        // Prevent TipTap from scrolling the container past the title
        requestAnimationFrame(() => {
          const scrollParent = editor.view.dom.closest(".overflow-y-auto");
          scrollParent?.scrollTo(0, 0);
        });
        setSuppressSourcePromotion(false);
        suppressUpdateRef.current = false;
      }
    } else if (!isEnhanced) {
      const current = (editor.storage as Record<string, any>).markdown?.getMarkdown() ?? "";
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
    if (!editor) return;
    suppressUpdateRef.current = true;
    editor.setEditable(!disabled);
    suppressUpdateRef.current = false;
  }, [disabled, editor]);

  if (!editor) return null;

  return (
    <div className={`notes-editor ${isEnhanced ? "notes-editor--enhanced" : ""}`}>
      <EditorContent editor={editor} />
    </div>
  );
}
