# Talky MCP server

Gives Claude read access to your Talky meeting notes, so you can ask about past
meetings from Claude Desktop or Claude Code instead of opening the app.

Nothing leaves your machine. The server reads `sessions.db` directly, on the
same computer, opened read-only — it cannot write to your notes.

## Tools

| Tool                    | What it does                                                     |
| ----------------------- | ---------------------------------------------------------------- |
| `search_notes`          | Text search across titles, your own notes, and enhanced notes    |
| `list_notes`            | Recent notes, filtered by folder, tags, or date range            |
| `get_note`              | One note in full, with attachments and optionally the transcript |
| `list_folders_and_tags` | Folders and tags with their ids, so they can be used as filters  |

## Install

### Claude Desktop

Package it as a desktop extension and double-click the result:

```bash
cd mcp
npm install
npx @anthropic-ai/mcpb pack
```

### Claude Code

```bash
claude mcp add talky -- node /absolute/path/to/talky/mcp/src/index.js
```

The directory is also a Claude Code plugin, so `claude --plugin-dir ./mcp`
loads it without installing anything.

## Where it looks for your notes

1. `TALKY_DB_PATH`, if set
2. the custom data directory in Talky's `settings_store.json`, if you moved it
3. Talky's default: `~/Library/Application Support/com.khalil.talky/sessions.db`
   on macOS, `%APPDATA%\com.khalil.talky\sessions.db` on Windows

## Two things it deliberately won't do

**It won't return a sealed transcript.** Talky lets you permanently clear the
transcript of a sensitive meeting. Those notes stay readable here, but the
transcript is reported as sealed and never returned — a back door around that
feature would make the feature worthless.

**It won't guess who spoke.** Talky records the audio source, not the speaker.
Transcript lines are labelled `[Mic]` (whoever the recorder's microphone picked
up, which in a room is everyone) and `[Other]` (system audio from remote
participants).

## Develop

```bash
npm test
```

The tests spawn the server and talk JSON-RPC to it over stdio against a
throwaway database, so they cover the MCP wiring, not just the SQL.
