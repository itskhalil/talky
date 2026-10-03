#!/usr/bin/env node
// Export Talky notes as a Granola-format CSV, for importing into tools that
// accept Granola's export (e.g. Wispr Flow Notetaker).
//
// Column set matches Granola's official export (Settings → Profile → Generate CSV)
// as observed in an August 2026 file:
//   document_id, user_email, document_title, workspace_name, document_created,
//   summary, notes, transcript
// `summary` is the AI notes (Talky's enhanced_notes), `notes` is what the user
// typed (Talky's user_notes). Transcript lines are "Me: …" / "Them: …", which
// is how Granola labels its own two-channel transcripts.
//
// Usage:
//   node scripts/export-granola-csv.mjs [--db path/to/sessions.db] [--out file.csv] [--email you@example.com]
//
// Defaults: Talky's app-data sessions.db, ~/Desktop/talky-granola-export.csv,
// email from $TALKY_EXPORT_EMAIL (or empty).

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const DB = opt(
  "--db",
  join(homedir(), "Library/Application Support/com.khalil.talky/sessions.db"),
);
const OUT = opt("--out", join(homedir(), "Desktop/talky-granola-export.csv"));
const EMAIL = opt("--email", process.env.TALKY_EXPORT_EMAIL ?? "");
const WORKSPACE = "Talky";

const query = (sql) =>
  JSON.parse(
    execFileSync("sqlite3", ["-json", "-readonly", DB, sql], {
      maxBuffer: 1 << 28,
    }).toString() || "[]",
  );

// --- content cleanup -------------------------------------------------------

// Talky marks each enhanced-notes line with [ai] / [noted] (optionally bolded).
// Mirrors strip_tags in src-tauri/src/commands/export.rs.
const TAG_RE = /\*{0,2}\[(?:noted|ai)\]\*{0,2} /g;
const stripTags = (s) =>
  s
    .split("\n")
    .map((line) => line.replace(TAG_RE, "").replace(/\*{4}/g, ""))
    .join("\n");

// user_notes can carry HTML entities from the editor.
const decodeEntities = (s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

const clean = (s) => stripTags(decodeEntities(s ?? "")).trim();

// Merge consecutive segments from the same channel into one "Speaker: text" line.
function formatTranscript(segments) {
  const lines = [];
  for (const seg of segments) {
    const speaker = seg.source === "mic" ? "Me" : "Them";
    const text = seg.text.trim();
    if (!text) continue;
    const last = lines[lines.length - 1];
    if (last && last.speaker === speaker) last.text += " " + text;
    else lines.push({ speaker, text });
  }
  return lines.map((l) => `${l.speaker}: ${l.text}`).join("\n");
}

const isoUtc = (epochSeconds) =>
  new Date(epochSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

// RFC 4180: quote every field; double embedded quotes; CRLF row endings.
const csvField = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const csvRow = (cells) => cells.map(csvField).join(",") + "\r\n";

// --- export ----------------------------------------------------------------

const sessions = query(`
  SELECT s.id, s.title, s.started_at, m.user_notes, m.enhanced_notes
  FROM sessions s
  LEFT JOIN meeting_notes m ON m.session_id = s.id
  ORDER BY s.started_at ASC
`);

const segmentsBySession = new Map();
for (const seg of query(`
  SELECT session_id, source, text FROM transcript_segments ORDER BY session_id, start_ms, id
`)) {
  if (!segmentsBySession.has(seg.session_id))
    segmentsBySession.set(seg.session_id, []);
  segmentsBySession.get(seg.session_id).push(seg);
}

const HEADER = [
  "document_id",
  "user_email",
  "document_title",
  "workspace_name",
  "document_created",
  "summary",
  "notes",
  "transcript",
];

let csv = csvRow(HEADER);
const exported = [];
const skipped = [];

for (const s of sessions) {
  const summary = clean(s.enhanced_notes);
  const notes = clean(s.user_notes);
  const transcript = formatTranscript(segmentsBySession.get(s.id) ?? []);
  // Granola's own export omits notes without a summary; a transcript-only
  // note is usually an accidental recording, so follow the same rule.
  if (!summary && !notes) {
    skipped.push(s.title);
    continue;
  }
  csv += csvRow([
    s.id,
    EMAIL,
    s.title.trim() || "Untitled",
    WORKSPACE,
    isoUtc(s.started_at),
    summary,
    notes,
    transcript,
  ]);
  exported.push({
    title: s.title,
    date: isoUtc(s.started_at).slice(0, 10),
    summary: summary.length,
    notes: notes.length,
    transcript: transcript.length,
  });
}

writeFileSync(OUT, "\uFEFF" + csv, "utf8");

console.log(`Wrote ${exported.length} notes to ${OUT}`);
console.table(exported);
if (skipped.length)
  console.log(
    `Skipped ${skipped.length} note(s) with no summary or notes: ${skipped.join(", ")}`,
  );
