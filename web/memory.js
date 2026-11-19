import { $, el, svg, date } from "./ui.js";
let selectedMemory = null;

export function renderMemory(data, memoryQuery = "") {
  const items = data.memories.filter((m) =>
      (m.text + " " + (m.title ?? ""))
        .toLowerCase()
        .includes(memoryQuery.toLowerCase()),
    ),
    map = $("memory-map"),
    list = $("memory-list");
  const mapTitle = svg("title", { id: "memory-map-title" });
  mapTitle.textContent = "Memories connected by shared words.";
  map.replaceChildren(mapTitle);
  const focused = document.activeElement?.dataset.memory;
  const focusedTag = document.activeElement?.tagName;
  list.replaceChildren();
  if (!items.some((m) => m.id === selectedMemory))
    selectedMemory = items[0]?.id ?? null;
  const title = (m) => m.title || m.text.split(/[.\n]/)[0].slice(0, 80);
  $("memory-status").textContent = data.memoryStatus.lastSavedAt
    ? `${data.memoryStatus.total} memories · Last saved ${date(data.memoryStatus.lastSavedAt)}`
    : "No memories saved yet.";
  const columns = matchMedia("(max-width: 600px)").matches ? 2 : 4;
  const nodes = items.slice(0, 40).map((m, i) => ({
    ...m,
    x: 80 + (i % columns) * 160,
    y: 38 + Math.floor(i / columns) * 94,
  }));
  map.setAttribute(
    "viewBox",
    `0 0 ${columns * 160} ${Math.max(180, Math.ceil(nodes.length / columns) * 94 + 20)}`,
  );
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
    const group = svg("a", {
        class: `memory-node ${m.core ? "is-core" : ""} ${m.id === selectedMemory ? "selected" : ""}`,
        href: "#memory-detail",
        "aria-label": title(m),
        "data-memory": m.id,
      }),
      halo = svg("circle", { cx: m.x, cy: m.y, r: 17, class: "node-halo" }),
      dot = svg("circle", {
        cx: m.x,
        cy: m.y,
        r: m.core ? 7 : 5,
        class: "node-dot",
      }),
      label = svg("text", { x: m.x, y: m.y + 32, "text-anchor": "middle" });
    const words = title(m).split(" ");
    let line = "";
    const lines = [];
    for (const word of words) {
      if ((line + " " + word).length > 22 && line) {
        lines.push(line);
        line = word;
      } else line += (line ? " " : "") + word;
    }
    if (line) lines.push(line);
    for (const [i, text] of lines.slice(0, 2).entries()) {
      const span = svg("tspan", { x: m.x, dy: i ? 14 : 0 });
      span.textContent = text + (i === 1 && lines.length > 2 ? "…" : "");
      label.append(span);
    }
    const tooltip = svg("title");
    tooltip.textContent = title(m);
    group.append(halo, dot, label, tooltip);
    group.addEventListener("click", () => {
      selectedMemory = m.id;
      renderMemory(data, memoryQuery);
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
      : "No memories yet.";
    map.append(note);
  }
  for (const [index, m] of items.entries()) {
    const button = el(
      "button",
      `memory-chip ${m.id === selectedMemory ? "selected" : ""}`,
    );
    button.dataset.memory = m.id;
    button.append(
      el("small", "", `${m.core ? "Core" : m.kind}`),
      el("span", "memory-preview", title(m)),
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
      el("h3", "memory-title", title(m)),
      el("p", "memory-fact", m.text),
      el("p", "detail-meta", `${m.kind} · ${date(m.time)}`),
    );
  else detail.append(el("p", "empty", "No memory selected."));
  if (focused)
    [...$("memory").querySelectorAll("[data-memory]")]
      .find((b) => b.dataset.memory === focused && b.tagName === focusedTag)
      ?.focus({ preventScroll: true });
}
