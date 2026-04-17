import React from "react";

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
      <mark
        key={i}
        className="rounded-sm bg-yellow-200/70 px-0.5 text-inherit dark:bg-yellow-500/30"
      >
        {part}
      </mark>
    ) : (
      <React.Fragment key={i}>{part}</React.Fragment>
    ),
  );
}
