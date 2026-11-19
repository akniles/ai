import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Store } from "./store.mjs";
import { Gateway } from "./gateway.mjs";
import { DockerSupervisor } from "./supervisor.mjs";
import { Telemetry } from "./telemetry.mjs";
import { Memory } from "./memory.mjs";
import { ChatGPTGateway } from "./chatgpt.mjs";
import { publicSnapshot, publicObservation } from "./public.mjs";
import { redact } from "./redact.mjs";
import { Prompts } from "./prompts.mjs";
import { WebChat, validChat } from "./web-chat.mjs";

const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const text = (v, max = 4000) => {
  if (typeof v !== "string" || !v.trim() || v.length > max)
    throw new Error("Invalid text");
  return v;
};
async function json(req) {
  let s = "";
  for await (const b of req) {
    s += b;
    if (Buffer.byteLength(s) > 200000) throw new Error("Request too large");
  }
  return s ? JSON.parse(s) : {};
}
export function createControl({
  store,
  ownerToken,
  runtimeToken,
  memoryToken,
  publicToken,
  webChatToken,
  supervisor,
  gateway,
  memory,
  telemetry,
  prompts,
  secrets = [],
}) {
  if (
    !ownerToken ||
    !runtimeToken ||
    ownerToken === runtimeToken ||
    ownerToken === memoryToken
  )
    throw new Error("Distinct owner/runtime credentials required");
  if (
    webChatToken &&
    [ownerToken, runtimeToken, memoryToken, publicToken].includes(webChatToken)
  )
    throw new Error("Distinct website chat credential required");
  const webChat = new WebChat(store);
  let transition = Promise.resolve();
  let generation = 0;
  const serialize = (f) => {
    const result = transition.then(f);
    transition = result.catch(() => {});
    return result;
  };
  async function panic() {
    generation++;
    // Latch and abort synchronously before waiting for Docker or a previous start.
    store.set("panic", true);
    store.event("control.panic");
    gateway.abort();
    return serialize(async () => {
      await supervisor.stop();
      return { stopped: true };
    });
  }
  async function resume() {
    if (gateway.enabled === false)
      throw new Error(
        "Inference backend disabled; configure the selected provider first",
      );
    const ticket = ++generation;
    return serialize(async () => {
      store.set("panic", true);
      await supervisor.stop();
      if (ticket !== generation)
        throw new Error("Resume superseded by newer control command");
      store.set("panic", false);
      try {
        await supervisor.start();
      } catch (e) {
        store.set("panic", true);
        throw e;
      }
      if (ticket !== generation) {
        store.set("panic", true);
        await supervisor.stop();
        throw new Error("Resume superseded");
      }
      store.event("control.resumed");
      return { running: true };
    });
  }
  async function action(a) {
    let result;
    switch (a.name) {
      case "inbox_list":
        result = store.notifications();
        break;
      case "inbox_read":
        result = store.readMessage(text(a.id, 100));
        break;
      case "inbox_reply":
        result = store.reply(text(a.chat, 100), text(a.body));
        break;
      case "chat_set":
        result = store.chat(text(a.chat, 100), a.blocked, a.muted);
        break;
      case "memory_decide": {
        if (typeof a.save !== "boolean")
          throw new Error("save must be boolean");
        store.decide(text(a.fact), a.save, text(a.reason, 1000));
        result = a.save
          ? store.remember(
              a.fact,
              a.source ?? "agent",
              a.kind ?? "observation",
              a.core === true,
              a.title === undefined ? null : text(a.title, 120),
            )
          : { saved: false };
        break;
      }
      case "memory_search":
        result = await memory.search(text(a.query, 1000), a._context);
        break;
      case "memory_core_set": {
        if (a.core && store.core().length >= 12)
          throw new Error("Core memory full");
        store.db
          .prepare("UPDATE memories SET core=? WHERE id=?")
          .run(Number(a.core === true), text(a.id, 100));
        result = { ok: true };
        break;
      }
      case "goal_set":
        result = store.goal(
          text(a.text, 2000),
          ["active", "done", "abandoned"].includes(a.status)
            ? a.status
            : "active",
          a.id,
        );
        break;
      case "state_set": {
        if (Buffer.byteLength(JSON.stringify(a.state)) > 12000)
          throw new Error("Working state too large");
        store.set("working_state", a.state);
        result = { ok: true };
        break;
      }
      case "journal":
        store.event("agent.decision", {
          summary: text(a.summary),
          reason: a.reason,
        });
        result = { ok: true };
        break;
      case "operation": {
        store.db
          .prepare("INSERT OR REPLACE INTO operations VALUES (?,?,?,?)")
          .run(
            text(a.id, 100),
            new Date().toISOString(),
            text(a.status, 30),
            JSON.stringify(a.data ?? {}),
          );
        if (a.status !== "running")
          telemetry?.record(
            `execution.${a.data.kind}`,
            { id: a.id },
            { status: a.status, ...a.data },
            a.startedAt,
            a._context,
          );
        result = { ok: true };
        break;
      }
      case "operation_list":
        result = store.db
          .prepare("SELECT * FROM operations ORDER BY time DESC LIMIT 20")
          .all()
          .map((r) => ({ ...r, data: JSON.parse(r.data) }));
        break;
      case "cycle":
        store.set("last_cycle", new Date().toISOString());
        store.event("agent.cycle", a.data ?? {});
        result = { ok: true };
        break;
      case "scheduler_set": {
        if (!["working", "waiting", "backoff"].includes(a.phase))
          throw new Error("Invalid scheduler phase");
        if (a.phase === "working") {
          const state = store.get("working_state") ?? {};
          // A requested delay belongs to one work period, not every future period.
          for (const key of [
            "next_wake_seconds",
            "pause_seconds",
            "next_wake",
            "pause_reason",
          ])
            delete state[key];
          store.set("working_state", state);
          store.set("wake_request_source", null);
          store.set("work_source", null);
        }
        const next = Date.parse(a.nextWakeAt);
        store.set("scheduler", {
          phase: a.phase,
          origin: a.origin ?? null,
          reason: a.reason ?? null,
          source:
            store.get(
              a.origin === "agent" ? "wake_request_source" : "work_source",
            ) ?? null,
          nextWakeAt:
            a.phase === "working"
              ? null
              : new Date(
                  Number.isFinite(next) ? next : Date.now() + 60000,
                ).toISOString(),
        });
        return { ok: true };
      }
      default:
        throw new Error("Unknown action");
    }
    if (!["operation", "operation_list", "cycle"].includes(a.name))
      store.event("tool.used", { tool: a.name });
    return result;
  }
  const server = http.createServer(async (req, res) => {
    const send = (status, data, headers = {}) => {
      res.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
        ...headers,
      });
      res.end(JSON.stringify(data));
    };
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      if (req.method === "GET" && path === "/health")
        return send(200, { ok: true });
      const token = req.headers.authorization?.replace(/^Bearer /, "");
      const owner = equal(token, ownerToken),
        runtime = equal(token, runtimeToken),
        mem = equal(token, memoryToken),
        viewer = equal(token, publicToken),
        visitor = !!webChatToken && equal(token, webChatToken);
      if (!owner && !runtime && !mem && !viewer && !visitor)
        return send(401, { error: "Unauthorized" });
      if (
        (runtime || owner) &&
        path === "/runtime/observation" &&
        req.method === "POST"
      ) {
        const b = await json(req);
        const observation = telemetry?.record(
          b.name,
          b.input,
          b.output,
          b.start,
          b._context,
        );
        if (b.name === "tool.state_set" && b.output?.ok)
          store.set("wake_request_source", observation ?? null);
        if (["agent.work", "agent.goal_selection"].includes(b.name))
          store.set("work_source", observation ?? null);
        return send(200, observation ?? null);
      }
      if (visitor && path === "/website/chat" && req.method === "POST") {
        const b = await json(req);
        // Visitor text, including /panic, is data. This path has no owner-command handling.
        const result = webChat.receive(b);
        return send(result.accepted ? 202 : 403, result);
      }
      if (visitor && path === "/website/chat" && req.method === "GET") {
        const chat = new URL(req.url, "http://localhost").searchParams.get(
          "chat",
        );
        if (!validChat(chat)) return send(400, { error: "Invalid chat" });
        return send(
          200,
          redact(webChat.messages(chat), [
            ownerToken,
            runtimeToken,
            memoryToken,
            publicToken,
            webChatToken,
            ...secrets,
          ]),
        );
      }
      if (
        (owner || runtime) &&
        req.method === "GET" &&
        path === "/runtime/prompts"
      ) {
        if (!owner && store.get("panic"))
          return send(423, { error: "Runtime stopped" });
        return send(200, await prompts.bundle());
      }
      if ((viewer || owner) && req.method === "GET" && path === "/public") {
        let page = { rows: [], cursor: null };
        let tracingAvailable = true;
        try {
          const cursor = new URL(req.url, "http://localhost").searchParams.get(
            "cursor",
          );
          page = (await telemetry?.observations(undefined, cursor)) ?? page;
        } catch {
          tracingAvailable = false;
        }
        return send(
          200,
          redact(
            {
              ...publicSnapshot(store, gateway, page.rows),
              nextCursor: page.cursor,
              tracingAvailable,
            },
            [
              ownerToken,
              runtimeToken,
              memoryToken,
              publicToken,
              webChatToken,
              ...secrets,
            ],
          ),
        );
      }
      if (
        (viewer || owner) &&
        req.method === "GET" &&
        /^\/public\/traces\/[a-f0-9]{32}$/.test(path)
      ) {
        const traceId = path.split("/").at(-1);
        const rows = [];
        let cursor;
        do {
          const page = await telemetry.observations(traceId, cursor);
          rows.push(...page.rows);
          cursor = page.cursor;
        } while (cursor);
        const observations = rows
          .filter((o) => o.traceId === traceId)
          .map((o) =>
            publicObservation(o, [
              ownerToken,
              runtimeToken,
              memoryToken,
              publicToken,
              webChatToken,
              ...secrets,
            ]),
          );
        if (!observations.length)
          return send(404, { error: "Trace not found" });
        return send(200, { traceId, observations });
      }
      if (owner && req.method === "POST" && path === "/panic")
        return send(200, await panic());
      if (owner && req.method === "POST" && path === "/resume")
        return send(200, await resume());
      if (owner && req.method === "GET" && path === "/status")
        return send(200, {
          panic: store.get("panic"),
          inferenceEnabled: gateway.enabled,
          model: gateway.model,
          committedUsd: store.committed(),
          budgetUsd: gateway.cap,
          activeCalls: gateway.active.size,
          ...store.context(),
        });
      if (owner && req.method === "GET" && path === "/events")
        return send(200, store.events());
      if (owner && req.method === "GET" && path === "/outbox")
        return send(
          200,
          store.db
            .prepare(
              "SELECT * FROM messages WHERE direction='out' ORDER BY time DESC LIMIT 100",
            )
            .all(),
        );
      if (owner && req.method === "POST" && path === "/inbox") {
        const b = await json(req);
        text(b.chat, 100);
        text(b.sender, 100);
        text(b.body, 20000);
        // Owner control commands never pass through optional attention or blocked chats.
        if (b.body.trim() === "/panic") return send(200, await panic());
        if (b.body.trim() === "/resume") return send(200, await resume());
        return send(200, store.receive(b));
      }
      if (runtime && req.method === "GET" && path === "/runtime/context") {
        if (store.get("panic")) return send(423, { error: "Runtime stopped" });
        return send(200, store.context());
      }
      if (runtime && req.method === "GET" && path === "/runtime/wake") {
        if (store.get("panic")) return send(423, { error: "Runtime stopped" });
        return send(200, { attentionVersion: store.attentionVersion() });
      }
      if (runtime && req.method === "POST" && path === "/runtime/action") {
        if (store.get("panic")) return send(423, { error: "Runtime stopped" });
        const a = await json(req);
        if (store.get("panic")) return send(423, { error: "Runtime stopped" });
        return send(200, await action(a));
      }
      if (
        (runtime || mem) &&
        req.method === "POST" &&
        path === "/v1/chat/completions"
      ) {
        if (store.get("panic")) return send(423, { error: "Runtime stopped" });
        const b = await json(req);
        // Recheck after consuming the request body; panic can arrive while it streams.
        if (mem)
          b._context = { role: "memory", traceName: "Memory model call" };
        return send(200, await gateway.complete(b));
      }
      return send(403, { error: "Forbidden" });
    } catch (e) {
      store.event("control.error", { message: e.message });
      send(
        e.status ?? 400,
        { error: e.message },
        e.retryAfter ? { "retry-after": String(e.retryAfter) } : {},
      );
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return {
    server,
    panic,
    resume,
    action,
    async reconcile() {
      await supervisor.stop();
      if (!store.get("panic")) await supervisor.start();
    },
  };
}

