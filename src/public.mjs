import { redact } from "./redact.mjs";
export function observationView(o) {
  return {
    id: o.id,
    traceId: o.traceId,
    parentId: o.parentObservationId ?? null,
    name: o.name,
    type: o.type,
    start: o.startTime,
    end: o.endTime,
    level: o.name.endsWith(".error") ? "ERROR" : o.level,
    model: o.providedModelName ?? o.model ?? null,
    usage: o.usageDetails ?? {},
  };
}
const parsed = (v) => {
  if (typeof v !== "string") return v ?? {};
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};
export function publicObservation(o, secrets = []) {
  const view = observationView(o);
  const output = parsed(o.output);
  return {
    ...view,
    input: redact(parsed(o.input), secrets),
    // Historical Responses recordings repeated the entire provider config.
    output: redact(
      o.type === "GENERATION" && output?.object === "response"
        ? output.output
        : output,
      secrets,
    ),
  };
}
export function publicSnapshot(store, gateway, observations = []) {
  const titles = {
    "control.resumed": ["life", "Autonomous activity resumed"],
    "control.panic": ["system", "Owner stopped the runtime"],
    "llm.failed": ["setback", "A model call did not complete"],
    "agent.public": ["note", "Agent journal"],
    "agent.decision": ["note", "Agent journal"],
    "goal.changed": ["goal", "Chose a goal"],
    "telemetry.error": ["setback", "Trace delivery failed"],
    "memory.sync_failed": ["setback", "Memory sync failed"],
    "memory.degraded": ["setback", "Memory search used the local index"],
  };
  const events = store
    .events(300)
    .filter((e) => titles[e.kind])
    .slice(0, 60)
    .map((e) => ({
      id: e.id,
      time: e.time,
      category: titles[e.kind][0],
      title: titles[e.kind][1],
      ...(e.data.message ? { text: e.data.message } : {}),
      ...(["agent.public", "agent.decision"].includes(e.kind)
        ? { note: e.data.summary, reason: e.data.reason }
        : {}),
      ...(e.kind === "goal.changed"
        ? { text: e.data.text, status: e.data.status }
        : {}),
    }));
  const goals = store.db
    .prepare(
      "SELECT id,text,status,updated FROM (SELECT id,text,status,updated,ROW_NUMBER() OVER (PARTITION BY status ORDER BY updated DESC,rowid DESC) position FROM goals) WHERE position<=10 ORDER BY updated DESC,position ASC",
    )
    .all();
  const history = store.db
    .prepare(
      "SELECT id,time,data FROM events WHERE kind='goal.changed' ORDER BY seq DESC LIMIT 1000",
    )
    .all()
    .map((e) => ({ ...e, data: JSON.parse(e.data) }))
    .filter((e) => goals.some((g) => g.id === e.data.id));
  const memories = store.db
    .prepare(
      "SELECT id,title,text,time,kind,core FROM memories ORDER BY time DESC",
    )
    .all();
  return {
    name: "ai",
    model: gateway.model,
    paused: store.get("panic"),
    thinking: gateway.active.size > 0,
    schedule: store.get("scheduler") ?? null,
    born: store.get("born"),
    now: new Date().toISOString(),
    lastActivity: store.get("last_cycle") ?? null,
    events,
    memories,
    memoryStatus: store.db
      .prepare("SELECT COUNT(*) total,MAX(time) lastSavedAt FROM memories")
      .get(),
    state: store.get("working_state") ?? {},
    operations: store.db
      .prepare("SELECT * FROM operations ORDER BY time DESC LIMIT 20")
      .all()
      .map((r) => ({ ...r, data: JSON.parse(r.data) })),
    goals: goals.map((g) => ({
      ...g,
      history: history
        .filter((e) => e.data.id === g.id)
        .map((e) => ({
          time: e.time,
          text: e.data.text,
          status: e.data.status,
        })),
    })),
    observations: observations.map((o) => ({
      ...observationView(o),
      ...(o.type === "GENERATION" ? { model: gateway.model } : {}),
    })),
  };
}
