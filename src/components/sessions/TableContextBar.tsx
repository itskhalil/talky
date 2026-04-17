import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Editor } from "@tiptap/core";
import { useTranslation } from "react-i18next";

interface Props {
  editor: Editor;
}

interface Rect {
  top: number;
  left: number;
  width: number;
}

export function TableContextBar({ editor }: Props) {
  const { t } = useTranslation();
  const [rect, setRect] = useState<Rect | null>(null);
  const [menu, setMenu] = useState<null | "insert" | "delete" | "header">(
    null,
  );
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!editor) return;
    const update = () => {
      if (editor.isDestroyed || !editor.isActive("table")) {
        setRect(null);
        return;
      }
      const { $from } = editor.state.selection;
      let tablePos = -1;
      for (let d = $from.depth; d >= 0; d--) {
        if ($from.node(d).type.name === "table") {
          tablePos = d === 0 ? 0 : $from.before(d);
          break;
        }
      }
      if (tablePos < 0) {
        setRect(null);
        return;
      }
      const domNode = editor.view.nodeDOM(tablePos) as HTMLElement | null;
      if (!domNode) {
        setRect(null);
        return;
      }
      // TipTap wraps tables in a `.tableWrapper` element; prefer it for positioning.
      const target =
        (domNode.closest?.(".tableWrapper") as HTMLElement | null) ??
        (domNode.querySelector?.(".tableWrapper") as HTMLElement | null) ??
        domNode;
      const r = target.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width });
    };

    const onDocMouseDown = (e: MouseEvent) => {
      if (!barRef.current) return;
      if (!barRef.current.contains(e.target as Node)) setMenu(null);
    };

    editor.on("selectionUpdate", update);
    editor.on("transaction", update);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    document.addEventListener("mousedown", onDocMouseDown);
    update();

    return () => {
      editor.off("selectionUpdate", update);
      editor.off("transaction", update);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
      document.removeEventListener("mousedown", onDocMouseDown);
    };
  }, [editor]);

  if (!rect) return null;

  const run = (fn: (e: Editor) => void) => () => {
    fn(editor);
    setMenu(null);
  };

  return createPortal(
    <div
      ref={barRef}
      className="notes-editor-tablebar"
      style={{
        position: "fixed",
        // Anchor the bar's bottom edge 6px above the table's top, regardless
        // of the bar's measured height.
        top: rect.top - 6,
        left: rect.left,
        transform: "translateY(-100%)",
        zIndex: 50,
      }}
      role="toolbar"
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="notes-editor-tablebar__dropdown">
        <button
          type="button"
          className="notes-editor-tablebar__trigger"
          onClick={() => setMenu(menu === "insert" ? null : "insert")}
        >
          {t("noteEditor.tableBar.insert")}
        </button>
        {menu === "insert" && (
          <div className="notes-editor-tablebar__menu">
            <button
              onClick={run((e) => e.chain().focus().addRowBefore().run())}
            >
              {t("noteEditor.tableBar.addRowAbove")}
            </button>
            <button onClick={run((e) => e.chain().focus().addRowAfter().run())}>
              {t("noteEditor.tableBar.addRowBelow")}
            </button>
            <button
              onClick={run((e) => e.chain().focus().addColumnBefore().run())}
            >
              {t("noteEditor.tableBar.addColumnLeft")}
            </button>
            <button
              onClick={run((e) => e.chain().focus().addColumnAfter().run())}
            >
              {t("noteEditor.tableBar.addColumnRight")}
            </button>
          </div>
        )}
      </div>

      <div className="notes-editor-tablebar__dropdown">
        <button
          type="button"
          className="notes-editor-tablebar__trigger"
          onClick={() => setMenu(menu === "delete" ? null : "delete")}
        >
          {t("noteEditor.tableBar.delete")}
        </button>
        {menu === "delete" && (
          <div className="notes-editor-tablebar__menu">
            <button onClick={run((e) => e.chain().focus().deleteRow().run())}>
              {t("noteEditor.tableBar.deleteRow")}
            </button>
            <button
              onClick={run((e) => e.chain().focus().deleteColumn().run())}
            >
              {t("noteEditor.tableBar.deleteColumn")}
            </button>
            <button onClick={run((e) => e.chain().focus().deleteTable().run())}>
              {t("noteEditor.tableBar.deleteTable")}
            </button>
          </div>
        )}
      </div>

      <div className="notes-editor-tablebar__dropdown">
        <button
          type="button"
          className="notes-editor-tablebar__trigger"
          onClick={() => setMenu(menu === "header" ? null : "header")}
        >
          {t("noteEditor.tableBar.header")}
        </button>
        {menu === "header" && (
          <div className="notes-editor-tablebar__menu">
            <button
              onClick={run((e) => e.chain().focus().toggleHeaderRow().run())}
            >
              {t("noteEditor.tableBar.toggleHeaderRow")}
            </button>
            <button
              onClick={run((e) => e.chain().focus().toggleHeaderColumn().run())}
              title={t("noteEditor.tableBar.toggleHeaderColumnHint")}
            >
              {t("noteEditor.tableBar.toggleHeaderColumn")}
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
