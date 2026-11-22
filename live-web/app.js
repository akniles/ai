import { $, clock } from "./ui.js";
import { renderActivity } from "./activity.js";
import { startChat } from "./chat.js";
import { openTrace as showTrace, restoreTrace } from "./trace.js";

function setupMemoryAtlas() {
  const content = $("memory-content");
  const make = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    return node;
  };
  let selectedId;
  let snapshot;

  return function updateMemories(records) {
    const memories = [...new Map((Array.isArray(records) ? records : [])
      .filter(item => item && typeof item.id === 'string' && typeof item.text === 'string')
      .map(({ id, text, title, kind, core, time }) => [id, {
        id, text, title: typeof title === 'string' ? title : '',
        kind: typeof kind === 'string' ? kind : '', core: core === true,
        time: typeof time === 'string' ? time : ''
      }])).values()].slice(0, 120);
    const next = JSON.stringify(memories);
    if (next === snapshot) return;
    snapshot = next;
    const focusedId = content.contains(document.activeElement) ? document.activeElement.dataset.memoryId : undefined;
    content.replaceChildren();
    if (!memories.length) {
      content.append(make('p', 'memory-empty', 'No public memories yet.'));
      return;
    }

    const label = item => (item.title.trim() || item.text.trim() || 'Memory').slice(0, 90);
    const graph = make('ul', 'memory-graph');
    graph.setAttribute('aria-label', 'Published memories grouped by category');
    const detail = make('section', 'memory-detail');
    detail.setAttribute('aria-live', 'polite');
    const groups = new Map();
    const buttons = new Map();

    function select(item) {
      selectedId = item.id;
      for (const [id, button] of buttons) button.setAttribute('aria-pressed', String(id === selectedId));
      detail.replaceChildren(make('h3', null, label(item)), make('p', null, item.text || 'No text published.'));
      const date = new Date(item.time);
      const meta = [item.kind, !Number.isNaN(date.getTime()) ? date.toLocaleString() : ''].filter(Boolean);
      if (meta.length) detail.append(make('p', 'memory-meta', meta.join(' · ')));
    }

    for (const item of memories) {
      const kind = item.core ? 'Core' : (item.kind.trim() || 'Uncategorized');
      if (!groups.has(kind)) {
        const branch = make('li', 'memory-branch');
        const leaves = make('ul', 'memory-leaves');
        branch.append(make('span', 'memory-category', kind), leaves);
        graph.append(branch);
        groups.set(kind, leaves);
      }
      const leaf = make('li', 'memory-leaf');
      const button = make('button', 'memory-node', label(item));
      button.type = 'button';
      button.dataset.memoryId = item.id;
      button.addEventListener('click', () => select(item));
      buttons.set(item.id, button);
      leaf.append(button);
      groups.get(kind).append(leaf);
    }
    content.append(graph, detail);
    select(memories.find(item => item.id === selectedId) ?? memories[0]);
    buttons.get(focusedId)?.focus({ preventScroll: true });
  };
}

const updateStreamAtlas = setupMemoryAtlas();

let data = null;
let shown = 3;
let feedSnapshot = "";
const observations = new Map();
let nextCursor;

function renderStatus() {
  $("activity-status").hidden = true;
  if (data.langfuse?.startsWith("https://")) {
    $("langfuse-link").href = data.langfuse + "/project/ai/traces";
    $("langfuse-link").hidden = false;
  }
}

function renderFeed() {
  renderActivity(data, { shown, openTrace });
}

function openTrace(observation, wholeTrace = false) {
  return showTrace(observation, wholeTrace);
}

