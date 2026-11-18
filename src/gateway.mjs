import { randomUUID } from 'node:crypto';
export class Gateway {
  constructor({ store, telemetry, baseUrl, key, model, inputPrice, outputPrice, requestPrice = 0, cap = 10, fetchImpl = fetch, enabled = true }) {
    Object.assign(this, { store, telemetry, baseUrl, key, model, inputPrice, outputPrice, requestPrice, cap, fetchImpl, enabled }); this.active = new Set();
  }
  abort() { for (const c of this.active) c.abort(new Error('Owner panic')); }
  async complete(body) {
    if (!this.enabled) throw new Error('Inference backend disabled');
    if (this.store.get('panic')) throw new Error('Runtime stopped');
    if (!this.key || !this.baseUrl || !this.model) throw new Error('Model not configured');
    if (![this.inputPrice,this.outputPrice,this.requestPrice].every(x => Number.isFinite(x) && x >= 0)) throw new Error('Verified pricing required');
    // Text-only allowlist: no plugins, images, routed models or unconstrained output.
    const maxTokens = Math.min(Math.max(Number(body.max_tokens ?? body.max_completion_tokens ?? 2048), 1), 4096);
    if (!Number.isFinite(maxTokens) || !Array.isArray(body.messages)) throw new Error('Invalid request');
    if (body.messages.some(m => m.content != null && typeof m.content !== 'string')) throw new Error('Only text content is budgeted');
    if (body.messages.length > 100 || Buffer.byteLength(JSON.stringify(body)) > 180000) throw new Error('Context too large');
    const request = { model: this.model, messages: body.messages, max_tokens: Math.floor(maxTokens), temperature: 0.5, stream: false };
    if (new URL(this.baseUrl).hostname === 'openrouter.ai') request.provider = { require_parameters: true, max_price: { prompt: this.inputPrice*1000000, completion: this.outputPrice*1000000 } };
    if (body.tools) request.tools = body.tools;
    if (body.response_format) request.response_format = body.response_format;
    // Byte count plus protocol margin bounds text tokens conservatively. Reserve before await.
    const inputBound = Buffer.byteLength(JSON.stringify(request)) + 4096;
    const reserved = inputBound * this.inputPrice + maxTokens * this.outputPrice + this.requestPrice;
    const id = randomUUID(), start = Date.now();
    this.store.reserve(id, reserved, this.cap);
    const c = new AbortController(); this.active.add(c);
    const signal = AbortSignal.any([c.signal, AbortSignal.timeout(180000)]);
    try {
      const r = await this.fetchImpl(`${this.baseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${this.key}`, 'content-type': 'application/json' }, body: JSON.stringify(request), signal });
      if (!r.ok) throw new Error(`Model HTTP ${r.status}`);
      const result = await r.json();
      if (result.error || !result.choices?.length) throw new Error('Model returned no completion');
      const actual = typeof result.usage?.cost === 'number' ? result.usage.cost : null;
      // Unknown cost retains the reservation. Token counts alone do not prove provider fees.
      this.store.settle(id, actual, result.usage);
      if (actual !== null && actual > reserved) {
        this.store.set('panic', true); this.abort();
        this.store.event('budget.price_violation', { id, reserved, actual });
      }
      this.store.event('llm.completed', { id, model: this.model, usage: result.usage, reserved });
      this.telemetry?.record('llm', request, result, start, { ...body._context, callId: id, model: this.model, usage: result.usage });
      return result;
    } catch (e) {
      this.store.settle(id, null, { error: e.message });
      this.store.event('llm.failed', { id, message: e.message });
      this.telemetry?.record('llm.error', request, { error: e.message }, start, { ...body._context, callId: id }); throw e;
    } finally { this.active.delete(c); }
  }
}
