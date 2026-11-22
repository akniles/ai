import { $, el, date } from "./ui.js";
import { observationName } from "./trace.js";

// Group only observations with the same trace ID. The UI does not infer goals
// or reasoning from model output. Notes and goal changes keep their own times.
export function activityItems(data) {
  const groups = new Map();
  for (const o of data.observations ?? []) {
    if (o.name === 'Private reply') continue;
    const group = groups.get(o.traceId) ?? {
      id: o.traceId,
      time: o.start,
      observations: [],
    };
    group.observations.push(o);
    if (o.start > group.time) group.time = o.start;
    groups.set(o.traceId, group);
  }
  // Prefer recorded traces when present; preserve events as a fallback.
  // Keep the standalone event feed as a fallback when no traces can be read.
  const events = (data.events ?? []).filter(
    (e) => !groups.size || !["goal", "note"].includes(e.category),
  );
  const traces = [...groups.values()].filter(({ observations }) =>
    !observations.some(o => o.name.startsWith('Pi simulation · ')) ||
    observations.some(o => o.name === 'agent.work' && o.preview?.report),
  );
  return [...events, ...traces].sort(
    (a, b) => new Date(b.time) - new Date(a.time),
  );
}

export function workSummary(observations) {
  const root = observations.find(
    (o) => !o.parentId && o.name.startsWith("agent."),
  );
  const work = root?.name === "agent.work" && root.preview?.report
    ? root
    : observations.find((o) => o.name === "agent.work" && o.preview?.report);
  if (work || root?.name === "agent.work")
    return {
      title: "Work session",
      report: work?.preview?.report,
    };
  return {
    title: root ? observationName(root) : "Recorded actions",
    report: root?.preview?.report,
  };
}

export function renderActivity(data, { shown, openTrace }) {
  const timeline = $("timeline");
  const focused = document.activeElement?.dataset.observation;
  const items = activityItems(data);
  timeline.replaceChildren();
  if (data.tracingAvailable === false)
    timeline.append(
      el(
        "p",
        "detail-note",
        "Action details are temporarily unavailable. Retrying…",
      ),
    );
  for (const item of items.slice(0, shown)) {
    const row = el("article", "event " + (item.category ?? "trace"));
    const time = el("time", "event-time", date(item.time));
    time.dateTime = item.time;
    const body = el("div", "event-body");
    if (item.observations) {
      const { title, report } = workSummary(item.observations);
      if (report) {
        body.append(el("p", "event-note", report));
      } else {
        body.append(el("h3", "event-title", title));
      }
      const actions = el("div", "event-actions");
      const hasError = item.observations.some((o) => o.level === "ERROR");
      const link = el(
        "button",
        "text-button",
        hasError ? "See actions, results and errors" : "See actions and results",
      );
      link.dataset.observation = item.observations[0].id;
      link.addEventListener("click", () =>
        openTrace(item.observations[0], true),
      );
      actions.append(link);
      body.append(actions);
    } else {
      const title =
        item.category === "goal"
          ? {
              active: "Chose a goal",
              done: "Completed a goal",
              abandoned: "Cancelled a goal",
            }[item.status]
          : item.category === "note"
            ? "AI’s note"
            : item.title;
      body.append(el("h3", "event-title", title));
      if (item.note || item.text)
        body.append(el("p", "event-note", item.note ?? item.text));
      if (item.reason) body.append(el("p", "event-reason", item.reason));
    }
    row.append(time, body);
    timeline.append(row);
  }
  if (!items.length)
    timeline.append(el("p", "empty", "No activity recorded yet."));
  $("more").hidden = items.length <= shown && !data.nextCursor;
  if (focused)
    [...timeline.querySelectorAll("button")]
      .find((b) => b.dataset.observation === focused)
      ?.focus({ preventScroll: true });
}
