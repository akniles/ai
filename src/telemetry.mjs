import { randomBytes } from "node:crypto";
const hex = (n) => randomBytes(n).toString("hex");
export class Telemetry {
  constructor({ url, publicKey, secretKey, store }) {
    Object.assign(this, { url, publicKey, secretKey, store });
    this.pending = new Set();
  }
  async observations(traceId, cursor) {
    if (!this.url || !this.publicKey || !this.secretKey)
      throw new Error("Langfuse is not configured");
    if (
      !traceId &&
      !cursor &&
      this.cached &&
      Date.now() - this.cached.time < 5000
    )
      return this.cached.page;
    const query = new URLSearchParams({
      limit: "200",
      fields: traceId ? "core,basic,usage,io" : "core,basic,usage",
      fromStartTime: this.store.get("born"),
      toStartTime: new Date().toISOString(),
      ...(traceId ? { traceId } : {}),
      ...(cursor ? { cursor } : {}),
    });
    const response = await fetch(
      `${this.url}/api/public/v2/observations?${query}`,
      {
        headers: {
          authorization: `Basic ${Buffer.from(`${this.publicKey}:${this.secretKey}`).toString("base64")}`,
        },
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok) throw new Error(`Langfuse read HTTP ${response.status}`);
    const body = await response.json();
    const page = { rows: body.data ?? [], cursor: body.meta?.cursor ?? null };
    if (!traceId && !cursor) this.cached = { time: Date.now(), page };
    return page;
  }
  record(name, input, output, start = Date.now(), metadata = {}) {
    if (!this.url || !this.publicKey || !this.secretKey) {
      this.store.event("telemetry.error", {
        message: "Langfuse is not configured",
      });
      return null;
    }
    const traceId = metadata.traceId ?? hex(16);
    const spanId = metadata.spanId ?? hex(8);
    const failed =
      !!output?.error || ["failed", "timed_out"].includes(output?.status);
    const type = name.startsWith("llm")
      ? "generation"
      : name.startsWith("tool.")
        ? "tool"
        : name.startsWith("agent.")
          ? "agent"
          : "span";
    const attributes = {
      "langfuse.trace.name": metadata.traceName ?? name,
      "langfuse.observation.type": type,
      "langfuse.observation.input": JSON.stringify(input),
      "langfuse.observation.output": JSON.stringify(output),
      "langfuse.observation.level": failed ? "ERROR" : "DEFAULT",
      ...(failed
        ? {
            "langfuse.observation.status_message":
              output.error ?? output.status,
          }
        : {}),
      "langfuse.session.id": "autonomous",
      "langfuse.environment": "experiment",
      ...(metadata.model
        ? { "langfuse.observation.model.name": metadata.model }
        : {}),
      ...(metadata.promptName
        ? {
            "langfuse.observation.prompt.name": metadata.promptName,
            "langfuse.observation.prompt.version": metadata.promptVersion,
          }
        : {}),
      ...Object.fromEntries(
        Object.entries(metadata)
          .filter(
            ([k]) =>
              ![
                "traceId",
                "traceName",
                "spanId",
                "parentSpanId",
                "usage",
                "model",
                "promptName",
                "promptVersion",
              ].includes(k),
          )
          .map(([k, v]) => [
            `langfuse.observation.metadata.${k}`,
            JSON.stringify(v),
          ]),
      ),
      ...(metadata.usage
        ? {
            "langfuse.observation.usage_details": JSON.stringify({
              input: metadata.usage.prompt_tokens,
              output: metadata.usage.completion_tokens,
              total: metadata.usage.total_tokens,
            }),
          }
        : {}),
    };
    const span = {
      traceId,
      spanId,
      ...(metadata.parentSpanId ? { parentSpanId: metadata.parentSpanId } : {}),
      name,
      kind: 1,
      startTimeUnixNano: String(BigInt(start) * 1000000n),
      endTimeUnixNano: String(BigInt(Date.now()) * 1000000n),
      status: { code: failed ? 2 : 1 },
      attributes: Object.entries(attributes).map(([key, value]) => ({
        key,
        value: { stringValue: String(value) },
      })),
    };
    const body = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "ai-runtime" } },
            ],
          },
          scopeSpans: [{ scope: { name: "ai-runtime" }, spans: [span] }],
        },
      ],
    };
    const pending = fetch(`${this.url}/api/public/otel/v1/traces`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-langfuse-ingestion-version": "4",
        authorization: `Basic ${Buffer.from(`${this.publicKey}:${this.secretKey}`).toString("base64")}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`Langfuse write HTTP ${r.status}`);
      })
      .catch((error) =>
        this.store.event("telemetry.error", { message: error.message }),
      )
      .finally(() => this.pending.delete(pending));
    this.pending.add(pending);
    return { id: spanId, traceId, name, start: new Date(start).toISOString() };
  }
}
