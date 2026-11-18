export class Memory {
  constructor(store, url, telemetry) { Object.assign(this, { store, url, telemetry }); this.syncing = false; }
  async call(path, body) {
    const start = Date.now();
    const r = await fetch(`${this.url}/v1/default/banks/ai/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error(`Hindsight HTTP ${r.status}`);
    const result = await r.json(); this.telemetry?.record(`memory.${path}`, body, result, start); return result;
  }
  async search(query) {
    const local = this.store.search(query);
    if (!this.url) return { backend: 'sqlite-fts-fallback', results: local };
    try { return { backend: 'hindsight', ...(await this.call('memories/recall', { query, budget: 'low', max_tokens: 2000 })), originals: local }; }
    catch (e) { this.store.event('memory.degraded', { message: e.message }); return { backend: 'sqlite-fts-fallback', results: local, error: e.message }; }
  }
  async sync() {
    if (!this.url || this.syncing || this.store.get('panic')) return;
    this.syncing = true;
    try {
      const r = this.store.db.prepare('SELECT * FROM memories WHERE synced=0 ORDER BY time LIMIT 1').get();
      if (!r) return;
      // Stable document_id makes retries idempotent in the remote store.
      await this.call('memories', { items: [{ content: r.text, context: `${r.kind}; source=${r.source}`, timestamp: r.time, document_id: r.id }], async: false });
      this.store.db.prepare('UPDATE memories SET synced=1 WHERE id=?').run(r.id);
      this.store.event('memory.synced', { id: r.id });
    } catch (e) { this.store.event('memory.sync_failed', { message: e.message }); }
    finally { this.syncing = false; }
  }
}
