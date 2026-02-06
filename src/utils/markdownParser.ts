import { JSONContent } from "@tiptap/core";

/**
 * Parse inline content (bold, italic) from markdown text.
 * Handles **bold**, *italic*, and ***bold italic*** patterns.
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

interface ParseOptions {
  /** Default source attribute for nodes (used in enhanced mode) */
  defaultSource?: string;
}

interface ParsedLine {
  text: string;
  source?: string;
}

/**
 * Parse a bullet list from lines starting at the given index.
 * Returns the parsed list node and the index to continue from.
 */
function parseBulletList(
  lines: ParsedLine[],
  startIndex: number,
  baseIndent: number = 0,
  defaultSource?: string,
): { node: JSONContent; endIndex: number } {
  const listItems: JSONContent[] = [];
  let i = startIndex;

  while (i < lines.length) {
    const line = lines[i].text;
    const source = lines[i].source ?? defaultSource;

    // Count leading spaces
    const leadingSpaces = line.length - line.trimStart().length;
    const indentLevel = Math.floor(leadingSpaces / 2);
    const trimmed = line.trimStart();
    const bulletMatch = trimmed.match(/^-\s+(.*)/);

    // Not a bullet line - end the list
    if (!bulletMatch) break;

    // Less indented than our base - this bullet belongs to parent list
    if (indentLevel < baseIndent) break;

    // More indented - this is a nested list, handled by recursive call
    if (indentLevel > baseIndent) {
      if (listItems.length > 0) {
        const nested = parseBulletList(lines, i, indentLevel, defaultSource);
        listItems[listItems.length - 1].content!.push(nested.node);
        i = nested.endIndex;
      } else {
        // Edge case: indented bullet with no parent - treat as base level
        i++;
      }
      continue;
    }

    // Same indent level - add to current list
    const itemContent = parseInlineContent(bulletMatch[1]);
    listItems.push({
      type: "listItem",
      ...(source ? { attrs: { source } } : {}),
      content: [
        {
          type: "paragraph",
          ...(source ? { attrs: { source } } : {}),
          content: itemContent.length > 0 ? itemContent : [],
        },
      ],
    });
    i++;
  }

  return {
    node: { type: "bulletList", content: listItems },
    endIndex: i,
  };
}

/**
 * Parse an ordered list from lines starting at the given index.
 * Returns the parsed list node and the index to continue from.
 */
function parseOrderedList(
  lines: ParsedLine[],
  startIndex: number,
  baseIndent: number = 0,
  defaultSource?: string,
): { node: JSONContent; endIndex: number } {
  const listItems: JSONContent[] = [];
  let i = startIndex;

  while (i < lines.length) {
    const line = lines[i].text;
    const source = lines[i].source ?? defaultSource;

    // Count leading spaces
    const leadingSpaces = line.length - line.trimStart().length;
    const indentLevel = Math.floor(leadingSpaces / 2);
    const trimmed = line.trimStart();
    const orderedMatch = trimmed.match(/^\d+\.\s+(.*)/);

    // Not an ordered list item - end the list
    if (!orderedMatch) break;

    // Less indented than our base - belongs to parent list
    if (indentLevel < baseIndent) break;

    // More indented - nested list
    if (indentLevel > baseIndent) {
      if (listItems.length > 0) {
        const nested = parseOrderedList(lines, i, indentLevel, defaultSource);
        listItems[listItems.length - 1].content!.push(nested.node);
        i = nested.endIndex;
      } else {
        i++;
      }
      continue;
    }

    // Same indent level - add to current list
    const itemContent = parseInlineContent(orderedMatch[1]);
    listItems.push({
      type: "listItem",
      ...(source ? { attrs: { source } } : {}),
      content: [
        {
          type: "paragraph",
          ...(source ? { attrs: { source } } : {}),
          content: itemContent.length > 0 ? itemContent : [],
        },
      ],
    });
    i++;
  }

  return {
    node: { type: "orderedList", content: listItems },
    endIndex: i,
  };
}

/**
 * Parse markdown text into TipTap JSON structure.
 * Handles: headings, bullet lists, ordered lists, paragraphs, bold, italic.
 */
