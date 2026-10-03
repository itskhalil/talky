import React from "react";

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Flatten markdown syntax so search snippets read as plain text. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\s#{1,6}\s+/g, " ")
    .replace(/\*\*|__|`/g, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\s[-*+]\s+/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ");
}

export function highlightMatches(
  text: string,
  query: string,
): React.ReactNode[] {
  const q = query.trim();
  if (!q || !text) return [text];
  // Only highlight matches at word starts so short queries like "th" don't
  // paint every "with"/"path"/"both". `\b` is zero-width so split keeps capture groups.
  const re = new RegExp(`\\b(${escapeRegex(q)})`, "gi");
  const parts = text.split(re);
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="rounded-[2px] bg-accent/10 text-text">
        {part}
      </mark>
    ) : (
      <React.Fragment key={i}>{part}</React.Fragment>
    ),
  );
}
