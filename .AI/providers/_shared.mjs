// Shared promptfoo-provider plumbing: parse the prompt blob, call the
// chosen LLM function (cached or fresh), apply optional output filters.

export async function callProvider(prompt, llmFn) {
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
    let [output] = await llmFn(messages, process.env.EVAL_MODEL, config, 1);
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