async function refresh() {
  if (document.hidden) return;
  try {
    const response = await fetch("/api/live", { cache: "no-store" });
    if (!response.ok) throw new Error();
    data = await response.json();
    for (const o of data.observations) observations.set(o.id, o);
    if (nextCursor === undefined && data.tracingAvailable)
      nextCursor = data.nextCursor;
    data.nextCursor = nextCursor;
    data.observations = [...observations.values()];
    $("connection-error").hidden = true;
    renderStatus();
    const nextFeed = JSON.stringify([
      data.events,
      data.observations,
      data.tracingAvailable,
    ]);
    if (nextFeed !== feedSnapshot && !$("trace-dialog").open) {
      feedSnapshot = nextFeed;
      renderFeed();
    }
    updateStreamAtlas(data.memories);
  } catch {
    $("connection-error").textContent = data
      ? "Updates are unavailable. Showing information received at " +
        clock(data.now) +
        ". Retrying…"
      : "Could not load activity. Retrying…";
    $("connection-error").hidden = false;
    $("activity-status").hidden = true;
  }
}
$("more").addEventListener("click", async () => {
  const button = $("more");
  button.disabled = true;
  try {
    if (nextCursor) {
      const response = await fetch(
        "/api/live?cursor=" + encodeURIComponent(nextCursor),
      );
      if (!response.ok) throw new Error();
      const page = await response.json();
      if (!page.tracingAvailable) throw new Error();
      for (const o of page.observations) observations.set(o.id, o);
      nextCursor = page.nextCursor;
      data.nextCursor = nextCursor;
      data.observations = [...observations.values()];
    }
    shown += 5;
    renderFeed();
    button.textContent = "Show more history";
  } catch {
    button.textContent = "Could not load history. Retry";
  } finally {
    button.disabled = false;
  }
});
function setupDemoControls() {
  const panel = $("demo-controls");
  const start = $("demo-start");
  const stop = $("demo-stop");
  const status = $("demo-status");
  const connect = $("owner-connect");
  const setup = $("owner-pair-note");
  let busy = false;
  let mode = "demo";
  let known = false;
  let running = false;
  let pairingAvailable = false;
  let code = "";
  let expiresAt = 0;
  let hint = "";

  function updateButtons() {
    if (code && Date.now() >= expiresAt) code = "";
    const owner = mode === "owner";
    panel.setAttribute("aria-label", owner ? "Live agent controls" : "Demo controls");
    start.textContent = owner ? "Start live" : "Start demo";
    stop.textContent = owner ? "Stop live" : "Stop demo";
    start.disabled = busy || !known || running;
    stop.disabled = busy || !known || !running;
    connect.hidden = owner || !pairingAvailable;
    connect.disabled = busy;
    connect.textContent = code ? "Finish pairing" : "Connect owner";
    setup.textContent = code
      ? "Send this code to Dora: " + code + ". Then select Finish pairing." + (hint ? " " + hint : "")
      : hint;
    setup.hidden = !setup.textContent;
  }

  async function json(path, post = false, credentials = "same-origin") {
    const response = await fetch(path, {
      method: post ? "POST" : "GET",
      ...(post ? { headers: { "content-type": "application/json" }, body: "{}" } : {}),
      cache: "no-store",
      credentials,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const error = new Error("Control request failed");
      error.http = response.status;
      throw error;
    }
    return response.json();
  }

  async function readStatus() {
    let ownerState;
    try {
      ownerState = await json("/api/pair/status");
      if (typeof ownerState?.owner !== "boolean") throw new Error("Invalid owner status");
    } catch (error) {
      if (mode === "owner" || (error.http !== 403 && error.http !== 404)) throw error;
    }
    pairingAvailable = Boolean(ownerState);
    if (ownerState?.owner) {
      mode = "owner";
      code = hint = "";
      known = typeof ownerState.running === "boolean";
      running = ownerState.running === true;
      status.textContent = known ? "" : "Checking live agent…";
      return;
    }
    mode = "demo";
    const demo = await json("/api/demo/status", false, "omit");
    known = typeof demo.paused === "boolean";
    running = demo.paused === false;
    status.textContent = known ? "" : "Demo controls unavailable.";
  }

  async function getStatus() {
    if (busy || document.hidden) return;
    busy = true;
    try { await readStatus(); }
    catch { known = false; status.textContent = "Controls unavailable. Retrying…"; }
    finally { busy = false; updateButtons(); }
  }

  async function change(action) {
    if (busy || !known || (action === "start" ? running : !running)) return;
    busy = true;
    updateButtons();
    status.textContent = action === "start" ? "Starting…" : "Stopping…";
    try {
      const owner = mode === "owner";
      await json((owner ? "/api/pair/" : "/api/demo/") + action, true, owner ? "same-origin" : "omit");
      await readStatus();
      void refresh();
    } catch {
      known = false;
      status.textContent = "Could not confirm the action. Checking status…";
    } finally { busy = false; updateButtons(); }
  }

  async function pair() {
    if (busy || mode === "owner" || !pairingAvailable) return;
    busy = true;
    hint = "";
    updateButtons();
    try {
      if (code) {
        const claimed = await json("/api/pair/claim", true);
        if (claimed?.owner !== true) throw new Error("Pairing not approved");
        code = "";
        mode = "owner";
        known = false;
        await readStatus();
      } else {
        const challenge = await json("/api/pair/create", true);
        if (typeof challenge?.code !== "string" || !/^[a-z0-9-]{4,80}$/i.test(challenge.code) ||
            !Number.isFinite(challenge.expiresIn) || challenge.expiresIn <= 0)
          throw new Error("Invalid pairing challenge");
        code = challenge.code;
        expiresAt = Date.now() + Math.min(challenge.expiresIn, 300) * 1000;
      }
    } catch {
      hint = code ? "Not paired yet. Try Finish pairing after Dora approves the code." : "Could not connect. Try again.";
    } finally { busy = false; updateButtons(); }
  }

  start.addEventListener("click", () => void change("start"));
  stop.addEventListener("click", () => void change("stop"));
  connect.addEventListener("click", () => void pair());
  updateButtons();
  void getStatus();
  setInterval(getStatus, 5000);
}

refresh();
setInterval(refresh, 5000);
startChat();
setupDemoControls();
void restoreTrace(location.search);
