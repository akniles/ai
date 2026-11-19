import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.mjs";
import { Telemetry } from "../src/telemetry.mjs";
import { Client } from "../src/client.mjs";
import { createControl } from "../src/control.mjs";
import { Tools } from "../src/tools.mjs";
import { runSession, wakePlan } from "../src/worker.mjs";
import { traceTree } from "../web/trace.js";
import { testPrompts } from "../fixtures/prompts.mjs";

test("OTEL preserves IDs, hierarchy, failed status and immediate ingestion; reads cursor pages", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const writes = [],
    reads = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (options.method === "POST") {
      writes.push(options);
      return { ok: true };
    }
    reads.push(new URL(url));
    return {
      ok: true,
      json: async () => ({
        data: [{ id: "span" }],
        meta: { cursor: reads.length === 1 ? "older" : null },
      }),
    };
  });
  const telemetry = new Telemetry({
    store,
    url: "http://langfuse",
    publicKey: "public",
    secretKey: "secret",
  });
  const context = {
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    parentSpanId: "c".repeat(16),
  };
  const observation = telemetry.record(
    "tool.shell_start",
    { command: "missing" },
    { error: "spawn failed" },
    Date.now(),
    context,
  );
  await Promise.all(telemetry.pending);
  const span = JSON.parse(writes[0].body).resourceSpans[0].scopeSpans[0]
    .spans[0];
  assert.equal(span.spanId, context.spanId);
  assert.equal(span.parentSpanId, context.parentSpanId);
  assert.equal(observation.traceId, context.traceId);
  assert.equal(span.status.code, 2);
  assert.equal(writes[0].headers["x-langfuse-ingestion-version"], "4");
  assert.equal(
    span.attributes.find((a) => a.key === "langfuse.observation.level").value
      .stringValue,
    "ERROR",
  );
  const page = await telemetry.observations(context.traceId);
  const older = await telemetry.observations(context.traceId, page.cursor);
  assert.equal(reads[1].searchParams.get("cursor"), "older");
  assert.equal(older.cursor, null);
});

test("legacy visibility columns are removed without losing memories or goal history", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ai-migrate-"));
  const file = join(dir, "state.sqlite");
  let store = new Store(file);
  const memory = store.remember(
    "Retained fact",
    "agent",
    "rule",
    true,
    "A useful rule",
  );
  const goal = store.goal("Retained goal");
  store.goal("Retained goal", "done", goal.id);
  store.db.exec(
    "ALTER TABLE memories ADD COLUMN public INTEGER DEFAULT 0; ALTER TABLE goals ADD COLUMN public INTEGER DEFAULT 0; CREATE TABLE publications(id TEXT);",
  );
  store.close();
  store = new Store(file);
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  assert.equal(
    store.db.prepare("SELECT title FROM memories WHERE id=?").get(memory.id)
      .title,
    "A useful rule",
  );
  for (const table of ["goals", "memories"])
    assert.ok(
      !store.db
        .prepare("PRAGMA table_info(" + table + ")")
        .all()
        .some((c) => c.name === "public"),
    );
  assert.equal(
    store.db
      .prepare("SELECT count(*) n FROM sqlite_master WHERE name='publications'")
      .get().n,
    0,
  );
  assert.equal(
    store.events().filter((e) => e.kind === "goal.changed").length,
    2,
  );
});

