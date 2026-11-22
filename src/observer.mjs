// A read-only observer. There are no timers, imports, tool calls, or ambient I/O.
// Contract: append strictly increasing integer source cursors, including ignored events.
// The producer must retry full events in order rather than dropping them; persist/replay
// source events externally if you need recovery across process restarts. The publisher
// must commit idempotently by card.id; use a distinct stable streamId per source stream.
export function createObserver({
  model, streamId = "public-tool-events", windowMs = 5_000, maxEvents = 128,
  initialCursor = -1, now = Date.now,
} = {}) {
  if (typeof model !== "function" || typeof now !== "function") throw new TypeError("callbacks");
  if (!/^[\w.-]{1,80}$/.test(streamId)) throw new TypeError("streamId");
  if (![windowMs, maxEvents].every(n => Number.isSafeInteger(n) && n > 0))
    throw new RangeError("windowMs and maxEvents must be positive safe integers");
  if (!Number.isSafeInteger(initialCursor) || initialCursor < -1) throw new RangeError("initialCursor");
  let seen = initialCursor;
  let committed = initialCursor;
  let queue = [];
  let pending = null;
  let busy = false;

  function append({ id, source, name, status, summary = "" } = {}) {
    if (!Number.isSafeInteger(id) || id < 0) throw new TypeError("id must be a nonnegative cursor");
    if (id <= seen) return "duplicate";
    if (source === "observer") {
      seen = id;
      return "ignored";
    }
    // Only consume output from a trusted upstream sanitization boundary.
    if (source !== "public-tool" || typeof name !== "string" ||
        !/^[\w.-]{1,64}$/.test(name) || !["ok", "error", "cancelled"].includes(status) ||
        typeof summary !== "string" || summary.length > 240 || /[\u0000-\u001f\u007f]/u.test(summary)) {
      throw new TypeError("expected a sanitized public completion");
    }
    if (queue.length + (pending?.events.length ?? 0) >= maxEvents) return "full";
    queue.push(Object.freeze({ id, name, status, summary, time: now() }));
    seen = id;
    return "accepted";
  }

  async function flush({ publish, force = false } = {}) {
    if (typeof publish !== "function") throw new TypeError("publish callback required");
    if (busy) return "busy";
    if (!pending) {
      if (!queue.length) return "idle";
      const cutoff = queue[0].time + windowMs;
      if (!force && now() < cutoff && queue.length < maxEvents) return "idle";
      const next = queue.findIndex(event => event.time >= cutoff);
      const batch = queue.splice(0, next > 0 ? next : queue.length);
      const events = Object.freeze(batch.map(({ id, name, status, summary }) =>
        Object.freeze({ id, name, status, summary })));
      pending = { events, card: null };
    }
    busy = true;
    try {
      const { events } = pending;
      if (!pending.card) {
        const note = await model(Object.freeze({
          events,
        }));
        if (typeof note !== "string" || !note.trim() || note.trim().length > 280 ||
            /[\u0000-\u001f\u007f<>]/u.test(note.trim())) throw new TypeError("invalid narration");
        pending.card = Object.freeze({
          id: `${streamId}:${events[0].id}-${events.at(-1).id}`,
          text: note.trim(),
          evidence: Object.freeze(events.map(({ id, name, status }) => Object.freeze({ id, name, status }))),
        });
      }
      await publish(pending.card);
      committed = events.at(-1).id;
      pending = null;
      return "published";
    } finally {
      busy = false;
    }
  }

  return Object.freeze({ append, flush, get committedCursor() { return committed; } });
}

