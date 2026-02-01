import { useEffect, useRef } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import { AiSourceExtension } from "./AiSourceExtension";
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
}

export function NotesEditor({
  content,
  onChange,
  disabled,
  placeholder,
  mode = "plain",
  initialJSON,
  onJSONChange,
}: NotesEditorProps) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onJSONChangeRef = useRef(onJSONChange);
  onJSONChangeRef.current = onJSONChange;
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const isEnhanced = mode === "enhanced";
  const initialJSONAppliedRef = useRef<JSONContent | null>(null);

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          heading: isEnhanced ? { levels: [1, 2, 3] } : false,
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

  // Set content from initialJSON or markdown string
  useEffect(() => {
    if (!editor) return;
    if (isEnhanced && initialJSON) {
      // Only apply if this is a genuinely new JSON payload (not one we already set)
      if (initialJSON !== initialJSONAppliedRef.current) {
        initialJSONAppliedRef.current = initialJSON;
        editor.commands.setContent(initialJSON);
      }
    } else if (!isEnhanced) {
      const current = (editor.storage as Record<string, any>).markdown?.getMarkdown() ?? "";
      if (current !== content) {
        editor.commands.setContent(content);
      }
    }
  }, [content, initialJSON, editor, isEnhanced]);

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!disabled);
  }, [disabled, editor]);

  if (!editor) return null;

  return (
    <div className={`notes-editor ${isEnhanced ? "notes-editor--enhanced" : ""}`}>
      <EditorContent editor={editor} />
    </div>
  );
}
