import { Extension } from "@tiptap/core";
import type { Editor, Range } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import Suggestion from "@tiptap/suggestion";
import type {
  SuggestionProps,
  SuggestionKeyDownProps,
} from "@tiptap/suggestion";
import { createElement } from "react";
import {
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListTodo,
  Code,
  Quote,
  Minus,
  Table as TableIcon,
} from "lucide-react";
import { SlashMenu, type SlashItem, type SlashMenuHandle } from "./SlashMenu";

function buildItems(t: (key: string) => string): SlashItem[] {
  return [
    {
      id: "heading-1",
      title: t("editor.slash.heading1.title"),
      description: t("editor.slash.heading1.description"),
      icon: createElement(Heading1, { size: 16 }),
      keywords: ["h1", "title", "heading"],
      run: (editor, range) =>
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .setNode("heading", { level: 1 })
          .run(),
    },
    {
      id: "heading-2",
      title: t("editor.slash.heading2.title"),
      description: t("editor.slash.heading2.description"),
      icon: createElement(Heading2, { size: 16 }),
      keywords: ["h2", "section", "heading"],
      run: (editor, range) =>
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .setNode("heading", { level: 2 })
          .run(),
    },
    {
      id: "heading-3",
      title: t("editor.slash.heading3.title"),
      description: t("editor.slash.heading3.description"),
      icon: createElement(Heading3, { size: 16 }),
      keywords: ["h3", "heading"],
      run: (editor, range) =>
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .setNode("heading", { level: 3 })
          .run(),
    },
    {
      id: "bullet-list",
      title: t("editor.slash.bulletList.title"),
      description: t("editor.slash.bulletList.description"),
      icon: createElement(List, { size: 16 }),
      keywords: ["bullet", "unordered", "list", "ul"],
      run: (editor, range) =>
        editor.chain().focus().deleteRange(range).toggleBulletList().run(),
    },
    {
      id: "ordered-list",
      title: t("editor.slash.orderedList.title"),
      description: t("editor.slash.orderedList.description"),
      icon: createElement(ListOrdered, { size: 16 }),
      keywords: ["numbered", "ordered", "list", "ol"],
      run: (editor, range) =>
        editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
    },
    {
      id: "task-list",
      title: t("editor.slash.taskList.title"),
      description: t("editor.slash.taskList.description"),
      icon: createElement(ListTodo, { size: 16 }),
      keywords: ["todo", "task", "checkbox", "check"],
      run: (editor, range) =>
        editor.chain().focus().deleteRange(range).toggleTaskList().run(),
    },
    {
      id: "code-block",
      title: t("editor.slash.codeBlock.title"),
      description: t("editor.slash.codeBlock.description"),
      icon: createElement(Code, { size: 16 }),
      keywords: ["code", "snippet", "pre"],
      run: (editor, range) =>
        editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
    },
    {
      id: "blockquote",
      title: t("editor.slash.blockquote.title"),
      description: t("editor.slash.blockquote.description"),
      icon: createElement(Quote, { size: 16 }),
      keywords: ["quote", "citation"],
      run: (editor, range) =>
        editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
    },
    {
      id: "horizontal-rule",
      title: t("editor.slash.horizontalRule.title"),
      description: t("editor.slash.horizontalRule.description"),
      icon: createElement(Minus, { size: 16 }),
      keywords: ["hr", "divider", "line", "rule"],
      run: (editor, range) =>
        editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
    },
    {
      id: "table",
      title: t("editor.slash.table.title"),
      description: t("editor.slash.table.description"),
      icon: createElement(TableIcon, { size: 16 }),
      keywords: ["table", "grid"],
      run: (editor, range) =>
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
          .run(),
    },
  ];
}

function filterItems(items: SlashItem[], query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => {
    if (item.title.toLowerCase().includes(q)) return true;
    if (item.keywords?.some((k) => k.toLowerCase().includes(q))) return true;
    return false;
  });
}

/**
 * Position a floating DOM element to a client rect. Flips above the caret if
 * there isn't room below.
 */
function positionFloating(el: HTMLElement, rect: DOMRect | null) {
  if (!rect) {
    el.style.display = "none";
    return;
  }
  el.style.display = "block";
  const margin = 6;
  const height = el.offsetHeight || 260;
  const width = el.offsetWidth || 260;
  const viewportH = window.innerHeight;
  const viewportW = window.innerWidth;

  let top = rect.bottom + margin;
  if (top + height > viewportH - 8) {
    top = Math.max(8, rect.top - height - margin);
  }
  let left = rect.left;
  if (left + width > viewportW - 8) {
    left = Math.max(8, viewportW - width - 8);
  }
  el.style.top = `${top}px`;
  el.style.left = `${left}px`;
}

interface SlashExtensionOptions {
  t: (key: string) => string;
}

export const SlashCommandExtension = Extension.create<SlashExtensionOptions>({
  name: "slashCommand",

  addOptions() {
    return {
      t: (key: string) => key,
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    return [
      Suggestion<SlashItem, SlashItem>({
        editor: this.editor,
        char: "/",
        startOfLine: false,
        allowSpaces: false,
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          const parent = $from.parent;
          // Only show for empty-ish paragraphs so typing "/" mid-prose
          // (e.g. "and/or") doesn't open the menu.
          if (parent.type.name !== "paragraph") return false;
          const textBefore = parent.textBetween(0, $from.parentOffset, "\n");
          return textBefore.trim().length === 0;
        },
        items: ({ query }) => filterItems(buildItems(options.t), query),
        command: ({ editor, range, props }) => {
          props.run(editor as Editor, range as Range);
        },
        render: () => {
          let renderer: ReactRenderer<SlashMenuHandle> | null = null;
          let wrapper: HTMLDivElement | null = null;

          const mount = (props: SuggestionProps<SlashItem, SlashItem>) => {
            wrapper = document.createElement("div");
            wrapper.className = "slash-menu-wrapper";
            wrapper.style.position = "fixed";
            wrapper.style.zIndex = "60";
            wrapper.style.display = "none";
            document.body.appendChild(wrapper);

            renderer = new ReactRenderer(SlashMenu, {
              props: {
                items: props.items,
                command: (item: SlashItem) => props.command(item),
              },
              editor: props.editor,
            });
            wrapper.appendChild(renderer.element);
            requestAnimationFrame(() => {
              if (wrapper)
                positionFloating(wrapper, props.clientRect?.() ?? null);
            });
          };

          const unmount = () => {
            renderer?.destroy();
            wrapper?.remove();
            renderer = null;
            wrapper = null;
          };

          return {
            onStart: (props) => {
              mount(props);
            },
            onUpdate: (props) => {
              renderer?.updateProps({
                items: props.items,
                command: (item: SlashItem) => props.command(item),
              });
              if (wrapper)
                positionFloating(wrapper, props.clientRect?.() ?? null);
            },
            onKeyDown: (props: SuggestionKeyDownProps) => {
              if (props.event.key === "Escape") {
                unmount();
                return true;
              }
              return renderer?.ref?.onKeyDown(props.event) ?? false;
            },
            onExit: () => {
              unmount();
            },
          };
        },
      }),
    ];
  },
});
