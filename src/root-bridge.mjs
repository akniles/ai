const stoppedStatus = 423;

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

  return Object.freeze({
    async context() {
      try {
        return await request("/runtime/context");
      } catch (error) {
        if (error instanceof RootRuntimeStopped) return null;
        throw error;
      }
    },

    async setWorkingGoal({ goal, reason }) {
      const safeGoal = publicText(goal, 160);
      const safeReason = publicText(reason, 240);
      if (!safeGoal || !safeReason || safeGoal !== goal || safeReason !== reason ||
          /[\u0000-\u001f\u007f<>]/u.test(goal + reason))
        throw new Error("Invalid public working goal");
      return request("/runtime/working-goal", { goal: safeGoal, reason: safeReason });
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

  });
}

