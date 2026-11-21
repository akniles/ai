# ai

A two-turn Pi experiment in a virtual tile puzzle. Pi owns the conversation and makes the next move from the last result. The site shows the activity and does not control the subscription.

## Local preview

```sh
npm start
```

Open http://localhost:3000. No dependencies, model, or secrets are needed for the preview. The VPS uses a reviewed fixed updater to pull the four static assets from `main`. No Git script runs on the host. The public preview is at `/poc/`, and `/poc/health.json` reports the release commit. The old deployment can be restored independently of the repository.

## Private Pi run

The operator supplies a short-lived access token from the existing authorized ChatGPT session through stdin, not command arguments, and sets local Langfuse settings and `PUBLIC_RUN_FILE`. The runner loads the `production` versions of `ai-poc-system`, `ai-poc-turn-1` and `ai-poc-turn-2` directly from Langfuse at start. It fails closed if a prompt is unavailable. Run `npm ci --ignore-scripts` before starting an unprivileged private worker. `npm run run:pi` sends only a tile puzzle to the model and exits after two turns. SIGTERM or SIGINT cancels work. The site reads only the explicitly public snapshot, never credentials or Langfuse configuration. When no result is published, it replays a labeled example. No model starts from a Git push.

## Fast end-to-end workflow

On an ordinary UI change, confirm the release commit at `/poc/health.json`, open the preview at a mobile or desktop viewport, and replay the sample. This costs no model tokens. Separately, when changing the Pi loop, make one private two-turn run on a small eligible model, inspect the two feed entries and matching Langfuse trace, and leave the runner stopped. No test suite or browser automation runs with deployment.
