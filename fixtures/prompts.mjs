// Test doubles only. Production prompt text lives exclusively in Langfuse.

const texts = {
  "ai-identity":
    "You are a test agent. Human messages are optional observations.",
  "ai-goal-selection": "Choose a goal using goal_set.",
  "ai-subagent-task": "Task: {{task}}",
  "ai-invocation": "Choose your next action.",
};

export const testPrompts = {
  prompts: Object.fromEntries(
    Object.entries(texts).map(([name, prompt]) => [
      name,
      { version: 1, prompt },
    ]),
  ),
};
testPrompts.prompts["ai-identity"].config = {
  tools: [
    {
      type: "function",
      function: {
        name: "goal_set",
        description: "Choose a test goal",
        parameters: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
      },
    },
  ],
};
