import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import { Bold, Italic, List, ListOrdered } from "lucide-react";
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
  const { t } = useTranslation();
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

  // Sync content from backend when session changes
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

  const btnClass = (active: boolean) =>
    `p-1.5 rounded transition-colors ${
      active
        ? "bg-logo-primary/20 text-logo-primary"
        : "text-mid-gray hover:text-foreground hover:bg-mid-gray/20"
    }`;

  return (
    <div className="notes-editor border border-mid-gray/20 rounded-lg overflow-hidden bg-background focus-within:border-logo-primary/60 transition-colors">
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 px-2 py-1 border-b border-mid-gray/20">
        <button
          type="button"
          title={t("sessions.toolbar.bold")}
          className={btnClass(editor.isActive("bold"))}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          <Bold size={16} />
        </button>
        <button
          type="button"
          title={t("sessions.toolbar.italic")}
          className={btnClass(editor.isActive("italic"))}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          <Italic size={16} />
        </button>
        <button
          type="button"
          title={t("sessions.toolbar.bulletList")}
          className={btnClass(editor.isActive("bulletList"))}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          <List size={16} />
        </button>
        <button
          type="button"
          title={t("sessions.toolbar.orderedList")}
          className={btnClass(editor.isActive("orderedList"))}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        >
          <ListOrdered size={16} />
        </button>
      </div>

      <EditorContent editor={editor} />
    </div>
  );
}
