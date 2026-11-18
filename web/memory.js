import { $, el, svg, date } from "./ui.js";
let selectedMemory = null;

export function renderMemory(data, memoryQuery = "") {
  const items = data.memories.filter((m) =>
      m.text.toLowerCase().includes(memoryQuery.toLowerCase()),
    ),
    map = $("memory-map"),
    list = $("memory-list");
  const mapTitle = svg("title", { id: "memory-map-title" });
  mapTitle.textContent =
    "Map of shared memories. Numbers match the memories below.";
  map.replaceChildren(mapTitle);
  const focused = document.activeElement?.dataset.memory;
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
      number: i + 1,
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
      }),
      halo = svg("circle", { cx: m.x, cy: m.y, r: 17, class: "node-halo" }),
      dot = svg("circle", {
        cx: m.x,
        cy: m.y,
        r: m.core ? 7 : 5,
        class: "node-dot",
      }),
      label = svg("text", { x: m.x, y: m.y + 32, "text-anchor": "middle" });
    label.textContent = `Memory ${m.number}`;
    const title = svg("title");
    title.textContent = m.text;
    group.append(halo, dot, label, title);
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
  for (const [index, m] of items.entries()) {
    const button = el(
      "button",
      `memory-chip ${m.id === selectedMemory ? "selected" : ""}`,
    );
    button.dataset.memory = m.id;
    button.append(
      el("small", "", `Memory ${index + 1} · ${m.core ? "Core" : m.kind}`),
      el("span", "memory-preview", m.text),
    );
    button.setAttribute("aria-pressed", m.id === selectedMemory);
    button.addEventListener("click", () => {
      selectedMemory = m.id;
      renderMemory(data, memoryQuery);
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
  if (focused)
    [...list.querySelectorAll("button")]
      .find((b) => b.dataset.memory === focused)
      ?.focus({ preventScroll: true });
}
