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
  const session =
    client.withContext?.({
      traceId: randomBytes(16).toString("hex"),
      role: "goal-selection",
      ...promptMetadata(promptSet, "ai-goal-selection"),
    }) ?? client;
  const goalTool = promptSet.prompts["ai-identity"].config.tools.find(
    (d) => d.function.name === "goal_set",
  );
  const publicContext = {
    time: context.time,
    coreMemory: context.coreMemory.filter((m) => m.public),
    recentGoals: (context.recentGoals ?? []).filter((g) => g.public),
  };
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
    session,
  );
  return client.request("/runtime/context");
}

export async function runSession(
  client,
  tools,
  context,
  { task, depth = 0, signal, maxRounds = 6, promptSet } = {},
) {
  client =
    client.withContext?.({
      traceId: randomBytes(16).toString("hex"),
      role: task ? "subagent" : "worker",
      ...promptMetadata(promptSet, "ai-identity"),
    }) ?? client;
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
  for (let round = 0; round < maxRounds; round++) {
    signal?.throwIfAborted();
    const r = await client.request("/v1/chat/completions", {
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
    if (!msg.tool_calls?.length) return msg.content;
    for (const [index, call] of msg.tool_calls.entries()) {
      signal?.throwIfAborted();
      let result;
      try {
        if (index >= 12) throw new Error("Tool batch limit");
        result = await tools.execute(
          call.function.name,
          JSON.parse(call.function.arguments),
          depth,
          client,
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
      return "Cycle context limit; persisted state and operations remain available.";
  }
  return "Cycle reached its work quantum; continue from persisted state on the next wake.";
}
export function wakeDelay(
  state,
  { freshGoal = false, defaultDelay = 60000, now = Date.now() } = {},
) {
  if (freshGoal) return 15000;
  const seconds = state.next_wake_seconds ?? state.pause_seconds;
  const next =
    seconds === undefined
      ? Date.parse(state.next_wake) - now
      : Number(seconds) * 1000;
  return Number.isFinite(next)
    ? Math.min(Math.max(next, 15000), 3600000)
    : Math.max(defaultDelay, 15000);
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
  tools.runSubagent = async (task, signal) =>
    runSession(client, tools, await client.request("/runtime/context"), {
      task,
      depth: 1,
      signal,
      maxRounds: 3,
      promptSet: await client.request("/runtime/prompts"),
    });
  let failures = 0;
  while (!lifetime.signal.aborted) {
    let delay = Math.max(15000, Number(e.CYCLE_INTERVAL_MS) || 60000);
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
      delay = wakeDelay(state, {
        freshGoal: afterWork.goals.length === 0,
        defaultDelay: delay,
      });
    } catch (e) {
      failed = true;
      failures++;
      console.error(`Cycle paused: ${e.message}`);
      delay = Math.min(60000 * 2 ** Math.min(failures, 5), 1800000);
    }
    try {
      await client.action("scheduler_set", {
        phase: failed ? "backoff" : "waiting",
        nextWakeAt: new Date(Date.now() + delay).toISOString(),
      });
      // Messages can wake an idle worker, but never steer an active call or bypass failure backoff.
      if (failed) await sleep(delay, undefined, { signal: lifetime.signal });
      else
        await waitForWake(client, {
          delay,
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
