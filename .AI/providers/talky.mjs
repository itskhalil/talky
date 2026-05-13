// Cache-first promptfoo provider. Use for normal iteration runs —
// unchanged cases return their stored output instantly.
//
// For variance runs (promptfoo --repeat N), use providers/talky-fresh.mjs
// instead; this provider would return N identical cache hits.

import { cached } from "../llm.mjs";
import { callProvider } from "./_shared.mjs";

export default class TalkyProvider {
  constructor(options) {
    this.providerId = options?.id || "talky";
  }
  id() {
    return this.providerId;
  }
  async callApi(prompt) {
    return callProvider(prompt, cached);
  }
}
