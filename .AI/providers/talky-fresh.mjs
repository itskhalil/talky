// Always-fresh promptfoo provider. Every call runs a fresh API request
// and stores the result. Use this for variance runs (promptfoo --repeat N);
// the N invocations produce N independent samples that accumulate in
// the cache for inspection via query.mjs samples.

import { fresh } from "../llm.mjs";
import { callProvider } from "./_shared.mjs";

export default class TalkyFreshProvider {
  constructor(options) {
    this.providerId = options?.id || "talky-fresh";
  }
  id() {
    return this.providerId;
  }
  async callApi(prompt) {
    return callProvider(prompt, fresh);
  }
}
