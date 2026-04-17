import { JSONContent } from "@tiptap/core";

/**
 * Strip [noted] and [ai] source tags (with optional bold wrapping) from notes text.
 * Matches the same pattern used by the Rust backend export.
 */
export function stripNoteTags(text: string): string {
  return text
    .replace(/\*{0,2}\[(?:noted|ai)\]\*{0,2} /g, "")
    .replace(/\*{4}/g, "");
}

/**
 * Parse inline content (bold, italic) from markdown text.
 * Handles **bold**, *italic*, and ***bold italic*** patterns.
 * Used by NoteView's enhanced-mode tag-aware parser. Plain-mode editing
 * goes through `tiptap-markdown` directly in NotesEditor.
 */
export function parseInlineContent(text: string): JSONContent[] {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
  const result: JSONContent[] = [];

  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      result.push({
        type: "text",
        text: part.slice(2, -2),
        marks: [{ type: "bold" }],
      });
    } else if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      result.push({
        type: "text",
        text: part.slice(1, -1),
        marks: [{ type: "italic" }],
      });
    } else {
      result.push({ type: "text", text: part });
    }
  }

  return result;
}

/**
 * Serialize inline content (text nodes with marks) back to markdown.
 */
export function inlineToMarkdown(content?: JSONContent[]): string {
  if (!content) return "";
  return content
    .map((node) => {
      if (node.type !== "text" || !node.text) return "";
      const hasBold = node.marks?.some((m) => m.type === "bold");
      const hasItalic = node.marks?.some((m) => m.type === "italic");
      let t = node.text;
      if (hasBold) t = `**${t}**`;
      if (hasItalic) t = `*${t}*`;
      return t;
    })
    .join("");
}
