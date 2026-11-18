import { $, el, clock } from "./ui.js";
import { renderActivity, renderGoals, toolButton } from "./activity.js";
import { renderMemory } from "./memory.js";
import { startChat } from "./chat.js";

let data = null;
let paused = false;
let toolsOnly = false;
let shown = 8;
let feedSnapshot = "";
let goalsSnapshot = "";
let memorySnapshot = "";
let traceRequest = 0;

function renderState() {
  const goal = data.goals.find((g) => g.status === "active");
  let state = "Working";
  let appearance = "active";
  let step = goal ? "path-act" : "path-goal";
  let explanation = "The agent is working with its tools.";
  if (data.paused) {
    state = "Stopped by owner";
    appearance = "stopped";
    step = null;
    explanation = "The owner has stopped the agent.";
  } else if (data.thinking) {
    state = "Thinking";
    explanation = "It is considering its next action.";
  } else if (data.schedule?.phase === "backoff") {
    state = "Waiting to retry";
    appearance = "resting";
    step = "path-wait";
    explanation =
      "A previous attempt did not complete. Retry at " +
      clock(data.schedule.nextWakeAt) +
      ".";
  } else if (data.schedule?.phase === "waiting") {
    state = "Resting";
    appearance = "resting";
    step = "path-wait";
    explanation =
      "Next wake at " +
      clock(data.schedule.nextWakeAt) +
      ". New messages can wake it sooner.";
  }
  $("state").textContent = state;
  $("agent-now").dataset.state = appearance;
  $("current-goal").textContent = goal?.text ?? "Choosing what to do next.";
  $("wake-status").textContent = explanation;
  for (const id of ["path-goal", "path-act", "path-wait"])
    $(id).classList.toggle("current", id === step);
  const latest = data.observations
    .filter((o) => o.name.startsWith("tool."))
    .sort((a, b) => new Date(b.start) - new Date(a.start))[0];
  const latestBox = $("latest-action");
  if (latestBox.dataset.id !== (latest?.id ?? "")) {
    latestBox.dataset.id = latest?.id ?? "";
    latestBox.replaceChildren();
    if (latest)
      latestBox.append(
        toolButton(latest, openTrace),
        el("span", "detail-meta", clock(latest.start)),
      );
    else
      latestBox.append(el("span", "detail-meta", "No tool observations yet."));
  }
  if (data.langfuse?.startsWith("https://")) {
    $("langfuse-link").href = data.langfuse + "/project/ai/traces";
    $("langfuse-link").hidden = false;
  }
}

function renderFeed() {
  renderActivity(data, { toolsOnly, shown, openTrace });
}

async function openTrace(observation) {
  const ticket = ++traceRequest;
  $("trace-title").textContent = observation.name.replace(/^tool\./, "");
  $("trace-content").replaceChildren(el("p", "empty", "Loading observation…"));
  $("trace-native").hidden = true;
  if (!$("trace-dialog").open) $("trace-dialog").showModal();
  try {
    const response = await fetch(`/api/traces/${observation.traceId}`);
    if (!response.ok) throw new Error();
    const trace = await response.json();
    if (ticket !== traceRequest) return;
    const selected = trace.observations.find((o) => o.id === observation.id);
    if (!selected) throw new Error();
    const content = $("trace-content");
    content.replaceChildren();
    for (const key of ["input", "output"]) {
      const value = selected[key];
      content.append(
        el("h3", "io-label", key === "input" ? "Input" : "Output"),
        el(
          "pre",
          "result-output",
          value === undefined
            ? "Not available in the public view."
            : typeof value === "string"
              ? value
              : JSON.stringify(value, null, 2),
        ),
      );
    }
    if (data.langfuse?.startsWith("https://")) {
      $("trace-native").href =
        `${data.langfuse}/project/ai/traces/${trace.traceId}?observation=${selected.id}`;
      $("trace-native").hidden = false;
    }
  } catch {
    if (ticket === traceRequest)
      $("trace-content").replaceChildren(
        el("p", "empty", "Observation unavailable. Please try again."),
      );
  }
}
$("trace-dialog").addEventListener("close", () => traceRequest++);

async function refresh() {
  if (paused || document.hidden) return;
  try {
    const response = await fetch("/api/live", { cache: "no-store" });
    if (!response.ok) throw new Error();
    data = await response.json();
    $("connection").textContent = "Feed connected";
    $("connection-dot").className = "dot live";
    renderState();
    const nextFeed = JSON.stringify([
      data.events,
      data.observations,
      data.tracingAvailable,
    ]);
    if (nextFeed !== feedSnapshot && !$("trace-dialog").open) {
      feedSnapshot = nextFeed;
      renderFeed();
    }
    const nextGoals = JSON.stringify(data.goals);
    if (nextGoals !== goalsSnapshot) {
      goalsSnapshot = nextGoals;
      renderGoals(data);
    }
    const nextMemory = JSON.stringify(data.memories);
    if (nextMemory !== memorySnapshot) {
      memorySnapshot = nextMemory;
      renderMemory(data, $("memory-search").value);
    }
  } catch {
    $("connection").textContent = "Reconnecting";
    $("connection-dot").className = "dot stale";
    $("state").textContent = "State unavailable";
    $("agent-now").dataset.state = "unknown";
    $("wake-status").textContent = data
      ? "Showing the last received state. Reconnecting to the agent."
      : "Agent state is temporarily unavailable. Reconnecting.";
    for (const id of ["path-goal", "path-act", "path-wait"])
      $(id).classList.remove("current");
  }
}
$("pause").addEventListener("click", () => {
  paused = !paused;
  $("pause").textContent = paused ? "Resume feed" : "Pause feed";
  $("pause").setAttribute("aria-pressed", paused);
  $("connection").textContent = paused ? "Feed paused" : "Connecting";
  $("connection-dot").className = paused ? "dot" : "dot live";
  if (!paused) refresh();
});
$("filter").addEventListener("click", () => {
  toolsOnly = !toolsOnly;
  $("filter").setAttribute("aria-pressed", toolsOnly);
  shown = 8;
  if (data) renderFeed();
});
$("more").addEventListener("click", () => {
  shown += 8;
  renderFeed();
});
$("memory-search").addEventListener("input", (event) => {
  if (data) renderMemory(data, event.target.value);
});
refresh();
setInterval(refresh, 5000);
startChat(() => data?.paused);
