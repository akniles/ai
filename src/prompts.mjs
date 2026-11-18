export const promptNames = [
  "ai-identity",
  "ai-goal-selection",
  "ai-subagent-task",
  "ai-invocation",
];

export function compilePrompt(bundle, name, variables = {}) {
  const prompt = bundle.prompts[name].prompt;
  return prompt.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, key) => {
    if (!(key in variables)) throw new Error(`Prompt variable missing: ${key}`);
    return String(variables[key]);
  });
}

export function promptMetadata(bundle, name) {
  return {
    promptName: name,
    promptVersion: bundle.prompts[name].version,
    promptVersions: Object.fromEntries(
      Object.entries(bundle.prompts).map(([name, prompt]) => [
        name,
        prompt.version,
      ]),
    ),
  };
}

export class Prompts {
  constructor({ url, publicKey, secretKey }) {
    this.url = url;
    this.authorization = `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`;
  }

  async bundle() {
    const entries = await Promise.all(
      promptNames.map(async (name) => {
        const response = await fetch(
          `${this.url}/api/public/v2/prompts/${name}?label=production`,
          {
            headers: { authorization: this.authorization },
            signal: AbortSignal.timeout(10000),
          },
        );
        if (!response.ok)
          throw new Error(`Langfuse prompt ${name}: HTTP ${response.status}`);
        const { prompt, version, config } = await response.json();
        if (typeof prompt !== "string" || !Number.isInteger(version)) {
          throw new Error(`Invalid Langfuse prompt: ${name}`);
        }
        return [name, { prompt, version, config }];
      }),
    );

    return { prompts: Object.fromEntries(entries) };
  }
}
