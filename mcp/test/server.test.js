import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { createFixtureDb } from "./fixture.js";

const SERVER = fileURLToPath(new URL("../src/index.js", import.meta.url));

let dir;
let dbPath;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "talky-mcp-"));
  dbPath = join(dir, "sessions.db");
  createFixtureDb(dbPath);
});

after(() => rmSync(dir, { recursive: true, force: true }));

/**
 * Drive the server the way a client does: spawn it, speak newline-delimited
 * JSON-RPC over stdio, and collect the responses.
 */
function callServer(requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, TALKY_DB_PATH: dbPath },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const responses = out.trim().split("\n").filter(Boolean);
      if (responses.length >= requests.filter((r) => "id" in r).length) {
        child.kill();
        resolve({
          responses: responses.map((line) => JSON.parse(line)),
          stderr: err,
        });
      }
    });
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", reject);
    setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out. stdout=${out} stderr=${err}`));
    }, 15000).unref();

    for (const request of requests) {
      child.stdin.write(`${JSON.stringify(request)}\n`);
    }
  });
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  },
};
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };

function callTool(id, name, args = {}) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

function textOf(response) {
  return response.result.content.map((block) => block.text).join("\n");
}

describe("talky mcp server", () => {
  it("lists its tools", async () => {
    const { responses } = await callServer([
      initialize,
      initialized,
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);
    const listed = responses.find((r) => r.id === 2);
    const names = listed.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "get_note",
      "list_folders_and_tags",
      "list_notes",
      "search_notes",
    ]);
  });

  it("searches notes and returns an excerpt", async () => {
    const { responses } = await callServer([
      initialize,
      initialized,
      callTool(2, "search_notes", { query: "enterprise tier" }),
    ]);
    const body = textOf(responses.find((r) => r.id === 2));
    assert.match(body, /Pricing review/);
    assert.match(body, /enterprise tier/);
    assert.match(body, /id: s1/);
  });

  it("returns a note with its notes, enhanced notes and attachments", async () => {
    const { responses } = await callServer([
      initialize,
      initialized,
      callTool(2, "get_note", { id: "s1" }),
    ]);
    const body = textOf(responses.find((r) => r.id === 2));
    assert.match(body, /# Pricing review/);
    assert.match(body, /Folder: Client work/);
    assert.match(body, /Tags: pricing/);
    assert.match(body, /ask about the enterprise tier/);
    assert.match(body, /Enhanced notes \(edited by the author\)/);
    assert.match(body, /Proposed rate card/);
    // Not requested, so it must not appear.
    assert.doesNotMatch(body, /Forty per seat/);
  });

  it("includes the transcript only when asked, labelled by audio source", async () => {
    const { responses } = await callServer([
      initialize,
      initialized,
      callTool(2, "get_note", { id: "s1", includeTranscript: true }),
    ]);
    const body = textOf(responses.find((r) => r.id === 2));
    assert.match(body, /## Transcript/);
    assert.match(body, /\[00:01\] \[Mic\] So on the enterprise tier\./);
    assert.match(body, /\[00:04\] \[Other\] Forty per seat works for us\./);
  });

  it("never returns the transcript of a sealed note", async () => {
    const { responses } = await callServer([
      initialize,
      initialized,
      callTool(2, "get_note", { id: "s2", includeTranscript: true }),
    ]);
    const body = textOf(responses.find((r) => r.id === 2));
    assert.match(body, /Sealed/);
    assert.doesNotMatch(body, /this row should never be returned/);
  });

  it("filters by folder and lists folders and tags", async () => {
    const { responses } = await callServer([
      initialize,
      initialized,
      callTool(2, "list_folders_and_tags"),
      callTool(3, "list_notes", { folderId: "f1" }),
    ]);
    const catalogue = textOf(responses.find((r) => r.id === 2));
    assert.match(catalogue, /Client work \(id: f1\)/);
    assert.match(catalogue, /pricing \(id: t1\)/);

    const filtered = textOf(responses.find((r) => r.id === 3));
    assert.match(filtered, /Pricing review/);
    assert.doesNotMatch(filtered, /Sensitive one-to-one/);
  });
});
