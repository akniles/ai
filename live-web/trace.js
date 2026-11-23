import { $, el, clock } from "./ui.js";

function observationName(o) {
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
    "tool.state_set": "Updated its working notes or pause",
    "tool.goal_set": "Changed a goal",
    "tool.journal": "Recorded a note",
    "tool.shell_start": "Ran a command",
    "tool.job_poll": "Checked a running task",
    "tool.job_cancel": "Stopped a task",
    "tool.subagent_start": "Delegated a task",
    "tool.memory_decide": "Considered what to remember",
    "tool.memory_search": "Searched its memory",
    "tool.memory_core_set": "Updated its core memory",
    "tool.inbox_list": "Checked for messages",
    "tool.inbox_read": "Read a message",
    "tool.inbox_reply": "Sent a reply",
    "tool.chat_set": "Changed chat preferences",
    "tool.skills_list": "Looked for skills",
    "tool.skill_read": "Read a skill",
    "tool.skill_write": "Saved a skill",
  };
  return names[o.name] ?? o.name.replace(/^tool\./, "");
}

// Missing parents in older recordings stay flat; no inferred relationships.
function traceTree(observations) {
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

const traceIdPattern = /^[a-f0-9]{32}$/;
const observationIdPattern = /^[a-f0-9]{16}$/;

export function restoreTrace(search) {
  const params = new URLSearchParams(search);
  const traceId = params.get("trace");
  const id = params.get("observation");
  if (!traceIdPattern.test(traceId ?? "") ||
      (id !== null && !observationIdPattern.test(id))) return;
  return openTrace({ traceId, id }, id === null);
}

let requestId = 0;
async function openTrace(observation, wholeTrace = false) {
  if (!traceIdPattern.test(observation.traceId ?? "")) return;
  const ticket = ++requestId;
  $("trace-title").textContent = wholeTrace
    ? "Execution trace"
    : observation.name ? observationName(observation) : "Observation";
  $("trace-kind").textContent = wholeTrace ? "Trace" : "Observation";
  $("trace-content").replaceChildren(el("p", "empty", "Loading…"));
  $("trace-native").hidden = true;
  if (!$("trace-dialog").open) $("trace-dialog").showModal();
  try {
    const r = await fetch(`/api/traces/${observation.traceId}`);
    if (!r.ok) throw new Error();
    const trace = await r.json();
    if (ticket !== requestId || !$("trace-dialog").open) return;
    function render(observation, wholeTrace = false) {
      $("trace-title").textContent = wholeTrace
        ? "Execution trace"
        : observationName(observation);
      $("trace-kind").textContent = wholeTrace
        ? "Recorded activity"
        : observation.name;
      const content = $("trace-content");
      content.replaceChildren();
      if (wholeTrace) {
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
            button.addEventListener("click", () => render(o));
            item.append(button);
            if (o.children.length) item.append(draw(o.children));
            list.append(item);
          }
          return list;
        };
        content.append(draw(traceTree(trace.observations)));
      } else {
        const selected = trace.observations.find(
          (o) => o.id === observation.id,
        );
        if (!selected) throw new Error();
        const back = el("button", "trace-back", "Full trace");
        back.addEventListener("click", () => render(observation, true));
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
      const link = $("trace-native");
      const query = new URLSearchParams({ trace: trace.traceId });
      if (!wholeTrace) query.set("observation", observation.id);
      link.href = "/?" + query + "#live";
      link.hidden = false;
    }
    if (wholeTrace && !trace.observations.length) throw new Error();
    const selected = wholeTrace ? observation :
      trace.observations.find((o) => o.id === observation.id);
    if (!selected) throw new Error();
    render(selected, wholeTrace);
  } catch {
    if (ticket === requestId)
      $("trace-content").replaceChildren(
        el("p", "empty", "Trace unavailable. Please try again."),
      );
  }
}
