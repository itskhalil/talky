import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { hashPrompt, getLatest, insertRun } from "../traces/db.mjs";

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

/**
 * Call the LLM using the Talky settings store.
 * Accepts a messages array [{ role, content }] and an optional model override.
 */
export async function callLLM(messages, modelOverride, config = {}) {
  const settings = loadSettings(config.environment);
  let model = config.model || modelOverride || settings.model;

  const isAnthropic =
    settings.providerId === "anthropic" ||
    settings.baseUrl?.includes("anthropic.com");

  const systemMessages = messages.filter((m) => m.role === "system");
  const nonSystemMessages = messages.filter((m) => m.role !== "system");
  const params = {
    max_tokens: config.max_tokens ?? 8192,
    ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
  };

  // Trace lookup. EVAL_REUSE=0 forces a fresh call; default is reuse.
  const promptHash = hashPrompt({
    system: isAnthropic ? systemMessages.map((m) => m.content).join("\n\n") : "",
    messages: isAnthropic ? nonSystemMessages : messages,
    model,
    params,
  });
  const reuse = process.env.EVAL_REUSE !== "0";
  if (reuse) {
    const hit = getLatest(promptHash, model);
    if (hit) {
      if (process.env.EVAL_TRACE_VERBOSE)
        console.error(`[traces] hit ${promptHash.slice(0, 8)} ${model}`);
      return hit.output_text;
    }
  }

  const t0 = Date.now();
  let output, usage;

  if (isAnthropic) {
    const body = { model, ...params, messages: nonSystemMessages };
    if (systemMessages.length > 0) {
      body.system = systemMessages.map((m) => m.content).join("\n\n");
    }
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": settings.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
    const data = await res.json();
    output = data.content[0].text;
    usage = { in: data.usage?.input_tokens, out: data.usage?.output_tokens };
  } else {
    const body = { model, ...params, messages };
    const res = await fetch(`${settings.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`API error: ${res.status} ${await res.text()}`);
    const data = await res.json();
    output = data.choices[0].message.content;
    usage = { in: data.usage?.prompt_tokens, out: data.usage?.completion_tokens };
  }

  insertRun({
    promptHash,
    caseId: config.caseId,
    model,
    params,
    inputTokens: usage.in,
    outputTokens: usage.out,
    latencyMs: Date.now() - t0,
    output,
  });
  return output;
}

/**
 * Promptfoo custom provider — reads credentials and model from Talky settings.
 * Override the model with EVAL_MODEL env var.
 */
export default class TalkyProvider {
  constructor(options) {
    this.providerId = options?.id || "talky-settings";
  }

  id() {
    return this.providerId;
  }

  async callApi(prompt) {
    let messages;
    let config = {};
    try {
      const parsed = JSON.parse(prompt);
      if (Array.isArray(parsed)) {
        const configMsg = parsed.find((m) => m.role === "__config");
        if (configMsg) {
          config = JSON.parse(configMsg.content);
        }
        messages = parsed.filter((m) => m.role !== "__config");
      } else {
        messages = [{ role: "user", content: prompt }];
      }
    } catch {
      messages = [{ role: "user", content: prompt }];
    }

    try {
      let output = await callLLM(messages, process.env.EVAL_MODEL, config);
      if (config.stripTags) {
        output = output.replace(/\[(noted|ai)\]\s?/g, "");
      }
      if (config.cleanPunctuation) {
        // Replace " — " (em-dash with spaces) with ". " and capitalize next char
        output = output.replace(
          / — ([a-z])/g,
          (_, c) => `. ${c.toUpperCase()}`,
        );
        output = output.replace(/ — /g, ". ");
        // Replace "— " at start of continuation (no leading space) with ". "
        output = output.replace(/— ([a-z])/g, (_, c) => `. ${c.toUpperCase()}`);
        output = output.replace(/— /g, ". ");
        // Replace "; " with ". " and capitalize next char
        output = output.replace(/; ([a-z])/g, (_, c) => `. ${c.toUpperCase()}`);
      }
      return { output };
    } catch (err) {
      return { error: err.message };
    }
  }
}