export function parseMarkdownToTiptap(
  content: string,
  options?: ParseOptions,
): JSONContent {
  if (!content) return { type: "doc", content: [{ type: "paragraph" }] };

  const rawLines = content.split("\n");
  const lines: ParsedLine[] = rawLines.map((text) => ({ text }));
  const nodes: JSONContent[] = [];
  const defaultSource = options?.defaultSource;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].text;
    const trimmed = line.trimStart();
    const source = lines[i].source ?? defaultSource;

    // Empty line - preserve as empty paragraph
    if (trimmed === "") {
      nodes.push({
        type: "paragraph",
        ...(source ? { attrs: { source } } : {}),
        content: [],
      });
      i++;
      continue;
    }

    // Skip horizontal rules (---, ***, ___)
    if (/^[-*_]{3,}$/.test(trimmed)) {
      i++;
      continue;
    }

    // Heading (# to ####)
    const headingMatch = trimmed.match(/^(#{1,4})\s+(.*)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const headingContent = parseInlineContent(headingMatch[2]);
      nodes.push({
        type: "heading",
        attrs: { level, ...(source ? { source } : {}) },
        content: headingContent.length > 0 ? headingContent : [],
      });
      i++;
      continue;
    }

    // Bullet list
    if (trimmed.match(/^-\s/)) {
      const bulletList = parseBulletList(lines, i, 0, defaultSource);
      nodes.push(bulletList.node);
      i = bulletList.endIndex;
      continue;
    }

    // Ordered list
    if (trimmed.match(/^\d+\.\s/)) {
      const orderedList = parseOrderedList(lines, i, 0, defaultSource);
      nodes.push(orderedList.node);
      i = orderedList.endIndex;
      continue;
    }

    // Regular paragraph
    const paragraphContent = parseInlineContent(trimmed);
    nodes.push({
      type: "paragraph",
      ...(source ? { attrs: { source } } : {}),
      content: paragraphContent.length > 0 ? paragraphContent : [],
    });
    i++;
  }

  return {
    type: "doc",
    content: nodes.length > 0 ? nodes : [{ type: "paragraph" }],
  };
}

/**
 * Recursively serialize a bullet list with proper indentation.
 */
function serializeBulletList(
  node: JSONContent,
  lines: string[],
  depth: number,
): void {
  if (!node.content) return;
  const indent = "  ".repeat(depth);

  for (const li of node.content) {
    // Find paragraph and nested lists in the list item
    const para = li.content?.find((c) => c.type === "paragraph");
    const nestedBullet = li.content?.find((c) => c.type === "bulletList");
    const nestedOrdered = li.content?.find((c) => c.type === "orderedList");

    const text = para ? inlineToMarkdown(para.content) : "";
    lines.push(`${indent}- ${text}`);

    // Recursively serialize nested lists
    if (nestedBullet) {
      serializeBulletList(nestedBullet, lines, depth + 1);
    }
    if (nestedOrdered) {
      serializeOrderedList(nestedOrdered, lines, depth + 1);
    }
  }
}

/**
 * Recursively serialize an ordered list with proper indentation.
 */
function serializeOrderedList(
  node: JSONContent,
  lines: string[],
  depth: number,
): void {
  if (!node.content) return;
  const indent = "  ".repeat(depth);

  let idx = 1;
  for (const li of node.content) {
    const para = li.content?.find((c) => c.type === "paragraph");
    const nestedBullet = li.content?.find((c) => c.type === "bulletList");
    const nestedOrdered = li.content?.find((c) => c.type === "orderedList");

    const text = para ? inlineToMarkdown(para.content) : "";
    lines.push(`${indent}${idx}. ${text}`);
    idx++;

    if (nestedBullet) {
      serializeBulletList(nestedBullet, lines, depth + 1);
    }
    if (nestedOrdered) {
      serializeOrderedList(nestedOrdered, lines, depth + 1);
    }
  }
}

/**
 * Serialize TipTap JSON back to markdown text.
 */
export function serializeTiptapToMarkdown(json: JSONContent): string {
  if (!json.content) return "";
  const lines: string[] = [];

  for (const node of json.content) {
    if (node.type === "heading") {
      const level = (node.attrs?.level as number) ?? 2;
      const hashes = "#".repeat(level);
      const text = inlineToMarkdown(node.content);
      lines.push(`${hashes} ${text}`);
    } else if (node.type === "bulletList") {
      serializeBulletList(node, lines, 0);
    } else if (node.type === "orderedList") {
      serializeOrderedList(node, lines, 0);
    } else if (node.type === "paragraph") {
      const text = inlineToMarkdown(node.content);
      lines.push(text);
    }
  }

  return lines.join("\n");
}
