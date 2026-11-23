# ai

Pi owns the conversation, selects a goal, and continues from the previous outcome. The site shows the activity and does not control the subscription.

## Local shell

`npm start` serves the legacy static shell on port 3000. The old sample replay has been retired. On the VPS, `/poc/health.json` stays available as a deployment diagnostic.

## Live frontend

The separate `live-web/` directory contains the eight browser files for `/#live`. The same VPS timer checks `main` about every 90 seconds and publishes that allowlist as a complete release when its contents change. The live server reads it from a stable read-only mount. The prior releases remain on the host; revert a frontend commit in `main` to roll it back. The timer never executes scripts from Git, deploys backend code, or starts Pi.

## Pi worker

The owner launcher supplies the credentials on attached stdin. The worker reads `pi-system` and `observer-system` at startup and `pi-goal` before each turn. Pi can save a working goal with `set_working_goal`; a separate observer narrates saved changes. The viewing window remains limited to ten minutes and twenty total model requests. See [Runner and prompts](docs/experiment.md).

The Git timer publishes only the frontend. Deploy the worker as a reviewed image with a pinned supervisor configuration. No model starts from a Git push.

## Owner admin

The VPS serves the three admin-web assets separately at /admin. Pair this browser with a fresh code approved by Dora. The owner-only API changes pause state and saves model aliases and generation delay. Terra and Luna are the defaults. Both selectors use the authenticated subscription catalogue; the worker sends the selected model ID to OpenAI Responses without substituting another model. Settings apply on the next run; the delay is measured between the end of one model call and dispatch of the next, including calls to the observer. The production time and request limits still apply.

Clear hides public history and memory for every viewer. Private logs and settings are retained.
