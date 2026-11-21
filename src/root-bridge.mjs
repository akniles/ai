const stoppedStatus = 423;
const allowedStatuses = new Set(["active", "done", "abandoned"]);

export class RootRuntimeStopped extends Error {
  constructor() {
    super("Root runtime is stopped");
    this.name = "RootRuntimeStopped";
  }
}

export function createRootBridge({ url, token }) {
  let origin;
  try {
    const target = new URL(url);
    if (!["http:", "https:"].includes(target.protocol) || target.username ||
        target.password || target.pathname !== "/" || target.search || target.hash)
      throw new Error();
    origin = target.origin;
  } catch {
    throw new Error("Root bridge requires a trusted HTTP(S) origin");
  }
  if (typeof token !== "string" || !token.trim() || /[\r\n]/.test(token))
    throw new Error("Root bridge requires a runtime credential");

  function publicText(text, limit) {
    if (typeof text !== "string") return "";
    return text.replaceAll(token, "[redacted]").trim().slice(0, limit);
  }

  async function request(path, body) {
    let response;
    try {
      response = await fetch(new URL(path, origin), {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new Error("Root control request failed");
    }
    if (response.status === stoppedStatus) throw new RootRuntimeStopped();
    if (!response.ok) throw new Error(`Root control rejected the request (HTTP ${response.status})`);
    if (response.status === 204) return null;
    try {
      return await response.json();
    } catch {
      throw new Error("Root control returned invalid JSON");
    }
  }

  let goalId;
  let claimedId;
  let replyAttempted = false;

  return Object.freeze({
    async context() {
      try {
        const state = await request("/runtime/context");
        const goal = Array.isArray(state?.goals)
          ? state.goals.find(g => g?.status === "active" && typeof g.id === "string" &&
              (!goalId || g.id === goalId))
          : null;
        return {
          goals: goal ? [{ id: goal.id, status: "active", text: publicText(goal.text, 2000) }] : [],
          time: { now: publicText(state?.time?.now, 50), timezone: publicText(state?.time?.timezone, 100) },
          notificationCount: Array.isArray(state?.notifications) ? state.notifications.length : 0,
        };
      } catch (error) {
        if (error instanceof RootRuntimeStopped) return null;
        throw error;
      }
    },

    async claimOwnerMessage() {
      if (claimedId) return null;
      const pending = await request("/runtime/inbox/next");
      if (pending === null) return null;
      if (!pending || typeof pending.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(pending.id) ||
          typeof pending.text !== "string" || !pending.text.trim() || pending.text.length > 2000)
        throw new Error("Invalid private owner message");
      claimedId = pending.id;
      return { text: pending.text };
    },

    async replyToOwnerMessage(body) {
      if (!claimedId || replyAttempted) throw new Error("No available owner message claim");
      if (typeof body !== "string" || !body.trim() || body.length > 2000 || body.includes(token))
        throw new Error("Invalid private owner reply");
      replyAttempted = true;
      const result = await request("/runtime/inbox/reply", { id: claimedId, body });
      if (result?.ok !== true) throw new Error("Private owner reply was not accepted");
      claimedId = undefined;
      replyAttempted = false;
    },

    async setGoal({ text, status = "active", id }) {
      const label = publicText(text, 2000);
      if (!label || !allowedStatuses.has(status)) throw new Error("Invalid public goal");
      if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(id))
        throw new Error("An operator-selected public goal ID is required");
      if (goalId && id !== goalId) throw new Error("Root bridge already manages a different goal");
      goalId = id;
      return request("/runtime/action", { name: "goal_set", id, text: label, status });
    },

    async observe({ name = "agent.work", input, output, start = Date.now(), traceId, parentSpanId }) {
      if (name !== "agent.work") throw new Error("Only agent.work observations are supported");
      if (!Number.isSafeInteger(start) || start < 0 || start > Date.now())
        throw new Error("Invalid observation start");
      if (traceId !== undefined && (typeof traceId !== "string" || !/^(?!0{32}$)[a-f0-9]{32}$/.test(traceId)))
        throw new Error("Invalid observation trace ID");
      if (parentSpanId !== undefined && (!traceId || typeof parentSpanId !== "string" ||
          !/^(?!0{16}$)[a-f0-9]{16}$/.test(parentSpanId)))
        throw new Error("Invalid observation parent span ID");

      // The old observation route does not check panic itself; check it before publishing.
      await request("/runtime/context");
      const task = publicText(input?.task, 2000);
      const report = publicText(typeof output === "string" ? output : output?.report, 12000);
      if (!task || !report) throw new Error("A public task and report are required");
      return request("/runtime/observation", {
        name,
        input: { task },
        output: { report },
        start,
        _context: {
          ...(traceId ? { traceId } : {}),
          ...(parentSpanId ? { parentSpanId } : {}),
          traceName: "Pi work",
          role: "work",
        },
      });
    },

    async journal({ summary }) {
      const text = publicText(summary, 2000);
      if (!text) throw new Error("A public journal summary is required");
      return request("/runtime/action", { name: "journal", summary: text });
    },
  });
}
