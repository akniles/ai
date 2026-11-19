import { $, el, clock, date, goalLabels } from "./ui.js";
import { observationName } from "./trace.js";

// Group only observations with the same trace ID. The UI does not infer goals
// or reasoning from model output. Notes and goal changes keep their own times.
export function activityItems(data, toolsOnly = false) {
  const groups = new Map();
  for (const o of data.observations ?? []) {
    if (toolsOnly && !o.name.startsWith("tool.")) continue;
    const group = groups.get(o.traceId) ?? {
      id: o.traceId,
      time: o.start,
      observations: [],
    };
    group.observations.push(o);
    if (o.start > group.time) group.time = o.start;
    groups.set(o.traceId, group);
  }
  const events = toolsOnly
    ? []
    : data.events.filter((e) => e.category !== "sharing");
  const traces = [...groups.values()];
  return [...events, ...traces].sort(
    (a, b) => new Date(b.time) - new Date(a.time),
  );
}

export function toolButton(observation, openTrace) {
  const name = observationName(observation);
  const button = el("button", "tool-link", name);
  button.dataset.observation = observation.id;
  button.setAttribute("aria-label", `${name} at ${clock(observation.start)}`);
  button.addEventListener("click", () => openTrace(observation));
  return button;
}

export function renderActivity(data, { toolsOnly, shown, openTrace }) {
  const timeline = $("timeline");
  const openIds = new Set(
    [...timeline.querySelectorAll("details[open]")].map((d) => d.dataset.id),
  );
  const focused = document.activeElement?.dataset.observation;
  const items = activityItems(data, toolsOnly);
  timeline.replaceChildren();
  if (data.tracingAvailable === false)
    timeline.append(
      el(
        "p",
        "detail-note",
        "Tool history is reconnecting. Goals and notes are still available.",
      ),
    );
  for (const item of items.slice(0, shown)) {
    const row = el("article", `event ${item.category ?? "trace"}`);
    const time = el("time", "event-time", clock(item.time));
    time.dateTime = item.time;
    time.title = date(item.time);
    const body = el("div", "event-body");
    if (item.observations) {
      const tools = item.observations.filter((o) => o.name.startsWith("tool."));
      const names = [
        ...new Set(tools.map((o) => o.name.replace(/^tool\./, ""))),
      ];
      const details = el("details", "trace-group");
      details.dataset.id = item.id;
      details.open = openIds.has(item.id);
      const summary = el("summary");
      summary.textContent = "Steps";
      summary.setAttribute(
        "aria-label",
        `Steps in trace at ${date(item.time)}`,
      );
      details.append(summary);
      const root = item.observations.find(
        (o) => !o.parentId && o.name.startsWith("agent."),
      );
      const title = el(
        "button",
        "event-title trace-title",
        root ? observationName(root) : "Execution trace",
      );
      title.addEventListener("click", () =>
        openTrace(item.observations[0], true),
      );
      body.append(
        title,
        el(
          "p",
          "detail-meta",
          `${item.observations.filter((o) => o.type === "GENERATION").length} model calls · ${tools.length} tool calls`,
        ),
      );
      const toolStrip = el("div", "tool-strip");
      for (const name of names)
        toolStrip.append(
          toolButton(
            tools.find((o) => o.name === `tool.${name}`),
            openTrace,
          ),
        );
      body.append(toolStrip);
      const observations = el("div", "trace-tools");
      for (const o of [...item.observations].sort(
        (a, b) => new Date(a.start) - new Date(b.start),
      )) {
        const button = toolButton(o, openTrace);
        button.dataset.observation = o.id;
        if (o.type === "GENERATION") {
          button.textContent = o.model ?? o.name;
          button.setAttribute(
            "aria-label",
            `${button.textContent} at ${clock(o.start)}`,
          );
        }
        const label = el("div", "trace-tool-row");
        label.append(button, el("span", "detail-meta", clock(o.start)));
        observations.append(label);
      }
      details.append(observations);
      body.append(details);
    } else {
      const title =
        item.category === "goal"
          ? {
              active: "Chose a goal",
              done: "Completed a goal",
              abandoned: "Cancelled a goal",
            }[item.status]
          : item.category === "note"
            ? "In its own words"
            : item.title;
      body.append(el("p", "event-title", title));
      if (item.note || item.text)
        body.append(el("p", "event-note", item.note ?? item.text));
      if (item.reason) body.append(el("p", "event-reason", item.reason));
    }
    row.append(time, body);
    timeline.append(row);
  }
  if (!items.length) timeline.append(el("p", "empty", "No observations yet."));
  $("more").hidden = items.length <= shown && !data.nextCursor;
  if (focused)
    [...timeline.querySelectorAll("button")]
      .find((b) => b.dataset.observation === focused)
      ?.focus({ preventScroll: true });
}

const expandedGoals = new Set();
export function renderGoals(data) {
  const openIds = new Set(
    [...document.querySelectorAll(".goal-card[open]")].map((e) => e.dataset.id),
  );
  for (const status of ["active", "done", "abandoned"]) {
    const goals = data.goals.filter((g) => g.status === status).slice(0, 10);
    const list = $(`goals-${status}`);
    list.replaceChildren();
    $(`${status}-count`).textContent = goals.length;
    if (!goals.length)
      list.append(
        el(
          "p",
          "column-empty",
          `No ${goalLabels[status].toLowerCase()} goals.`,
        ),
      );
    for (const goal of goals.slice(0, expandedGoals.has(status) ? 10 : 1)) {
      const card = el("details", "goal-card");
      card.dataset.id = goal.id;
      card.open = openIds.has(goal.id);
      const summary = el("summary");
      summary.append(
        el("span", "goal-text", goal.text),
        el("small", "", date(goal.updated)),
      );
      card.append(summary);
      const history = el("ol", "goal-history");
      for (const h of goal.history) {
        const item = el("li");
        item.append(
          el("time", "detail-meta", date(h.time)),
          el("strong", "", goalLabels[h.status] ?? h.status),
          el("p", "", h.text),
        );
        history.append(item);
      }
      card.append(history);
      list.append(card);
    }
    if (goals.length > 1) {
      const expanded = expandedGoals.has(status);
      const button = el(
        "button",
        "goals-more",
        expanded ? "Show less" : `Show ${goals.length - 1} more`,
      );
      button.setAttribute("aria-expanded", expanded);
      button.setAttribute("aria-controls", `goals-${status}`);
      button.addEventListener("click", () => {
        expanded ? expandedGoals.delete(status) : expandedGoals.add(status);
        renderGoals(data);
      });
      list.append(button);
    }
  }
}
