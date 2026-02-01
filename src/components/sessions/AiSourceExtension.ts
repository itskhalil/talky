import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

/** Module-level flag to prevent source promotion during programmatic setContent */
let _suppressSourcePromotion = false;
export function setSuppressSourcePromotion(v: boolean) {
  _suppressSourcePromotion = v;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    aiSource: {
      setSource: (source: "ai" | "user") => ReturnType;
    };
  }
}

/**
 * Adds a `data-source` attribute ("ai" | "user") to paragraph, heading,
 * bulletList/listItem nodes. When a user edits inside an ai-sourced block
 * the source is promoted to "user".
 */
export const AiSourceExtension = Extension.create({
  name: "aiSource",

  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading", "listItem"],
        attributes: {
          source: {
            default: "user",
            parseHTML: (element) =>
              element.getAttribute("data-source") || "user",
            renderHTML: (attributes) => ({
              "data-source": attributes.source || "user",
            }),
          },
        },
      },
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("aiSourcePromotion"),
        appendTransaction(transactions, _oldState, newState) {
          // Only promote on user-driven edits — not programmatic setContent
          if (_suppressSourcePromotion) return null;
          const hasDocChange = transactions.some((tr) => tr.docChanged);
          if (!hasDocChange) return null;

          const { tr } = newState;
          let modified = false;

          // Walk through the selection range and promote any ai blocks to user
          const { from, to } = newState.selection;
          newState.doc.nodesBetween(from, to, (node, pos) => {
            if (node.attrs.source === "ai") {
              tr.setNodeMarkup(pos, undefined, {
                ...node.attrs,
                source: "user",
              });
              modified = true;
            }
          });

          return modified ? tr : null;
        },
      }),
    ];
  },
});
