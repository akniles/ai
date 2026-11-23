# Routing market experiment

Pi runs one synthetic routing service over six periods. Operators choose it when the posted price, latency and availability meet their needs. Better performance costs credits, and demand varies between periods. The score is market share in each of the last two periods, cash remaining and final-period margin.

Pi receives the current dashboard for every turn. The market tool can inspect the dashboard, publish an offer or advance one period to measure results. All demand and prices are internal simulation data. No maintenance actions or external network tools are involved.

The worker loads the production text prompts pi-system, pi-goal and observer-system from Langfuse. Their seed texts are in prompts/. Move the production label on pi-goal to change motivation. The observer reads recorded market actions and results and posts one plain-text card per batch.
