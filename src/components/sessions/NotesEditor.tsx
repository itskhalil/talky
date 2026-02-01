import { useEffect, useRef } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import "./notes-editor.css";

interface NotesEditorProps {
  content: string;
  onChange: (md: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function NotesEditor({
  content,
  onChange,
  disabled,
  placeholder,
}: NotesEditorProps) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        codeBlock: false,
        code: false,
        blockquote: false,
        horizontalRule: false,
      }),
      Placeholder.configure({ placeholder }),
      Markdown.configure({ transformPastedText: true }),
    ],
    content,
    editable: !disabled,
    onUpdate: ({ editor }) => {
      const md = editor.storage.markdown.getMarkdown();
      onChangeRef.current(md);
    },
  });

  useEffect(() => {
    if (!editor) return;
    const current = editor.storage.markdown.getMarkdown();
    if (current !== content) {
      editor.commands.setContent(content);
    }
  }, [content, editor]);

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!disabled);
  }, [disabled, editor]);

  if (!editor) return null;

  return (
    <div className="notes-editor">
      <EditorContent editor={editor} />
    </div>
  );
}
