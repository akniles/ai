import { randomBytes } from 'node:crypto';
const hex = n => randomBytes(n).toString('hex');
export class Telemetry {
  constructor({ url, publicKey, secretKey, store }) { Object.assign(this, { url, publicKey, secretKey, store }); this.pending = new Set(); }
  record(name, input, output, start = Date.now(), metadata = {}) {
    if (!this.url || !this.publicKey || !this.secretKey || this.pending.size >= 50) return;
    const traceId = /^[a-f0-9]{32}$/.test(metadata.traceId) ? metadata.traceId : hex(16), spanId = hex(8);
    const usage=metadata.usage;
    const attributes={ 'langfuse.trace.name': metadata.traceId ? 'autonomous-cycle' : name,
      'langfuse.observation.type': name.startsWith('llm') ? 'generation' : name.startsWith('tool.') ? 'tool' : 'span',
      'langfuse.observation.input': JSON.stringify(input), 'langfuse.observation.output': JSON.stringify(output),
      'langfuse.observation.model.name': metadata.model ?? '', 'langfuse.session.id': 'autonomous',
      'langfuse.version': '0.1.0', 'langfuse.environment': 'experiment',
      ...Object.fromEntries(Object.entries(metadata).filter(([k])=>k!=='usage').map(([k,v])=>[`langfuse.observation.metadata.${k}`,JSON.stringify(v)])),
      ...(usage ? { 'langfuse.observation.usage_details': JSON.stringify({input:usage.prompt_tokens,output:usage.completion_tokens,total:usage.total_tokens}),
        ...(typeof usage.cost==='number' ? {'langfuse.observation.cost_details':JSON.stringify({total:usage.cost})} : {}) } : {}) };
    const body = { resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'ai' } }] }, scopeSpans: [{ scope: { name: 'ai-runtime' }, spans: [{
      traceId, spanId, name, kind: 1, startTimeUnixNano: String(BigInt(start) * 1000000n), endTimeUnixNano: String(BigInt(Date.now()) * 1000000n),
      attributes: Object.entries(attributes).map(([key,value]) => ({ key, value: { stringValue: String(value) } }))
    }] }] }] };
    const p = fetch(`${this.url}/api/public/otel/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${this.publicKey}:${this.secretKey}`).toString('base64')}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); })
      .catch(e => this.store.event('telemetry.error', { message: e.message })).finally(() => this.pending.delete(p));
    this.pending.add(p);
  }
}
