import { $ } from "./ui.js";
import { activityItems, renderActivity } from "./activity.js";
import { setupSteering } from "./chat.js";
import { restoreTrace } from "./trace.js";

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
let cutoffMs = null;
const marker = page => Date.parse(page.clearedAt) || 0;

function renderFeed() {
  const items = activityItems(data);
  const snapshot = JSON.stringify([items, shown, nextCursor]);
  if (snapshot !== feedSnapshot) {
    feedSnapshot = snapshot;
    renderActivity(items, shown, nextCursor);
  }
}

async function refresh() {
  if (document.hidden) return;
  try {
    const response = await fetch("/api/live", { cache: "no-store" });
    if (!response.ok) throw new Error();
    const page = await response.json();
    const nextCutoff = marker(page);
    if (cutoffMs !== null && nextCutoff < cutoffMs) return;
    if (cutoffMs !== null && nextCutoff > cutoffMs) {
      observations.clear();
      nextCursor = undefined;
      shown = 3;
      const dialog = document.querySelector('#trace-dialog[open]');
      if (dialog) dialog.close();
    }
    cutoffMs = nextCutoff;
    data = page;
    for (const o of data.observations ?? []) observations.set(o.id, o);
    if (nextCursor === undefined && data.tracingAvailable)
      nextCursor = data.nextCursor;
    data.observations = [...observations.values()];
    $("connection-error").hidden = true;
    renderFeed();
    updateStreamAtlas(data.memories);
  } catch {
    $("connection-error").textContent = "Could not refresh the feed. Retrying…";
    $("connection-error").hidden = false;
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
      if (marker(page) !== cutoffMs) {
        void refresh();
        return;
      }
      if (!page.tracingAvailable) throw new Error();
      for (const o of page.observations ?? []) observations.set(o.id, o);
      nextCursor = page.nextCursor;
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

refresh();
setInterval(refresh, 5000);
setupSteering();
void restoreTrace(location.search);