test("work, model, tool and asynchronous command result share real parent relationships; pauses are consumed once", async (t) => {
  const store = new Store(":memory:"),
    records = [];
  const telemetry = {
    record(name, input, output, start, metadata = {}) {
      const r = {
        name,
        input,
        output,
        start,
        ...metadata,
        id: metadata.spanId ?? "new",
      };
      records.push(r);
      return r;
    },
  };
  let rounds = 0;
  const gateway = {
    active: new Set(),
    abort() {},
    async complete(body) {
      telemetry.record("llm", body, {}, Date.now(), body._context);
      return {
        choices: [
          {
            message:
              ++rounds === 1
                ? {
                    tool_calls: [
                      {
                        id: "call",
                        function: {
                          name: "shell_start",
                          arguments: JSON.stringify({
                            command: 'node -e "console.log(42)"',
                          }),
                        },
                      },
                    ],
                  }
                : { content: "Done" },
          },
        ],
      };
    },
  };
  const control = createControl({
    store,
    telemetry,
    gateway,
    memory: {},
    supervisor: { async stop() {}, async start() {} },
    ownerToken: "owner",
    runtimeToken: "runtime",
  });
  control.server.listen(0, "127.0.0.1");
  await once(control.server, "listening");
  const client = new Client(
    "http://127.0.0.1:" + control.server.address().port,
    "runtime",
  );
  store.set("panic", false);
  const tools = new Tools(client, process.cwd());
  t.after(() => {
    tools.stop();
    control.server.closeAllConnections();
    control.server.close();
    store.close();
  });
  await runSession(client, tools, store.context(), { promptSet: testPrompts });
  const job = [...tools.jobs.values()][0];
  for (let i = 0; i < 100 && job.status === "running"; i++)
    await new Promise((r) => setTimeout(r, 20));
  for (
    let i = 0;
    i < 100 && !records.some((r) => r.name === "execution.shell");
    i++
  )
    await new Promise((r) => setTimeout(r, 10));
  const root = records.find((r) => r.name === "agent.work"),
    model = records.find((r) => r.name === "llm"),
    tool = records.find((r) => r.name === "tool.shell_start"),
    result = records.find((r) => r.name === "execution.shell");
  assert.equal(model.parentSpanId, root.id);
  assert.equal(tool.parentSpanId, model.id);
  assert.equal(result.parentSpanId, tool.id);
  assert.equal(result.traceId, root.traceId);
  assert.match(result.output.output, /42/);
  assert.equal(result.output.status, "done");
  const session = client.withContext({
    traceId: root.traceId,
    parentSpanId: root.id,
  });
  tools.runSubagent = (task, signal, child) =>
    runSession(child, tools, store.context(), {
      task,
      signal,
      depth: 1,
      promptSet: testPrompts,
    });
  const subagent = await tools.execute(
    "subagent_start",
    { task: "Bounded check" },
    0,
    session,
  );
  await tools.jobs.get(subagent.id).promise;
  const subRoot = records.find((r) => r.name === "agent.subagent"),
    subTool = records.find((r) => r.name === "tool.subagent_start");
  assert.equal(subRoot.parentSpanId, subTool.id);
  assert.equal(subRoot.traceId, root.traceId);
  await tools.execute(
    "state_set",
    {
      state: {
        plan: "Keep this",
        next_wake_seconds: 1800,
        pause_reason: "Waiting for a measurement",
      },
    },
    0,
    session,
  );
  const plan = wakePlan(store.get("working_state"));
  await client.action("scheduler_set", {
    phase: "waiting",
    origin: plan.origin,
    reason: plan.reason,
    nextWakeAt: new Date(Date.now() + plan.delay).toISOString(),
  });
  assert.equal(store.get("scheduler").source.name, "tool.state_set");
  assert.equal(store.get("scheduler").reason, "Waiting for a measurement");
  await client.action("scheduler_set", { phase: "working" });
  assert.deepEqual(store.get("working_state"), { plan: "Keep this" });
  assert.equal(wakePlan(store.get("working_state")).origin, "harness");
});

test("trace tree uses recorded parents and leaves legacy roots flat", () => {
  const tree = traceTree([
    { id: "tool", parentId: "model", start: "2026-01-01T00:00:02Z" },
    { id: "legacy", start: "2026-01-01T00:00:00Z" },
    { id: "model", parentId: "work", start: "2026-01-01T00:00:01Z" },
    { id: "work", start: "2026-01-01T00:00:00Z" },
  ]);
  assert.equal(tree.length, 2);
  assert.equal(tree[1].children[0].children[0].id, "tool");
});
