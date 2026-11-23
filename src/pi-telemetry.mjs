import { randomBytes } from 'node:crypto';

export const stamp = () => (BigInt(Date.now()) * 1_000_000n).toString();
export const spanId = () => randomBytes(8).toString('hex');
export const attr = (key, text) => ({ key, value: { stringValue: String(text) } });

export function tracePi({ stream, spans, session }) {
  const pending = new Set();
  const emit = ({ traceId, parentSpanId, name, kind, started, input, output, failed, private: privateTrace, extra = [] }) => {
    spans.push({
      traceId, ...(parentSpanId ? { parentSpanId } : {}), spanId: spanId(), name, kind: 1,
      startTimeUnixNano: started, endTimeUnixNano: stamp(), status: { code: failed ? 2 : 1 },
      attributes: [
        attr('langfuse.observation.type', kind), attr('langfuse.environment', 'poc'),
        attr('session.id', privateTrace ? traceId : session),
        attr('langfuse.observation.input', JSON.stringify(input ?? null)),
        attr('langfuse.observation.output', JSON.stringify(output ?? null)),
        ...(failed ? [attr('langfuse.observation.level', 'ERROR')] : []), ...extra,
      ],
    });
  };
  const redact = (value, secrets) => {
    let json = JSON.stringify(value ?? null);
    for (const secret of secrets) if (secret) json = json.replaceAll(JSON.stringify(secret).slice(1, -1), '[redacted]');
    return JSON.parse(json);
  };
  const visible = parts => typeof parts === 'string' ? parts.slice(0, 4000)
    : (Array.isArray(parts) ? parts : []).flatMap(p =>
      p.type === 'text' ? [{ type: p.type, text: p.text.slice(0, 4000) }]
        : p.type === 'toolCall' ? [{ type: p.type, id: p.id, name: p.name, arguments: p.arguments }] : []);
  return {
    model(scope) {
      return async (model, context, options) => {
        const started = stamp();
        const secrets = scope.secrets ?? [];
        const input = scope.private ? 'Authenticated private message'
          : redact({ system: context.systemPrompt, messages: (context.messages ?? []).slice(-12)
            .map(m => ({ role: m.role, content: visible(m.content) })) }, secrets);
        const record = result => {
          const usage = result?.usage;
          emit({ ...scope, kind: 'generation', started, input,
            output: scope.private ? result?.stopReason ?? 'error'
              : redact({ status: result?.stopReason ?? 'error', content: visible(result?.content) }, secrets),
            failed: !result || ['error', 'aborted'].includes(result.stopReason),
            extra: [attr('langfuse.observation.model.name', model.id),
              ...(scope.prompt ? [attr('langfuse.observation.prompt.name', scope.prompt.name),
                { key: 'langfuse.observation.prompt.version', value: { intValue: String(scope.prompt.version) } }] : []),
              ...(usage ? [attr('langfuse.observation.usage_details', JSON.stringify({
                input: usage.input, output: usage.output, total: usage.totalTokens, input_cached: usage.cacheRead,
              }))] : [])],
          });
        };
        let result;
        try { result = await stream(model, context, options); }
        catch (error) { record(); throw error; }
        const tracked = result.result().then(record, () => record());
        pending.add(tracked);
        void tracked.then(() => pending.delete(tracked), () => pending.delete(tracked));
        return result;
      };
    },
    tool(scope, event, started, args) {
      emit({ ...scope, name: event.toolName === 'simulation_command' ? 'Pi simulation · command' : event.toolName, kind: 'tool', started,
        input: redact({ id: event.toolCallId, args }, scope.secrets ?? []),
        output: redact({ id: event.toolCallId, content: visible(event.result?.content) }, scope.secrets ?? []),
        failed: !!event.isError });
    },
    async flush() { await Promise.all(pending); },
  };
}
