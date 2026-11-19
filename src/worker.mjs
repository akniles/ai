import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { randomBytes } from "node:crypto";
import { compilePrompt, promptMetadata } from "./prompts.mjs";
import { Client } from "./client.mjs";
import { Tools } from "./tools.mjs";

export async function ensureActiveGoal(
  client,
  tools,
  { signal, promptSet } = {},
) {
  const context = await client.request("/runtime/context");
  if (context.goals.length) return context;
  signal?.throwIfAborted();
  const startedAt = Date.now();
  const rootId = randomBytes(8).toString("hex");
  const modelId = randomBytes(8).toString("hex");
  const session = client.withContext({
    traceId: randomBytes(16).toString("hex"),
    traceName: "Choosing a goal",
    spanId: modelId,
    parentSpanId: rootId,
    role: "goal-selection",
    ...promptMetadata(promptSet, "ai-goal-selection"),
  });
  const goalTool = promptSet.prompts["ai-identity"].config.tools.find(
    (d) => d.function.name === "goal_set",
  );
  const publicContext = {
    time: context.time,
    coreMemory: context.coreMemory,
    recentGoals: context.recentGoals ?? [],
  };
  let outcome;
  try {
    const r = await session.request("/v1/chat/completions", {
      messages: [
        { role: "system", content: compilePrompt(promptSet, "ai-identity") },
        {
          role: "system",
          content: compilePrompt(promptSet, "ai-goal-selection"),
        },
        {
          role: "system",
          content: JSON.stringify(publicContext),
        },
      ],
      invocation: compilePrompt(promptSet, "ai-invocation"),
      tools: [goalTool],
      tool_choice: "required",
      max_tokens: 1024,
    });
    signal?.throwIfAborted();
    const call = r.choices?.[0]?.message?.tool_calls?.find(
      (c) => c.function.name === "goal_set",
    );
    if (!call)
      throw new Error(
        "Goal selection did not produce a goal; activity will retry within budget",
      );
    const args = JSON.parse(call.function.arguments);
    if (typeof args.text !== "string" || !args.text.trim())
      throw new Error("Invalid public experiment goal selection");
    await tools.execute(
      "goal_set",
      { text: args.text, status: "active" },
      0,
      session.withContext({ spanId: undefined, parentSpanId: modelId }),
    );
    outcome = { goal: args.text };
    return client.request("/runtime/context");
  } catch (error) {
    outcome = { error: error.message };
    throw error;
  } finally {
    await session
      .withContext({ spanId: rootId, parentSpanId: undefined })
      .observe("agent.goal_selection", publicContext, outcome, startedAt);
  }
}

