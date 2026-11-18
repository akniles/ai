import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, id TEXT UNIQUE, time TEXT, kind TEXT, data TEXT);
      CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, blocked INTEGER DEFAULT 0, muted INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, chat TEXT, sender TEXT, body TEXT, time TEXT, read INTEGER DEFAULT 0, direction TEXT);
      CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat, time);
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, text TEXT, source TEXT, time TEXT, kind TEXT, core INTEGER DEFAULT 0, synced INTEGER DEFAULT 0);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED, text);
      CREATE TABLE IF NOT EXISTS goals (id TEXT PRIMARY KEY, text TEXT, status TEXT, updated TEXT);
      CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, time TEXT, reserved REAL, cost REAL, status TEXT, usage TEXT);
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, time TEXT, status TEXT, data TEXT);
      CREATE TABLE IF NOT EXISTS decisions (fact TEXT PRIMARY KEY, save INTEGER, reason TEXT, time TEXT);
    `);
    if (this.get('panic') === undefined) this.set('panic', true);
    if (!this.get('born')) this.set('born', new Date().toISOString());
    // A crashed request may still have been billed. Keep its whole reservation.
    this.db.prepare("UPDATE calls SET status='unknown' WHERE status='inflight'").run();
    this.db.prepare("UPDATE operations SET status='interrupted' WHERE status='running'").run();
  }
  close() { this.db.close(); }
  get(key) { const r = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key); return r ? JSON.parse(r.value) : undefined; }
  set(key, value) { this.db.prepare('INSERT OR REPLACE INTO kv VALUES (?,?)').run(key, JSON.stringify(value)); }
  event(kind, data = {}) {
    const id = randomUUID(), time = new Date().toISOString();
    this.db.prepare('INSERT INTO events(id,time,kind,data) VALUES (?,?,?,?)').run(id, time, kind, JSON.stringify(data));
    return id;
  }
  events(limit = 100) { return this.db.prepare('SELECT * FROM events ORDER BY seq DESC LIMIT ?').all(limit).map(r => ({ ...r, data: JSON.parse(r.data) })); }
  receive({ id = randomUUID(), chat, sender, body }) {
    this.db.prepare('INSERT OR IGNORE INTO chats(id) VALUES (?)').run(chat);
    const c = this.db.prepare('SELECT * FROM chats WHERE id=?').get(chat);
    if (c.blocked) return { accepted: false, reason: 'blocked' };
    const r = this.db.prepare("INSERT OR IGNORE INTO messages(id,chat,sender,body,time,direction) VALUES (?,?,?,?,?,'in')").run(id, chat, sender, body, new Date().toISOString());
    if (r.changes) this.event('inbox.received', { id, chat, sender });
    return { accepted: true, id, duplicate: !r.changes };
  }
  notifications() {
    return this.db.prepare(`SELECT m.id,m.chat,m.sender,m.time FROM messages m JOIN chats c ON c.id=m.chat
      WHERE m.direction='in' AND m.read=0 AND c.blocked=0 AND c.muted=0 ORDER BY m.time LIMIT 30`).all();
  }
  readMessage(id) {
    const r = this.db.prepare("SELECT * FROM messages WHERE id=? AND direction='in'").get(id);
    if (!r) throw new Error('Message not found');
    this.db.prepare('UPDATE messages SET read=1 WHERE id=?').run(id);
    this.event('inbox.read', { id }); return r;
  }
  reply(chat, body) {
    const id = randomUUID();
    this.db.prepare("INSERT INTO messages(id,chat,sender,body,time,direction) VALUES (?,?,'agent',?,?,'out')").run(id, chat, body, new Date().toISOString());
    this.event('inbox.reply', { id, chat }); return { id, chat, body };
  }
  chat(chat, blocked, muted) {
    this.db.prepare('INSERT OR IGNORE INTO chats(id) VALUES (?)').run(chat);
    this.db.prepare('UPDATE chats SET blocked=COALESCE(?,blocked),muted=COALESCE(?,muted) WHERE id=?').run(blocked === undefined ? null : Number(blocked), muted === undefined ? null : Number(muted), chat);
    this.event('inbox.chat_changed', { chat, blocked, muted }); return { ok: true };
  }
  decide(fact, save, reason) {
    this.db.prepare('INSERT OR REPLACE INTO decisions VALUES (?,?,?,?)').run(fact, Number(save), reason, new Date().toISOString());
    this.event('memory.decision', { fact, save, reason });
  }
  remember(text, source = 'agent', kind = 'observation', core = false) {
    const id = randomUUID(), time = new Date().toISOString();
    if (core && this.db.prepare('SELECT COUNT(*) n FROM memories WHERE core=1').get().n >= 12) throw new Error('Core memory full; demote an existing entry first');
    this.db.prepare('INSERT INTO memories(id,text,source,time,kind,core) VALUES (?,?,?,?,?,?)').run(id, text, source, time, kind, Number(core));
    this.db.prepare('INSERT INTO memory_fts VALUES (?,?)').run(id, text);
    this.event('memory.saved', { id, kind, core }); return { id };
  }
  core() { return this.db.prepare('SELECT id,text,source,time,kind FROM memories WHERE core=1 ORDER BY time DESC LIMIT 12').all(); }
  search(query) {
    const words = query.match(/[\p{L}\p{N}]+/gu)?.slice(0, 12) ?? [];
    if (!words.length) return [];
    return this.db.prepare('SELECT m.* FROM memory_fts f JOIN memories m ON m.id=f.id WHERE memory_fts MATCH ? ORDER BY rank LIMIT 15').all(words.map(w => `"${w}"`).join(' OR '));
  }
  goals() { return this.db.prepare("SELECT * FROM goals WHERE status='active' ORDER BY updated DESC LIMIT 20").all(); }
  goal(text, status = 'active', id = randomUUID()) {
    this.db.prepare('INSERT OR REPLACE INTO goals VALUES (?,?,?,?)').run(id, text, status, new Date().toISOString());
    this.event('goal.changed', { id, text, status }); return { id };
  }
  committed() { return this.db.prepare('SELECT COALESCE(SUM(COALESCE(cost,reserved)),0) value FROM calls').get().value; }
  reserve(id, amount, cap) {
    if (!Number.isFinite(cap) || cap < 0 || !Number.isFinite(amount) || amount < 0 || this.committed() + amount > cap) throw new Error('Budget exhausted or unknown');
    this.db.prepare("INSERT INTO calls VALUES (?,?,?,NULL,'inflight',NULL)").run(id, new Date().toISOString(), amount);
  }
  settle(id, cost, usage) {
    const c = Number.isFinite(cost) && cost >= 0 ? cost : null;
    this.db.prepare("UPDATE calls SET cost=?,status=?,usage=? WHERE id=?").run(c, c === null ? 'unknown' : 'complete', JSON.stringify(usage ?? {}), id);
  }
  context() {
    const now = new Date(), last = this.get('last_cycle');
    return { time: { now: now.toISOString(), timezone: this.get('timezone') ?? 'UTC', born: this.get('born'), elapsedSinceLastCycleSeconds: last ? (now - new Date(last)) / 1000 : null },
      state: this.get('working_state') ?? {}, goals: this.goals(), coreMemory: this.core(), notifications: this.notifications(), recentEvents: this.events(10).map(({ kind,time,id }) => ({ kind,time,id })) };
  }
}
