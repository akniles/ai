# ai

Pi owns the conversation, selects a goal, and continues from the previous outcome. The site shows the activity and does not control the subscription.

## Local shell

`npm start` serves the legacy static shell on port 3000. The old sample replay has been retired. On the VPS, `/poc/health.json` stays available as a deployment diagnostic.

## Live frontend

The separate `live-web/` directory contains the eight browser files for `/#live`. The same VPS timer checks `main` about every 90 seconds and publishes that allowlist as a complete release when its contents change. The live server reads it from a stable read-only mount. The prior releases remain on the host; revert a frontend commit in `main` to roll it back. The timer never executes scripts from Git, deploys backend code, or starts Pi.

## Private Pi run

The owner launcher supplies the short-lived token, Langfuse keys and private control credential through attached stdin, and sets the service origins and `PUBLIC_RUN_FILE`. Credentials stay out of launch arguments and container configuration. The runner loads the `production` versions of `ai-identity`, `ai-goal-selection` and `ai-invocation` directly from Langfuse at start. It fails closed if a prompt is unavailable. Run `npm ci --ignore-scripts` before starting an unprivileged private worker. `npm run run:pi` uses the existing production prompts. The two-turn smoke remains the default. The authenticated owner live mode uses a ten-minute viewing window capped at twenty model calls, paced twenty seconds apart. Each public turn has its own trace and card. Only the paired owner's private messages are eligible during a chat-bound window; those turns are excluded from the public feed and its Langfuse session. Optional private control wiring reads the owner pause state and publishes goals and work reports through the current site API. SIGTERM or SIGINT cancels work. The site reads only the explicitly public snapshot, never credentials or Langfuse configuration. An empty live feed shows an empty state. No model starts from a Git push.

## Fast end-to-end workflow

On an ordinary UI change, confirm the release commit at `/poc/health.json` and open `/#live` at desktop and mobile widths. Use local fixtures to exercise incoming events without publishing them. This costs no model tokens. Separately, when changing the Pi loop, make one private two-turn run on a small eligible model, inspect the two feed entries and matching Langfuse trace, and leave the runner stopped. No test suite or browser automation runs with deployment.

## Simulation observer

See [Routing market experiment](docs/experiment-market.md) for the rules and Langfuse prompt names. The observer defaults to gpt-6-luna, uses no tools and writes its narration to the existing live timeline. PI_OBSERVER_WINDOW_SECONDS controls the batching window (default 15 seconds).

Deploy a reviewed worker image with a pinned supervisor configuration. The Git timer publishes the public browser assets only. The current worker window and token budget still apply.

## Owner admin

The VPS serves the three admin-web assets separately at /admin. Pair this browser with a fresh code approved by Dora. The owner-only API changes pause state and saves model aliases and generation delay. Terra and Luna are the defaults. Both selectors use the authenticated subscription catalogue; the worker sends the selected model ID to OpenAI Responses without substituting another model. Settings apply on the next run; the delay is measured between the end of one model call and dispatch of the next, including calls to the observer. The production time and request limits still apply.

Clear hides public history and memory for every viewer. Private logs and settings are retained.
