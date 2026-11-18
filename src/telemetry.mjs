import { randomBytes } from 'node:crypto';
const hex = n => randomBytes(n).toString('hex');
export class Telemetry {
  constructor({ url, publicKey, secretKey, store }) { Object.assign(this, { url, publicKey, secretKey, store }); this.pending = new Set(); }
  record(name, input, output, start = Date.now(), metadata = {}) {
    if (!this.url || !this.publicKey || !this.secretKey || this.pending.size >= 50) return;
    const traceId = hex(16), spanId = hex(8);
    const body = { resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'ai' } }] }, scopeSpans: [{ scope: { name: 'ai-runtime' }, spans: [{
      traceId, spanId, name, kind: 1, startTimeUnixNano: String(BigInt(start) * 1000000n), endTimeUnixNano: String(BigInt(Date.now()) * 1000000n),
      attributes: Object.entries({ 'langfuse.trace.name': name, 'langfuse.observation.type': name === 'llm' ? 'generation' : 'span', 'langfuse.observation.input': JSON.stringify(input), 'langfuse.observation.output': JSON.stringify(output), 'langfuse.observation.metadata': JSON.stringify(metadata), 'langfuse.observation.model.name': metadata.model ?? '', 'langfuse.trace.session_id': 'autonomous' }).map(([key,value]) => ({ key, value: { stringValue: String(value) } }))
    }] }] }] };
    const p = fetch(`${this.url}/api/public/otel/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${this.publicKey}:${this.secretKey}`).toString('base64')}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); })
      .catch(e => this.store.event('telemetry.error', { message: e.message })).finally(() => this.pending.delete(p));
    this.pending.add(p);
  }
}
