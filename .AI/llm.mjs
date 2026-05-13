// Cached LLM caller backed by .AI/traces/db.mjs.
//
//   cached(msg, model, cfg, n=1)    -> string[]  (n stored outputs; runs API to top up if cache has fewer)
//   fresh(msg, model, cfg, n=1)     -> string[]  (n fresh API calls, always)
//   listSamples({...})              -> row[]     (read cache; no API)
//
// Hash covers system + messages + model + params. Edit any of them and
// the cache auto-invalidates. The classic variance pattern is
// `cached(baselineMsg, …, 3)` against `fresh(variantMsg, …, 3)` — both
// return arrays of three, both store everything they produce.
//
// Inspect runs:  node .AI/traces/query.mjs samples <case>
// Promptfoo wrappers: providers/talky.mjs (cached) and providers/talky-fresh.mjs (fresh).

import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { db, hashPrompt, getAll, insertRun } from "./traces/db.mjs";

const SETTINGS_PATH = join(
  homedir(),
  "Library/Application Support/com.khalil.talky/settings_store.json",
);

function loadSettings(envName) {
  const raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
  const s = raw.settings;
  let env;
  if (envName) {
    env = s.model_environments.find((e) => e.name === envName);
    if (!env) throw new Error(`Environment "${envName}" not found`);
  } else {
    const defaultEnvId = s.default_environment_id;
    env = s.model_environments.find((e) => e.id === defaultEnvId);
    if (!env) throw new Error(`Default environment ${defaultEnvId} not found`);
  }
  return {
    providerId: env.name.toLowerCase(),
    baseUrl: env.base_url,
    apiKey: env.api_key,
    model: env.summarisation_model,
  };
}

function resolveContext(messages, modelOverride, config) {
  const settings = loadSettings(config.environment);
  const model = config.model || modelOverride || settings.model;
  const isAnthropic =
    settings.providerId === "anthropic" ||
    settings.baseUrl?.includes("anthropic.com");
  const systemMessages = messages.filter((m) => m.role === "system");
  const nonSystemMessages = messages.filter((m) => m.role !== "system");
  const params = {
    max_tokens: config.max_tokens ?? 8192,
    ...(config.temperature !== undefined
      ? { temperature: config.temperature }
      : {}),
  };
  const promptHash = hashPrompt({
    system: isAnthropic
      ? systemMessages.map((m) => m.content).join("\n\n")
      : "",
    messages: isAnthropic ? nonSystemMessages : messages,
    model,
    params,
  });
  return {
    settings,
    model,
    isAnthropic,
    systemMessages,
    nonSystemMessages,
    messages,
    params,
    promptHash,
    caseId: config.caseId,
  };
}

async function callAPI(ctx) {
  if (ctx.isAnthropic) {
    const body = {
      model: ctx.model,
      ...ctx.params,
      messages: ctx.nonSystemMessages,
    };
    if (ctx.systemMessages.length > 0) {
      body.system = ctx.systemMessages.map((m) => m.content).join("\n\n");
    }
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ctx.settings.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok)
      throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return {
      output: data.content[0].text,
      usage: {
        in: data.usage?.input_tokens,
        out: data.usage?.output_tokens,
      },
    };
  }
  const body = { model: ctx.model, ...ctx.params, messages: ctx.messages };
  const res = await fetch(`${ctx.settings.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ctx.settings.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok)
    throw new Error(`API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return {
    output: data.choices[0].message.content,
    usage: {
      in: data.usage?.prompt_tokens,
      out: data.usage?.completion_tokens,
    },
  };
}

async function runAndStore(ctx) {
  const t0 = Date.now();
  const { output, usage } = await callAPI(ctx);
  insertRun({
    promptHash: ctx.promptHash,
    caseId: ctx.caseId,
    model: ctx.model,
    params: ctx.params,
    inputTokens: usage.in,
    outputTokens: usage.out,
    latencyMs: Date.now() - t0,
    output,
  });
  return output;
}

export async function cached(messages, modelOverride, config = {}, n = 1) {
  const ctx = resolveContext(messages, modelOverride, config);
  const stored = getAll(ctx.promptHash, ctx.model); // most-recent first
  const outs = stored.slice(0, n).map((r) => r.output_text);
  while (outs.length < n) outs.push(await runAndStore(ctx));
  return outs;
}

export async function fresh(messages, modelOverride, config = {}, n = 1) {
  const ctx = resolveContext(messages, modelOverride, config);
  const outs = [];
  for (let i = 0; i < n; i++) outs.push(await runAndStore(ctx));
  return outs;
}

// Read-only view of every stored run that matches the given inputs.
export function listSamples({
  system = "",
  messages = [],
  model,
  params = {},
  caseId,
}) {
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
