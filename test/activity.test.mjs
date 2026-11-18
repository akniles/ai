import test from "node:test";
import assert from "node:assert/strict";
import { activityItems } from "../web/activity.js";

test("activity groups only observations of the same trace, keeps event order and offers a tool-only view", () => {
  const data = {
    events: [
      {
        id: "note",
        category: "note",
        time: "2026-11-19T03:02:00Z",
        note: "A real result",
      },
    ],
    observations: [
      {
        id: "a",
        traceId: "first",
        name: "tool.shell_start",
        start: "2026-11-19T03:01:00Z",
      },
      {
        id: "b",
        traceId: "first",
        name: "tool.job_poll",
        start: "2026-11-19T03:03:00Z",
      },
      {
        id: "c",
        traceId: "second",
        name: "llm.worker",
        type: "GENERATION",
        start: "2026-11-19T03:00:00Z",
      },
    ],
  };
  const items = activityItems(data);
  assert.deepEqual(
    items.map((i) => i.id),
    ["first", "note"],
  );
  assert.deepEqual(
    items[0].observations.map((o) => o.id),
    ["a", "b"],
  );
  assert.equal(items[1].note, "A real result");
  const tools = activityItems(data, true);
  assert.equal(tools.length, 1);
  assert.deepEqual(
    tools[0].observations.map((o) => o.id),
    ["a", "b"],
  );
});
