# Runner and prompts

Pi works toward the owner objective in `pi-goal` and can record a working goal with `set_working_goal(goal, reason)`. The current working goal is stored across runs. A repeated goal and reason produce no new public event.

The worker reads production `pi-system` and `observer-system` at startup, and production `pi-goal` before each new turn. Updating the operator objective changes the next turn. That objective and the agent's working goal are separate records.

The observer has no tools and narrates confirmed working-goal changes. The viewer page still renders previous observer entries until the history is cleared from the admin page. The files in `prompts/` are neutral seeds; live Langfuse versions are managed separately.
