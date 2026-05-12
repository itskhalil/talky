// Sqlite-backed cache of LLM runs. Keyed by a hash of the full prompt
// (system + messages + model + params), so identical inputs are reused
// across sessions instead of re-billed.
//
// Schema is created lazily on first use. The DB file lives at
// .AI/traces.db (gitignored). Multiple processes can write concurrently —
// WAL mode is enabled.
//
// Usage:
//   import { hashPrompt, getLatest, insertRun } from './traces/db.mjs';
//   const h = hashPrompt({ system, messages, model, params });
//   const hit = getLatest(h, model);
//   if (hit) return hit.output_text;
//   const out = await callApi(...);
//   insertRun({ promptHash: h, model, ..., output: out });

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DB_PATH = join(__dirname, "..", "traces.db");

let _db;
export function db() {
  if (_db) return _db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  _db = new DatabaseSync(DB_PATH);
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prompt_hash TEXT NOT NULL,
      case_id TEXT,
      model TEXT NOT NULL,
      params_json TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      latency_ms INTEGER,
      output_text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lookup ON runs(prompt_hash, model);
    CREATE INDEX IF NOT EXISTS idx_case ON runs(case_id, created_at);
  `);
  return _db;
}

// Hash the exact bytes that will be sent to the model. Two runs with the
// same hash are guaranteed to have produced the same input, so reusing
// the cached output is safe (modulo model nondeterminism, which we accept).
export function hashPrompt({ system, messages, model, params }) {
  const canonical = JSON.stringify({
    system: system || "",
    messages: messages || [],
    model: model || "",
    params: params || {},
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function getLatest(promptHash, model) {
  return db()
    .prepare(
      "SELECT * FROM runs WHERE prompt_hash = ? AND model = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(promptHash, model);
}

export function getAll(promptHash, model) {
  return db()
    .prepare(
      "SELECT * FROM runs WHERE prompt_hash = ? AND model = ? ORDER BY created_at DESC",
    )
    .all(promptHash, model);
}

export function countMatches(promptHash, model) {
  return db()
    .prepare(
      "SELECT COUNT(*) AS n FROM runs WHERE prompt_hash = ? AND model = ?",
    )
    .get(promptHash, model).n;
}

export function insertRun({
  promptHash,
  caseId,
  model,
  params,
  inputTokens,
  outputTokens,
  latencyMs,
  output,
}) {
  db()
    .prepare(
      `INSERT INTO runs
         (prompt_hash, case_id, model, params_json, input_tokens, output_tokens, latency_ms, output_text, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      promptHash,
      caseId || null,
      model,
      JSON.stringify(params || {}),
      inputTokens ?? null,
      outputTokens ?? null,
      latencyMs ?? null,
      output,
      Date.now(),
    );
}