export async function main() {
  const e = process.env,
    store = new Store(e.STATE_DB ?? ".state/runtime.sqlite");
  store.set("timezone", e.TIMEZONE ?? "Europe/Moscow");
  const telemetry = new Telemetry({
    store,
    url: e.LANGFUSE_URL,
    publicKey: e.LANGFUSE_PUBLIC_KEY,
    secretKey: e.LANGFUSE_SECRET_KEY,
  });
  const gateway =
    e.MODEL_BACKEND === "chatgpt-plan"
      ? new ChatGPTGateway({
          store,
          telemetry,
          enabled: e.MODEL_ENABLED === "true",
          credentialPath:
            e.CHATGPT_CREDENTIALS ?? "/auth/chatgpt-credentials.json",
          model: e.MODEL ?? "gpt-6-luna",
          providerCapConfirmed: e.CHATGPT_PLAN_CAP_CONFIRMED === "true",
          providerCapPercent: Number(e.CHATGPT_PLAN_CAP_PERCENT ?? 50),
        })
      : new Gateway({
          store,
          telemetry,
          enabled: e.MODEL_ENABLED !== "false",
          baseUrl: e.MODEL_BASE_URL,
          key: e.MODEL_API_KEY,
          model: e.MODEL,
          inputPrice: Number(e.INPUT_TOKEN_PRICE),
          outputPrice: Number(e.OUTPUT_TOKEN_PRICE),
          requestPrice: Number(e.REQUEST_PRICE ?? 0),
          cap: Number(e.MODEL_BUDGET_USD ?? 10),
        });
  const memory = new Memory(store, e.HINDSIGHT_URL, telemetry);
  const prompts = new Prompts({
    url: e.LANGFUSE_URL,
    publicKey: e.LANGFUSE_PUBLIC_KEY,
    secretKey: e.LANGFUSE_SECRET_KEY,
  });
  const supervisor = new DockerSupervisor(e.WORKER_CONTAINER ?? "ai-worker");
  const control = createControl({
    store,
    telemetry,
    gateway,
    memory,
    prompts,
    supervisor,
    ownerToken: e.OWNER_TOKEN,
    runtimeToken: e.RUNTIME_TOKEN,
    memoryToken: e.MEMORY_TOKEN,
    publicToken: e.PUBLIC_VIEW_TOKEN,
    webChatToken: e.WEB_CHAT_TOKEN,
    secrets: Object.entries(e)
      .filter(([k]) => /TOKEN|SECRET|PASSWORD|AUTH|API_KEY/.test(k))
      .map(([, v]) => v),
  });
  await control.reconcile();
  const timer = setInterval(() => memory.sync(), 30000);
  timer.unref();
  control.server.listen(
    Number(e.PORT ?? 8787),
    e.BIND_ADDRESS ?? "127.0.0.1",
    () => console.log("Control API listening"),
  );
  const stop = () => {
    clearInterval(timer);
    gateway.abort();
    control.server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