export async function runSession(
  client,
  tools,
  context,
  { task, depth = 0, signal, maxRounds = 6, promptSet } = {},
) {
  const startedAt = Date.now();
  const parentSpanId = client.context?.parentSpanId;
  const rootId = randomBytes(8).toString("hex");
  client = client.withContext({
    traceId: client.context?.traceId ?? randomBytes(16).toString("hex"),
    traceName: client.context?.traceName ?? "Autonomous work",
    spanId: undefined,
    parentSpanId: rootId,
    role: task ? "subagent" : "worker",
    ...promptMetadata(promptSet, "ai-identity"),
  });
  const messages = [
    { role: "system", content: compilePrompt(promptSet, "ai-identity") },
    {
      role: "system",
      content: JSON.stringify(context),
    },
  ];
  if (task)
    messages.push({
      role: "system",
      content: compilePrompt(promptSet, "ai-subagent-task", { task }),
    });
  let outcome;
  try {
    for (let round = 0; round < maxRounds; round++) {
      signal?.throwIfAborted();
      const modelId = randomBytes(8).toString("hex");
      const modelClient = client.withContext({ spanId: modelId });
      const r = await modelClient.request("/v1/chat/completions", {
        messages,
        invocation: compilePrompt(promptSet, "ai-invocation"),
        tools: promptSet.prompts["ai-identity"].config.tools.filter(
          (d) => depth === 0 || d.function.name !== "subagent_start",
        ),
        max_tokens: 2048,
      });
      signal?.throwIfAborted();
      const msg = r.choices[0].message;
      messages.push({
        role: "assistant",
        content: msg.content ?? null,
        ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}),
      });
      if (!msg.tool_calls?.length) return (outcome = msg.content);
      for (const [index, call] of msg.tool_calls.entries()) {
        signal?.throwIfAborted();
        let result;
        try {
          if (index >= 12) throw new Error("Tool batch limit");
          result = await tools.execute(
            call.function.name,
            JSON.parse(call.function.arguments),
            depth,
            modelClient.withContext({
              spanId: undefined,
              parentSpanId: modelId,
            }),
          );
        } catch (e) {
          result = { error: e.message };
        }
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result).slice(0, 16000),
        });
      }
      // Large intermediate context is not silently truncated through tool-call boundaries.
      if (Buffer.byteLength(JSON.stringify(messages)) > 120000)
        return (outcome =
          "Cycle context limit; persisted state and operations remain available.");
    }
    return (outcome =
      "Cycle reached its work quantum; continue from persisted state on the next wake.");
  } catch (error) {
    outcome = { error: error.message };
    throw error;
  } finally {
    await client
      .withContext({ spanId: rootId, parentSpanId })
      .observe(
        task ? "agent.subagent" : "agent.work",
        { task, goals: context.goals, time: context.time },
        outcome,
        startedAt,
      );
  }
}
export function wakePlan(
  state,
  { freshGoal = false, defaultDelay = 60000, now = Date.now() } = {},
) {
  if (freshGoal)
    return {
      delay: 15000,
      origin: "harness",
      reason: "A new goal is ready; the harness will continue shortly.",
    };
  const seconds = state.next_wake_seconds ?? state.pause_seconds;
  const next =
    seconds === undefined
      ? Date.parse(state.next_wake) - now
      : Number(seconds) * 1000;
  if (Number.isFinite(next))
    return {
      delay: Math.min(Math.max(next, 15000), 3600000),
      origin: "agent",
      reason:
        state.pause_reason ||
        "The agent requested this pause without giving a reason.",
    };
  return {
    delay: Math.max(defaultDelay, 15000),
    origin: "harness",
    reason: "The work period ended. The harness scheduled its next check.",
  };
}
export async function waitForWake(
  client,
  { delay, attentionVersion = 0, signal, pollMs = 3000, minWait = 15000 } = {},
) {
  const start = Date.now(),
    deadline = start + delay;
  while (Date.now() < deadline && !signal?.aborted) {
    await sleep(Math.min(pollMs, deadline - Date.now()), undefined, { signal });
    if (Date.now() - start < minWait || Date.now() >= deadline) continue;
    const next = await client.request("/runtime/wake");
    if (next.attentionVersion > attentionVersion) return "notification";
  }
  return "timer";
}
export async function main() {
  const e = process.env,
    workspace = e.WORKSPACE ?? "/workspace";
  await mkdir(workspace, { recursive: true });
  const client = new Client(
      e.CONTROL_URL ?? "http://control:8787",
      e.RUNTIME_TOKEN,
    ),
    tools = new Tools(client, workspace);
  const lifetime = new AbortController();
  const stop = () => {
    lifetime.abort();
    tools.stop();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  tools.runSubagent = async (task, signal, sessionClient) =>
    runSession(sessionClient, tools, await client.request("/runtime/context"), {
      task,
      depth: 1,
      signal,
      maxRounds: 3,
      promptSet: await client.request("/runtime/prompts"),
    });
  let failures = 0;
  while (!lifetime.signal.aborted) {
    let plan = wakePlan(
      {},
      { defaultDelay: Math.max(15000, Number(e.CYCLE_INTERVAL_MS) || 60000) },
    );
    let attentionVersion = 0,
      failed = false;
    try {
      await client.action("scheduler_set", { phase: "working" });
      const promptSet = await client.request("/runtime/prompts");
      const context = await ensureActiveGoal(client, tools, {
        signal: lifetime.signal,
        promptSet,
      });
      attentionVersion = context.attentionVersion;
      context.operations = await client.action("operation_list");
      const result = await runSession(client, tools, context, {
        signal: lifetime.signal,
        promptSet,
      });
      const afterWork = await client.request("/runtime/context");
      await ensureActiveGoal(client, tools, {
        signal: lifetime.signal,
        promptSet,
      });
      await client.action("cycle", { data: { summary: result } });
      failures = 0;
      const state = (await client.request("/runtime/context")).state;
      plan = wakePlan(state, {
        freshGoal: afterWork.goals.length === 0,
        defaultDelay: plan.delay,
      });
    } catch (e) {
      failed = true;
      failures++;
      console.error(`Cycle paused: ${e.message}`);
      plan = {
        delay: Math.min(60000 * 2 ** Math.min(failures, 5), 1800000),
        origin: "harness",
        reason: "An attempt failed. The harness is waiting before retrying.",
      };
    }
    try {
      await client.action("scheduler_set", {
        phase: failed ? "backoff" : "waiting",
        nextWakeAt: new Date(Date.now() + plan.delay).toISOString(),
        origin: plan.origin,
        reason: plan.reason,
      });
      // Messages can wake an idle worker, but never steer an active call or bypass failure backoff.
      if (failed)
        await sleep(plan.delay, undefined, { signal: lifetime.signal });
      else
        await waitForWake(client, {
          delay: plan.delay,
          attentionVersion,
          signal: lifetime.signal,
        });
    } catch {
      await sleep(15000, undefined, { signal: lifetime.signal }).catch(
        () => {},
      );
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
