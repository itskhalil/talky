import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const SETTINGS_PATH = join(
  homedir(),
  'Library/Application Support/com.khalil.talky/settings_store.json',
);

function loadSettings() {
  const raw = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
  const s = raw.settings;
  const defaultEnvId = s.default_environment_id;
  const env = s.model_environments.find((e) => e.id === defaultEnvId);
  if (!env) throw new Error(`Default environment ${defaultEnvId} not found`);
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
export async function callLLM(messages, modelOverride) {
  const settings = loadSettings();
  const model = modelOverride || settings.model;

  if (settings.providerId === 'anthropic') {
    const systemMessages = messages.filter((m) => m.role === 'system');
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');

    const body = {
      model,
      max_tokens: 8192,
      messages: nonSystemMessages,
    };
    if (systemMessages.length > 0) {
      body.system = systemMessages.map((m) => m.content).join('\n\n');
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic API error: ${res.status} ${text}`);
    }
    const data = await res.json();
    return data.content[0].text;
  }

  // OpenAI-compatible providers
  const res = await fetch(`${settings.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({ model, max_tokens: 8192, messages }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error: ${res.status} ${text}`);
  }
  const data = await res.json();
  return data.choices[0].message.content;
}

/**
 * Promptfoo custom provider — reads credentials and model from Talky settings.
 * Override the model with EVAL_MODEL env var.
 */
export default class TalkyProvider {
  constructor(options) {
    this.providerId = options?.id || 'talky-settings';
  }

  id() {
    return this.providerId;
  }

  async callApi(prompt) {
    let messages;
    try {
      const parsed = JSON.parse(prompt);
      if (Array.isArray(parsed)) {
        messages = parsed;
      } else {
        messages = [{ role: 'user', content: prompt }];
      }
    } catch {
      messages = [{ role: 'user', content: prompt }];
    }

    try {
      const output = await callLLM(messages, process.env.EVAL_MODEL);
      return { output };
    } catch (err) {
      return { error: err.message };
    }
  }
}
