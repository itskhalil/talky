#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

import {
  getNote,
  listFolders,
  listNotes,
  listTags,
  openDb,
  resolveDbPath,
  searchNotes,
} from "./talky-db.js";

const server = new McpServer({ name: "talky", version: "0.1.0" });

/**
 * Open the database per call rather than holding a handle open. Talky may
 * change its data directory, and a short-lived read-only connection stays out
 * of the app's way.
 */
function withDb(fn) {
  const db = openDb();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function text(body) {
  return { content: [{ type: "text", text: body }] };
}

const filterSchema = {
  folderId: z.string().optional().describe("Only notes in this folder"),
  tagIds: z
    .array(z.string())
    .optional()
    .describe("Only notes carrying any of these tag ids"),
  startedAfter: z
    .string()
    .optional()
    .describe("ISO date — only notes started on or after it"),
  startedBefore: z
    .string()
    .optional()
    .describe("ISO date — only notes started on or before it"),
};

function formatNoteLine(note) {
  const date = note.startedAt ? note.startedAt.slice(0, 10) : "undated";
  const sealed = note.sealedAt ? " [sealed]" : "";
  return `- ${date} — ${note.title}${sealed} (id: ${note.id})`;
}

server.registerTool(
  "search_notes",
  {
    description:
      "Search Talky meeting notes by text across titles, the user's own notes, and AI-enhanced notes. Returns matching notes with an excerpt. Use get_note for the full content of a result.",
    inputSchema: z.object({
      query: z.string().describe("Text to search for"),
      limit: z.number().int().min(1).max(100).default(20).optional(),
      ...filterSchema,
    }),
  },
  async (args) => {
    const hits = withDb((db) => searchNotes(db, args));
    if (hits.length === 0) return text(`No notes match "${args.query}".`);

    const body = hits
      .map((hit) => {
        const line = formatNoteLine(hit);
        return hit.snippet
          ? `${line}\n  ${hit.matchedField}: ${hit.snippet}`
          : line;
      })
      .join("\n");
    return text(`${hits.length} note(s) matching "${args.query}":\n\n${body}`);
  },
);

server.registerTool(
  "list_notes",
  {
    description:
      "List Talky meeting notes newest first, optionally filtered by folder, tags, or date range. Use this to see what meetings happened; use search_notes when looking for specific content.",
    inputSchema: z.object({
      limit: z.number().int().min(1).max(100).default(20).optional(),
      ...filterSchema,
    }),
  },
  async (args) => {
    const notes = withDb((db) => listNotes(db, args));
    if (notes.length === 0) return text("No notes found.");
    return text(
      `${notes.length} note(s):\n\n${notes.map(formatNoteLine).join("\n")}`,
    );
  },
);

server.registerTool(
  "get_note",
  {
    description:
      "Read one Talky note in full: the user's own notes, the AI-enhanced notes, attachments, and optionally the meeting transcript. Transcripts can be long — ask for one only when the notes don't answer the question.",
    inputSchema: z.object({
      id: z
        .string()
        .describe("Note id, as returned by search_notes or list_notes"),
      includeTranscript: z
        .boolean()
        .default(false)
        .optional()
        .describe("Include the full timestamped transcript"),
    }),
  },
  async ({ id, includeTranscript }) => {
    const note = withDb((db) => getNote(db, id, { includeTranscript }));
    if (!note) return text(`No note with id ${id}.`);

    const parts = [`# ${note.title}`, ""];
    parts.push(`Started: ${note.startedAt ?? "unknown"}`);
    if (note.folder) parts.push(`Folder: ${note.folder}`);
    if (note.tags.length) parts.push(`Tags: ${note.tags.join(", ")}`);
    if (note.sealedAt) {
      parts.push(
        `Sealed: ${note.sealedAt} — the transcript for this note was permanently deleted in Talky and cannot be recovered.`,
      );
    }

    parts.push("", "## Notes", note.notes?.trim() || "_No notes were taken._");

    if (note.enhancedNotes) {
      const edited = note.enhancedNotesEdited ? " (edited by the author)" : "";
      parts.push("", `## Enhanced notes${edited}`, note.enhancedNotes.trim());
    }

    if (note.attachments.length) {
      parts.push("", "## Attachments");
      for (const attachment of note.attachments) {
        parts.push(`### ${attachment.filename} (${attachment.mimeType})`);
        parts.push(attachment.extractedText?.trim() || "_No extracted text._");
      }
    }

    if (includeTranscript) {
      if (note.sealedAt) {
        parts.push(
          "",
          "## Transcript",
          "_Sealed — this transcript no longer exists._",
        );
      } else if (note.transcript?.length) {
        parts.push("", "## Transcript");
        parts.push(
          note.transcript
            .map((segment) => {
              const seconds = Math.floor(segment.startMs / 1000);
              const stamp = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(
                seconds % 60,
              ).padStart(2, "0")}`;
              // Talky records the audio source, not the speaker: [Mic] is
              // whoever the recorder's microphone picked up (possibly a whole
              // room), [Other] is system audio from remote participants.
              const source = segment.source === "mic" ? "Mic" : "Other";
              return `[${stamp}] [${source}] ${segment.text}`;
            })
            .join("\n"),
        );
      } else {
        parts.push("", "## Transcript", "_No transcript was recorded._");
      }
    }

    return text(parts.join("\n"));
  },
);

server.registerTool(
  "list_folders_and_tags",
  {
    description:
      "List the folders and tags in Talky, with their ids, so they can be used as filters in search_notes and list_notes.",
    inputSchema: z.object({}),
  },
  async () => {
    const { folders, tags } = withDb((db) => ({
      folders: listFolders(db),
      tags: listTags(db),
    }));

    const format = (label, rows) =>
      rows.length
        ? `${label}:\n${rows.map((r) => `- ${r.name} (id: ${r.id})`).join("\n")}`
        : `${label}: none`;

    return text(
      [format("Folders", folders), "", format("Tags", tags)].join("\n"),
    );
  },
);

async function main() {
  await server.connect(new StdioServerTransport());
  console.error(`Talky MCP server reading ${resolveDbPath()}`);
}

main().catch((error) => {
  console.error("Talky MCP server failed to start:", error);
  process.exit(1);
});
