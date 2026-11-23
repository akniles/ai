import { $, el } from "./ui.js";

export function activityItems(data) {
  const observations = data.observations ?? [];
  const workerTraces = new Set(observations
    .filter(o => ["Pi · observer", "Pi simulation · observer"].includes(o.name) ||
      ["Pi · turn ", "Pi simulation · turn "].some(prefix => o.name?.startsWith(prefix)))
    .map(o => o.traceId));
  return observations
    .filter(o => o.name === "agent.work" && o.traceId && workerTraces.has(o.traceId) &&
      typeof o.preview?.report === "string" && o.preview.report.trim())
    .sort((a, b) => new Date(b.start) - new Date(a.start))
    .map(o => o.preview.report.trim());
}

export function renderActivity(items, limit, nextCursor) {
  const timeline = $("timeline");
  timeline.replaceChildren();
  for (const narration of items.slice(0, limit))
    timeline.append(el("p", "narration", narration));
  if (!items.length)
    timeline.append(el("p", "empty", "Waiting for the observer…"));
  $("more").hidden = items.length <= limit && !nextCursor;
}
