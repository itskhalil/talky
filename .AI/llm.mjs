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
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { db, hashPrompt, getAll, insertRun } from "./traces/db.mjs";

const SETTINGS_PATH = join(
  homedir(),
  "Library/Application Support/com.khalil.talky/settings_store.json",
);

// Repo-root .env, so eval-only keys (OPENROUTER_API_KEY) don't have to live
// in the Talky app settings store. Never overwrites an already-set env var.
function loadDotEnv() {
  const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
  let raw;
  try {
    raw = readFileSync(envPath, "utf-8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const [, key, rawVal] = m;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawVal.trim().replace(/^["']|["']$/g, "");
  }
}
loadDotEnv();

// Named endpoints for models that aren't in the Talky settings store.
// Selected per-call with config.endpoint; without one, settings are used.
const ENDPOINTS = {
  openrouter: {
    providerId: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
  },
};

function loadEndpoint(name, config) {
  const ep = ENDPOINTS[name];
  if (!ep) throw new Error(`Unknown endpoint "${name}"`);
  const apiKey = process.env[ep.apiKeyEnv];
  if (!apiKey)
    throw new Error(`${ep.apiKeyEnv} is not set (checked env and repo .env)`);
  if (!config.model)
    throw new Error(`endpoint "${name}" requires an explicit config.model`);
  return { ...ep, apiKey, model: config.model };
}

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
  const settings = config.endpoint
    ? loadEndpoint(config.endpoint, config)
    : loadSettings(config.environment);
  const model = config.model || modelOverride || settings.model;
  const isAnthropic =
    settings.providerId === "anthropic" ||
    settings.baseUrl?.includes("anthropic.com");
  const systemMessages = messages.filter((m) => m.role === "system");
  const nonSystemMessages = messages.filter((m) => m.role !== "system");
  // max_tokens: null omits the field entirely, matching what production
  // sends on the OpenAI-compatible path (llm_client.rs sends model+messages only).
  // config.extra passes provider-specific body fields (e.g. OpenRouter's
  // reasoning block). It sits in params so it's covered by the cache hash —
  // flipping reasoning off is a different run, not a cache hit.
  const params = {
    ...(config.max_tokens === null
      ? {}
      : { max_tokens: config.max_tokens ?? 8192 }),
    ...(config.temperature !== undefined
      ? { temperature: config.temperature }
      : {}),
    ...(config.extra ?? {}),
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

// Reasoning models hold the connection open for minutes, which is long enough
// for a transient socket drop to look like a hard failure. Retry the ones that
// are worth retrying; surface the rest immediately.
const RETRYABLE =
  /fetch failed|terminated|ECONNRESET|ETIMEDOUT|socket hang up|network|API error: (408|409|425|429|5\d\d)/i;
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 600_000;

async function withRetry(fn, label) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === MAX_ATTEMPTS || !RETRYABLE.test(err.message)) throw err;
      const backoffMs = 2000 * 2 ** (attempt - 1);
      console.warn(
        `[llm] ${label} attempt ${attempt}/${MAX_ATTEMPTS} failed (${err.message}); retrying in ${backoffMs}ms`,
      );
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw lastErr;
}

async function callAPI(ctx) {
  return withRetry(() => callAPIOnce(ctx), ctx.model);
}

async function callAPIOnce(ctx) {
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
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok)
      throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
    const data = await res.json();
    // Thinking-enabled models put a thinking block first, so content[0] is not
    // necessarily the answer. Mirrors llm_client.rs's find_map over blocks.
    const text = data.content?.find((b) => b.type === "text")?.text;
    if (!text)
      throw new Error(
        `Anthropic returned no text block (stop_reason=${data.stop_reason}, blocks=${data.content?.map((b) => b.type).join(",")})`,
      );
    return {
      output: text,
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
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  if (!content) {
    // Reasoning models can spend the whole completion budget on thinking and
    // return an empty content field. Say so, rather than failing downstream.
    const reasoningTokens =
      data.usage?.completion_tokens_details?.reasoning_tokens;
    throw new Error(
      `Empty content from ${ctx.model} (finish_reason=${choice?.finish_reason}` +
        (reasoningTokens ? `, reasoning_tokens=${reasoningTokens}` : "") +
        `)`,
    );
  }
  return {
    output: content,
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
