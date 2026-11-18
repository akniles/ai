const $ = (id) => document.getElementById(id);
let data = null,
  paused = false,
  toolsOnly = false,
  shown = 14,
  lastOk = 0,
  selectedMemory = null,
  memoryQuery = "",
  snapshot = "",
  traceData = null,
  selectedObservation = null,
  traceRequest = 0;
const expandedGoals = new Set();
let chatSnapshot = "",
  chatReady = false,
  chatBlocked = false,
  chatSending = false,
  pendingMessage = null;
const duration = (ms) => {
  const m = Math.max(0, Math.floor(ms / 60000));
  if (m < 1) return "less than a minute";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
};
const date = (t) =>
  new Date(t).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const latency = (ms) =>
  ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
const svg = (tag, attrs = {}) => {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs))
    node.setAttribute(key, value);
  return node;
};
const labels = { active: "Current", done: "Completed", abandoned: "Cancelled" };
function render() {
  if (!data) return;
  $("connection").textContent =
    Date.now() - lastOk > 15000
      ? "Reconnecting"
      : paused
        ? "Feed paused"
        : "Live";
  $("connection-dot").className =
    `dot ${Date.now() - lastOk < 15000 ? "live" : "stale"}`;
  const resting =
    !data.paused &&
    !data.thinking &&
    ["waiting", "backoff"].includes(data.schedule?.phase);
  $("state").textContent = data.paused
    ? "Stopped"
    : data.thinking
      ? "Thinking"
      : resting
        ? data.schedule.phase === "backoff"
          ? "Retrying"
          : "Resting"
        : "Active";
  $("model").textContent = data.model ?? "—";
  $("age").textContent = duration(Date.now() - new Date(data.born));
  $("wake-status").hidden = !resting;
  const wakeTime = resting
    ? new Date(data.schedule.nextWakeAt).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
  $("wake-status").textContent = resting
    ? data.schedule.phase === "backoff"
      ? `Retry at ${wakeTime}.`
      : `Next look: ${wakeTime}. New messages can wake it sooner.`
    : "";
  $("latest-note").textContent =
    data.latestNote ?? "Notes appear when the agent chooses to share.";
  if (data.linkedin) {
    try {
      const u = new URL(data.linkedin);
      if (
        u.protocol === "https:" &&
        ["www.linkedin.com", "linkedin.com"].includes(u.hostname)
      )
        for (const id of ["linkedin-top", "linkedin-footer"]) {
          $(id).href = u.href;
          $(id).hidden = false;
        }
    } catch {}
  }
  if (data.langfuse?.startsWith("https://")) {
    $("langfuse-link").href = data.langfuse + "/project/ai/traces";
    $("langfuse-link").hidden = false;
  }
  const next = JSON.stringify([
    data.events,
    data.goals,
    data.memories,
    data.observations,
    data.tracingAvailable,
  ]);
  if (next !== snapshot) {
    snapshot = next;
    renderFeed();
    renderGoals();
    renderMemory();
  }
}
function renderFeed() {
  const observations = (data.observations ?? [])
    .filter((o) => o.name.startsWith("tool.") || o.type === "GENERATION")
    .map((o) => ({
      ...o,
      time: o.start,
      category: o.name.startsWith("tool.") ? "tool" : "model",
    }));
  const notes = data.events.filter((e) => e.category === "note");
  const events = [...observations, ...(toolsOnly ? [] : notes)]
    .filter((e) => !toolsOnly || e.category === "tool")
    .sort((a, b) => new Date(b.time) - new Date(a.time));
  const timeline = $("timeline");
  timeline.replaceChildren();
  if (data.tracingAvailable === false)
    timeline.append(el("p", "detail-note", "Langfuse is reconnecting."));
  for (const event of events.slice(0, shown)) {
    const row = el("article", `event ${event.category}`),
      time = el(
        "time",
        "",
        new Date(event.time).toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }),
      );
    time.dateTime = event.time;
    time.title = date(event.time);
    const body = el("div", "event-body");
    if (event.category === "note") {
      body.append(
        el("span", "event-category", "Note"),
        el("p", "event-note", event.note),
      );
    } else {
      const button = el("button", "observation-link");
      button.append(
        el(
          "span",
          "event-category",
          event.category === "tool" ? "Tool" : "Model",
        ),
        el(
          "span",
          "observation-name",
          event.category === "model"
            ? (event.model ?? event.name)
            : event.name.replace(/^tool\./, ""),
        ),
        el(
          "span",
          "observation-latency",
          latency(Math.max(0, new Date(event.end) - new Date(event.start))),
        ),
        el("span", "trace-arrow", "↗"),
      );
      button.addEventListener("click", () =>
        openTrace(event.traceId, event.id),
      );
      body.append(button);
    }
    row.append(time, body);
    timeline.append(row);
  }
  if (!events.length)
    timeline.append(el("p", "empty", "Waiting for observations."));
  $("more").hidden = events.length <= shown;
}
async function openTrace(id, observation) {
  const ticket = ++traceRequest;
  selectedObservation = observation;
  traceData = null;
  $("trace-title").textContent = "Observation";
  $("trace-content").replaceChildren(el("p", "empty", "Loading trace…"));
  $("trace-native").hidden = true;
  if (!$("trace-dialog").open) $("trace-dialog").showModal();
  try {
    const r = await fetch(`/api/traces/${id}`);
    if (!r.ok) throw new Error();
    const result = await r.json();
    if (ticket !== traceRequest) return;
    traceData = result;
    renderTrace();
  } catch {
    if (ticket === traceRequest)
      $("trace-content").replaceChildren(
        el("p", "empty", "Trace unavailable. Try again shortly."),
      );
  }
}
function renderTrace() {
  const rows = traceData.observations.sort(
      (a, b) => new Date(a.start) - new Date(b.start),
    ),
    selected = rows.find((o) => o.id === selectedObservation) ?? rows[0];
  if (!selected) return;
  $("trace-title").textContent = selected.name.replace(/^tool\./, "");
  const content = $("trace-content");
  content.replaceChildren();
  const start = Math.min(...rows.map((o) => +new Date(o.start))),
    end = Math.max(...rows.map((o) => +new Date(o.end))),
    length = Math.max(1, end - start),
    waterfall = el("div", "waterfall");
  for (const row of rows) {
    const button = el(
      "button",
      `waterfall-row ${row.id === selected.id ? "selected" : ""}`,
    );
    button.setAttribute("aria-pressed", row.id === selected.id);
    button.append(el("span", "span-name", row.name.replace(/^tool\./, "")));
    const chart = svg("svg", {
      viewBox: "0 0 1000 18",
      preserveAspectRatio: "none",
      "aria-hidden": true,
    });
    chart.append(
      svg("rect", {
        x: Math.max(0, ((+new Date(row.start) - start) / length) * 980),
        y: 4,
        width: Math.max(
          3,
          ((+new Date(row.end) - new Date(row.start)) / length) * 980,
        ),
        height: 10,
        rx: 3,
        class: row.type === "GENERATION" ? "model-bar" : "tool-bar",
      }),
    );
    button.append(
      chart,
      el(
        "small",
        "",
        latency(Math.max(0, new Date(row.end) - new Date(row.start))),
      ),
    );
    button.addEventListener("click", () => {
      selectedObservation = row.id;
      renderTrace();
    });
    waterfall.append(button);
  }
  content.append(waterfall);
  if (selected.name.startsWith("tool.")) {
    content.replaceChildren();
    const input = selected.input ?? "Private",
      output = selected.output ?? selected.sharedResult?.output ?? "Private";
    content.append(
      el("h4", "", "Input"),
      el(
        "pre",
        "result-output",
        typeof input === "string" ? input : JSON.stringify(input, null, 2),
      ),
      el("h4", "", "Output"),
      el(
        "pre",
        "result-output",
        typeof output === "string" ? output : JSON.stringify(output, null, 2),
      ),
    );
    if (data.langfuse?.startsWith("https://")) {
      $("trace-native").href =
        `${data.langfuse}/project/ai/traces/${traceData.traceId}?observation=${selected.id}`;
      $("trace-native").hidden = false;
    }
    return;
  }
  const detail = el("div", "observation-detail");
  detail.append(
    el("h3", "", selected.name),
    el(
      "p",
      "detail-meta",
      `${date(selected.start)} · ${latency(Math.max(0, new Date(selected.end) - new Date(selected.start)))}`,
    ),
  );
  if (selected.usage?.total)
    detail.append(
      el(
        "p",
        "detail-meta",
        `${Number(selected.usage.input ?? 0).toLocaleString()} input · ${Number(selected.usage.output ?? 0).toLocaleString()} output tokens`,
      ),
    );
  for (const key of ["input", "output"])
    if (selected[key] !== undefined)
      detail.append(
        el("h4", "", key === "input" ? "Input" : "Output"),
        el("pre", "result-output", JSON.stringify(selected[key], null, 2)),
      );
  if (selected.sharedResult)
    detail.append(
      el("h4", "", "Shared result"),
      el("p", "", selected.sharedResult.summary),
      el("pre", "result-output", selected.sharedResult.output),
    );
  if (
    selected.input === undefined &&
    selected.output === undefined &&
    !selected.sharedResult
  )
    detail.append(el("p", "detail-note", "Input and output are private."));
  content.append(detail);
  if (data.langfuse?.startsWith("https://")) {
    $("trace-native").href =
      `${data.langfuse}/project/ai/traces/${traceData.traceId}?observation=${selected.id}`;
    $("trace-native").hidden = false;
  }
}
function renderGoals() {
  const openIds = new Set(
    [...document.querySelectorAll(".goal-card[open]")].map((e) => e.dataset.id),
  );
  for (const status of ["active", "done", "abandoned"]) {
    const goals = data.goals.filter((g) => g.status === status).slice(0, 10),
      list = $(`goals-${status}`);
    list.replaceChildren();
    $(`${status}-count`).textContent = String(goals.length);
    if (!goals.length)
      list.append(
        el(
          "p",
          "column-empty",
          status === "active"
            ? "No current goals."
            : status === "done"
              ? "No completed goals yet."
              : "No cancelled goals yet.",
        ),
      );
    for (const g of goals.slice(0, expandedGoals.has(status) ? 10 : 1)) {
      const card = el("details", "goal-card");
      card.dataset.id = g.id;
      card.open = openIds.has(g.id);
      const summary = el("summary");
      summary.append(el("span", "", g.text), el("small", "", date(g.updated)));
      card.append(summary);
      const history = el("ol", "goal-history");
      for (const h of g.history) {
        const item = el("li");
        item.append(
          el("time", "", date(h.time)),
          el("strong", "", labels[h.status] ?? h.status),
          el("p", "", h.text),
        );
        history.append(item);
      }
      card.append(history);
      list.append(card);
    }
    if (goals.length > 1) {
      const expanded = expandedGoals.has(status),
        button = el(
          "button",
          "goals-more",
          expanded ? "Show less" : `Show ${goals.length - 1} more`,
        );
      button.setAttribute("aria-expanded", expanded);
      button.setAttribute("aria-controls", `goals-${status}`);
      button.addEventListener("click", () => {
        expanded ? expandedGoals.delete(status) : expandedGoals.add(status);
        renderGoals();
      });
      list.append(button);
    }
  }
}
function renderMemory() {
  const items = data.memories.filter((m) =>
      m.text.toLowerCase().includes(memoryQuery.toLowerCase()),
    ),
    map = $("memory-map"),
    list = $("memory-list");
  map.replaceChildren();
  list.replaceChildren();
  if (!items.some((m) => m.id === selectedMemory))
    selectedMemory = items[0]?.id ?? null;
  const nodes = items.slice(0, 40).map((m, i) => {
    const angle = i * 2.399963,
      r =
        items.length === 1
          ? 0
          : Math.sqrt((i + 0.5) / Math.min(items.length, 40));
    return {
      ...m,
      x: 320 + Math.cos(angle) * 250 * r,
      y: 175 + Math.sin(angle) * 130 * r,
    };
  });
  const stop = new Set(
      "that this with from have under using should into only when does file files".split(
        " ",
      ),
    ),
    terms = (m) =>
      new Set(
        m.text
          .toLowerCase()
          .match(/[a-z0-9]{4,}/g)
          ?.filter((t) => !stop.has(t)) ?? [],
      );
  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++) {
      const a = terms(nodes[i]),
        b = terms(nodes[j]),
        shared = [...a].filter((t) => b.has(t));
      if (shared.length >= 2) {
        const line = svg("line", {
            x1: nodes[i].x,
            y1: nodes[i].y,
            x2: nodes[j].x,
            y2: nodes[j].y,
            class: "memory-edge",
          }),
          title = svg("title");
        title.textContent = `Shared words: ${shared.slice(0, 5).join(", ")}`;
        line.append(title);
        map.append(line);
      }
    }
  for (const m of nodes) {
    const group = svg("g", {
        class: `memory-node ${m.core ? "is-core" : ""} ${m.id === selectedMemory ? "selected" : ""}`,
        role: "button",
        tabindex: 0,
        "aria-label": m.text,
        "aria-pressed": m.id === selectedMemory,
      }),
      halo = svg("circle", { cx: m.x, cy: m.y, r: 17, class: "node-halo" }),
      dot = svg("circle", {
        cx: m.x,
        cy: m.y,
        r: m.core ? 7 : 5,
        class: "node-dot",
      }),
      label = svg("text", { x: m.x, y: m.y + 32, "text-anchor": "middle" });
    label.textContent = m.text.split(/\s+/).slice(0, 4).join(" ");
    const title = svg("title");
    title.textContent = m.text;
    group.append(halo, dot, label, title);
    const choose = () => {
      selectedMemory = m.id;
      renderMemory();
    };
    group.addEventListener("click", choose);
    group.addEventListener("keydown", (e) => {
      if (["Enter", " "].includes(e.key)) {
        e.preventDefault();
        choose();
      }
    });
    map.append(group);
  }
  if (!nodes.length) {
    const note = svg("text", {
      x: 320,
      y: 180,
      "text-anchor": "middle",
      class: "map-empty",
    });
    note.textContent = memoryQuery
      ? "No matching memories."
      : "No shared memories yet.";
    map.append(note);
  }
  for (const m of items) {
    const button = el(
      "button",
      `memory-chip ${m.id === selectedMemory ? "selected" : ""}`,
      m.text,
    );
    button.setAttribute("aria-pressed", m.id === selectedMemory);
    button.addEventListener("click", () => {
      selectedMemory = m.id;
      renderMemory();
    });
    list.append(button);
  }
  const m = items.find((m) => m.id === selectedMemory),
    detail = $("memory-detail");
  detail.replaceChildren();
  if (m)
    detail.append(
      el("p", "detail-meta", m.core ? "Core memory" : "Stored memory"),
      el("p", "memory-fact", m.text),
      el("p", "detail-meta", `${m.kind} · ${date(m.time)}`),
    );
  else detail.append(el("p", "empty", "No memory selected."));
}
async function refresh() {
  if (paused) return;
  try {
    const r = await fetch("/api/live", { cache: "no-store" });
    if (!r.ok) throw new Error();
    data = await r.json();
    lastOk = Date.now();
    render();
  } catch {
    $("connection").textContent = "Reconnecting";
    $("connection-dot").className = "dot stale";
  }
}
async function refreshChat() {
  try {
    const r = await fetch("/api/chat", { cache: "no-store" });
    if (!r.ok) throw new Error("Chat reconnecting…");
    const chat = await r.json();
    chatReady = true;
    chatBlocked = chat.blocked;
    const next = JSON.stringify(chat);
    if (next !== chatSnapshot) {
      chatSnapshot = next;
      const box = $("chat-messages"),
        atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
      box.replaceChildren();
      if (!chat.messages.length)
        box.append(el("p", "empty", "Start a conversation."));
      for (const message of chat.messages) {
        const bubble = el(
          "article",
          `chat-message ${message.direction === "out" ? "from-agent" : "from-you"}`,
        );
        bubble.append(
          el("p", "chat-author", message.direction === "out" ? "ai" : "You"),
          el("p", "chat-body", message.body),
          el(
            "p",
            "chat-time",
            `${date(message.time)}${message.direction === "in" ? (message.read ? " · Read" : " · Delivered") : ""}`,
          ),
        );
        box.append(bubble);
      }
      if (atBottom || chatSending) box.scrollTop = box.scrollHeight;
    }
    if (!chatSending)
      $("chat-status").textContent = chat.blocked
        ? "The agent has blocked this chat."
        : chat.muted
          ? "The agent has muted this chat."
          : data?.paused
            ? "Agent stopped. Messages are saved for later."
            : "Delivered messages are available to the agent.";
  } catch (error) {
    if (!chatSending) $("chat-status").textContent = error.message;
  }
  $("chat-send").disabled = !chatReady || chatBlocked || chatSending;
}
$("chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = $("chat-input").value.trim();
  if (!body || !chatReady || chatBlocked || chatSending) return;
  if (!pendingMessage || pendingMessage.body !== body)
    pendingMessage = { id: crypto.randomUUID(), body };
  chatSending = true;
  $("chat-send").disabled = true;
  $("chat-status").textContent = "Sending…";
  try {
    const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(pendingMessage),
      }),
      result = await r.json();
    if (!r.ok)
      throw new Error(
        result.reason === "blocked"
          ? "The agent has blocked this chat."
          : (result.error ?? "Could not send. Please retry."),
      );
    $("chat-input").value = "";
    pendingMessage = null;
    await refreshChat();
    $("chat-status").textContent =
      "Delivered. The agent decides what happens next.";
  } catch (error) {
    $("chat-status").textContent = error.message;
  } finally {
    chatSending = false;
    $("chat-send").disabled = !chatReady || chatBlocked;
  }
});
$("pause").addEventListener("click", () => {
  paused = !paused;
  $("pause").textContent = paused ? "Resume feed" : "Pause feed";
  $("pause").setAttribute("aria-pressed", paused);
  render();
  if (!paused) refresh();
});
$("filter").addEventListener("click", () => {
  toolsOnly = !toolsOnly;
  $("filter").setAttribute("aria-pressed", toolsOnly);
  shown = 14;
  if (data) renderFeed();
});
$("more").addEventListener("click", () => {
  shown += 14;
  renderFeed();
});
$("memory-search").addEventListener("input", (e) => {
  memoryQuery = e.target.value;
  if (data) renderMemory();
});
$("close-trace").addEventListener("click", () => {
  $("trace-dialog").close();
  traceRequest++;
});
refresh();
setInterval(refresh, 5000);
refreshChat();
setInterval(() => {
  if (!document.hidden && !chatSending) refreshChat();
}, 5000);
