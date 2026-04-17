import { useEffect, useState } from "react";
import { Editor } from "@tiptap/core";
import { useTranslation } from "react-i18next";

interface Props {
  editor: Editor;
}

export function TableContextBar({ editor }: Props) {
  const { t } = useTranslation();
  const [, force] = useState(0);

  useEffect(() => {
    const bump = () => force((n) => n + 1);
    editor.on("selectionUpdate", bump);
    editor.on("transaction", bump);
    return () => {
      editor.off("selectionUpdate", bump);
      editor.off("transaction", bump);
    };
  }, [editor]);

  if (!editor.isActive("table")) return null;

  const run = (fn: (e: Editor) => void) => () => {
    fn(editor);
  };

  return (
    <div className="notes-editor-tablebar" role="toolbar">
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={run((e) => e.chain().focus().addRowBefore().run())}
      >
        {t("noteEditor.tableBar.addRowAbove")}
      </button>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={run((e) => e.chain().focus().addRowAfter().run())}
      >
        {t("noteEditor.tableBar.addRowBelow")}
      </button>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={run((e) => e.chain().focus().addColumnBefore().run())}
      >
        {t("noteEditor.tableBar.addColumnLeft")}
      </button>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={run((e) => e.chain().focus().addColumnAfter().run())}
      >
        {t("noteEditor.tableBar.addColumnRight")}
      </button>
      <span className="notes-editor-tablebar__sep" aria-hidden />
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={run((e) => e.chain().focus().deleteRow().run())}
      >
        {t("noteEditor.tableBar.deleteRow")}
      </button>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={run((e) => e.chain().focus().deleteColumn().run())}
      >
        {t("noteEditor.tableBar.deleteColumn")}
      </button>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={run((e) => e.chain().focus().toggleHeaderRow().run())}
      >
        {t("noteEditor.tableBar.toggleHeader")}
      </button>
      <span className="notes-editor-tablebar__sep" aria-hidden />
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={run((e) => e.chain().focus().deleteTable().run())}
      >
        {t("noteEditor.tableBar.deleteTable")}
      </button>
    </div>
  );
}
