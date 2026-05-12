#!/usr/bin/env node
// Tiny CLI for inspecting the traces DB.
//
//   node .AI/traces/query.mjs stats           — overall counts
//   node .AI/traces/query.mjs cases           — runs grouped by case_id
//   node .AI/traces/query.mjs show <id>       — dump a single run
//   node .AI/traces/query.mjs prune <days>    — delete runs older than N days

import { db } from "./db.mjs";

const cmd = process.argv[2] || "stats";

function fmtTs(ms) {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

if (cmd === "stats") {
  const r = db()
    .prepare(
      `SELECT COUNT(*) AS n, COUNT(DISTINCT prompt_hash) AS prompts,
              COUNT(DISTINCT case_id) AS cases, COUNT(DISTINCT model) AS models,
              SUM(input_tokens) AS in_toks, SUM(output_tokens) AS out_toks
         FROM runs`,
    )
    .get();
  console.log(
    `${r.n} runs across ${r.prompts} prompts × ${r.cases} cases × ${r.models} models`,
  );
  console.log(`tokens: in=${r.in_toks ?? 0} out=${r.out_toks ?? 0}`);
} else if (cmd === "cases") {
  const rows = db()
    .prepare(
      `SELECT case_id, model, COUNT(*) AS n, MAX(created_at) AS last
         FROM runs GROUP BY case_id, model ORDER BY last DESC`,
    )
    .all();
  for (const r of rows) {
    console.log(`${fmtTs(r.last)}  n=${r.n}  ${r.model}  ${r.case_id ?? "(no case_id)"}`);
  }
} else if (cmd === "show") {
  const id = Number(process.argv[3]);
  const r = db().prepare("SELECT * FROM runs WHERE id = ?").get(id);
  if (!r) {
    console.error(`no run ${id}`);
    process.exit(1);
  }
  console.log(
    `id=${r.id} case=${r.case_id} model=${r.model} ${fmtTs(r.created_at)}`,
  );
  console.log(
    `tokens in=${r.input_tokens} out=${r.output_tokens}  latency=${r.latency_ms}ms`,
  );
  console.log(`prompt_hash=${r.prompt_hash}`);
  console.log("---");
  console.log(r.output_text);
} else if (cmd === "prune") {
  const days = Number(process.argv[3] || "30");
  const cutoff = Date.now() - days * 86400 * 1000;
  const r = db().prepare("DELETE FROM runs WHERE created_at < ?").run(cutoff);
  console.log(`deleted ${r.changes} runs older than ${days}d`);
} else {
  console.error("usage: query.mjs {stats|cases|show <id>|prune <days>}");
  process.exit(1);
}
