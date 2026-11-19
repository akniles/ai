import { $, el, clock } from "./ui.js";

export function observationName(o) {
  const names = {
    "agent.work": "Autonomous work",
    "agent.goal_selection": "Choosing a goal",
    "agent.subagent": "Subagent",
    llm: "Model call",
    "llm.memory": "Memory model call",
    "llm.error": "Model error",
    "memory.memories": "Store in Hindsight",
    "memory.memories/recall": "Search Hindsight",
    "execution.shell": "Command result",
    "execution.subagent": "Subagent result",
  };
  return names[o.name] ?? o.name.replace(/^tool\./, "");
}

// Missing parents in older recordings stay flat; no inferred relationships.
export function traceTree(observations) {
  const nodes = new Map(
    observations.map((o) => [o.id, { ...o, children: [] }]),
  );
  const roots = [];
  for (const node of nodes.values()) {
    const parent = nodes.get(node.parentId);
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  const order = (list) => {
    list.sort((a, b) => new Date(a.start) - new Date(b.start));
    for (const node of list) order(node.children);
    return list;
  };
  return order(roots);
}

let requestId = 0;
export async function openTrace(observation, langfuse, wholeTrace = false) {
  const ticket = ++requestId;
  $("trace-title").textContent = wholeTrace
    ? "Execution trace"
    : observationName(observation);
  $("trace-kind").textContent = wholeTrace ? "Trace" : "Observation";
  $("trace-content").replaceChildren(el("p", "empty", "Loading…"));
  $("trace-native").hidden = true;
  if (!$("trace-dialog").open) $("trace-dialog").showModal();
  try {
    const r = await fetch(`/api/traces/${observation.traceId}`);
    if (!r.ok) throw new Error();
    const trace = await r.json();
    if (ticket !== requestId || !$("trace-dialog").open) return;
    const content = $("trace-content");
    content.replaceChildren();
    if (wholeTrace) {
      content.append(
        el(
          "p",
          "detail-note",
          "Select a step to read its input and output. Nested steps were started by their parent.",
        ),
      );
      const draw = (nodes) => {
        const list = el("ol", "trace-tree");
        for (const o of nodes) {
          const item = el("li", o.level === "ERROR" ? "trace-error" : "");
          const button = el("button", "trace-step");
          button.append(el("span", "", observationName(o)));
          const duration = Math.max(
            0,
            (new Date(o.end) - new Date(o.start)) / 1000,
          );
          const tokens =
            o.usage?.total ?? (o.usage?.input ?? 0) + (o.usage?.output ?? 0);
          button.append(
            el(
              "small",
              "detail-meta",
              `${clock(o.start)} · ${duration.toFixed(1)}s${tokens ? ` · ${tokens} tokens` : ""}${o.level === "ERROR" ? " · Failed" : ""}`,
            ),
          );
          button.addEventListener("click", () => openTrace(o, langfuse));
          item.append(button);
          if (o.children.length) item.append(draw(o.children));
          list.append(item);
        }
        return list;
      };
      content.append(draw(traceTree(trace.observations)));
    } else {
      const selected = trace.observations.find((o) => o.id === observation.id);
      if (!selected) throw new Error();
      const back = el("button", "trace-back", "← Full trace");
      back.addEventListener("click", () =>
        openTrace(observation, langfuse, true),
      );
      content.append(back);
      for (const key of ["input", "output"]) {
        const value = selected[key];
        content.append(
          el("h3", "io-label", key === "input" ? "Input" : "Output"),
          el(
            "pre",
            "result-output",
            value == null
              ? "No value recorded."
              : typeof value === "string"
                ? value
                : JSON.stringify(value, null, 2),
          ),
        );
      }
    }
    if (langfuse?.startsWith("https://")) {
      $("trace-native").href =
        `${langfuse}/project/ai/traces/${trace.traceId}${wholeTrace ? "" : "?observation=" + observation.id}`;
      $("trace-native").hidden = false;
    }
  } catch {
    if (ticket === requestId)
      $("trace-content").replaceChildren(
        el("p", "empty", "Trace unavailable. Please try again."),
      );
  }
}
