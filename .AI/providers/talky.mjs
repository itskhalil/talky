// Promptfoo provider — thin wrapper around the cached LLM API.
// All real logic (caching, hashing, API calls) lives in .AI/llm.mjs.

import { cached } from "../llm.mjs";

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
        if (configMsg) config = JSON.parse(configMsg.content);
        messages = parsed.filter((m) => m.role !== "__config");
      } else {
        messages = [{ role: "user", content: prompt }];
      }
    } catch {
      messages = [{ role: "user", content: prompt }];
    }

    try {
      let output = await cached(messages, process.env.EVAL_MODEL, config);
      if (config.stripTags) {
        output = output.replace(/\[(noted|ai)\]\s?/g, "");
      }
      if (config.cleanPunctuation) {
        output = output.replace(
          / — ([a-z])/g,
          (_, c) => `. ${c.toUpperCase()}`,
        );
        output = output.replace(/ — /g, ". ");
        output = output.replace(/— ([a-z])/g, (_, c) => `. ${c.toUpperCase()}`);
        output = output.replace(/— /g, ". ");
        output = output.replace(/; ([a-z])/g, (_, c) => `. ${c.toUpperCase()}`);
      }
      return { output };
    } catch (err) {
      return { error: err.message };
    }
  }
}
