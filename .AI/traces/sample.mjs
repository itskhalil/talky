// Variance-sampling helpers. Use these when you want N *fresh* outputs
// for the same input, not a cached single. Every call inserts into the
// traces DB, so two `sampleN(..., 2)` invocations leave 4 rows behind —
// the natural "add more samples" flow.
//
// Pair with `listSamples` or `query.mjs samples <case>` to inspect.

import { callLLM } from "../providers/talky.mjs";
import { db, hashPrompt } from "./db.mjs";

// Always runs n fresh API calls. Returns the n outputs in order.
// `config.fresh: true` is injected so EVAL_REUSE=1 can't accidentally
// turn this into n identical cache hits.
export async function sampleN(messages, modelOverride, config, n) {
  const outs = [];
  for (let i = 0; i < n; i++) {
    outs.push(await callLLM(messages, modelOverride, { ...config, fresh: true }));
  }
  return outs;
}

// Read-only view of every stored sample for a given (prompt, model).
// `extras` lets callers also filter by case_id.
export function listSamples({ system, messages, model, params, caseId }) {
  const h = hashPrompt({ system, messages, model, params });
  const where = ["prompt_hash = ?", "model = ?"];
  const args = [h, model];
  if (caseId) {
    where.push("case_id = ?");
    args.push(caseId);
  }
  return db()
    .prepare(
      `SELECT * FROM runs WHERE ${where.join(" AND ")} ORDER BY created_at ASC`,
    )
    .all(...args);
}
