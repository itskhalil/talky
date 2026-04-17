import { Editor } from "@tiptap/core";
import { useTranslation } from "react-i18next";
import { Link2, Minus, SquareCheckBig, TableIcon } from "lucide-react";
import { promptForUrl } from "./NotesEditor";

interface Props {
  editor: Editor;
}

interface ButtonProps {
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}

function ToolbarButton({
  label,
  onClick,
  active,
  disabled,
  children,
}: ButtonProps) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      className={
        "notes-editor-toolbar__button" +
        (active ? " notes-editor-toolbar__button--active" : "")
      }
    >
      {children}
    </button>
  );
}

export function NotesEditorToolbar({ editor }: Props) {
  const { t } = useTranslation();

  const onInsertLink = () => {
    const existing = editor.getAttributes("link").href as string | undefined;
    const url = promptForUrl(existing);
    if (url === null) return;
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
  };

  return (
    <div className="notes-editor-toolbar" role="toolbar">
      <ToolbarButton
        label={t("noteEditor.toolbar.insertLink")}
        onClick={onInsertLink}
      >
        <Link2 size={14} />
      </ToolbarButton>
      <ToolbarButton
        label={t("noteEditor.toolbar.taskList")}
        active={editor.isActive("taskList")}
        onClick={() => editor.chain().focus().toggleTaskList().run()}
      >
        <SquareCheckBig size={14} />
      </ToolbarButton>
      <ToolbarButton
        label={t("noteEditor.toolbar.horizontalRule")}
        onClick={() => editor.chain().focus().setHorizontalRule().run()}
      >
        <Minus size={14} />
      </ToolbarButton>
      <ToolbarButton
        label={t("noteEditor.toolbar.insertTable")}
        onClick={() =>
          editor
            .chain()
            .focus()
            .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
            .run()
        }
      >
        <TableIcon size={14} />
      </ToolbarButton>
    </div>
  );
}
