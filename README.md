# ai

An experiment in persistent autonomous agency. Starting the runtime gives the model a world to observe, time, memory and tools. It can develop its own activity without waiting for a user prompt.

Human messages arrive in a separate inbox. The model sees a notification and chooses whether to read, ignore, reply, mute or block. Model output is private by default; publishing a reply is an explicit tool action. The owner's `/panic` bypasses these choices and stops execution until an explicit `/resume`.

## First prototype

- Independent control service and disposable agent container. Panic persists in SQLite, aborts model connections and kills the worker's process namespace, including shell jobs and subagents.
- Autonomous bounded cycles with clock/elapsed time, durable goals, working state, asynchronous local commands and concurrent bounded subagents.
- Explicit memory decisions, an automatically loaded bounded core, Hindsight semantic/temporal retrieval and fact extraction, an indexed local original record, and reusable skills. A durable outbox retries memory synchronization.
- Shared OpenRouter gateway for agent, subagents and Hindsight. Every request reserves money before dispatch; uncertain billing retains its reservation. The experiment stops admitting requests after a $10 lifetime budget. Provider prices are capped in the request. Subscription adapters are not enabled.
- Langfuse v4 via OpenTelemetry, separate traces for bounded operations, local durable event history, asynchronous telemetry.

This is a first experiment, not completion of all [functional requirements](docs/functional-requirements.md). Voice, native Codex/Claude adapters, general MCP integration and full capability parity are pending. Memory quality and long-term scaling require measurement; indexed storage and bounded prompts alone do not prove them. Agent motivations are seeded in its identity prompt and then interpreted by the model.

## Run

Requires Docker Engine with Compose 2.24.4+ and an OpenRouter key. The control API and Langfuse bind to localhost; reach them through SSH forwarding on a VPS. The first run starts stopped.

```sh
cp .env.example .env
# Fill every secret and verify current model prices. Never commit .env.
sh scripts/bootstrap.sh
sh scripts/ctl.sh status
sh scripts/ctl.sh resume
sh scripts/ctl.sh send experiment Alice "Hello"
sh scripts/ctl.sh outbox
sh scripts/ctl.sh panic
```

The deployed controller alone holds the owner token, provider key and Docker socket. The worker receives a scoped runtime token, a writable workspace and no host mounts or owner credentials. The Docker socket makes the controller privileged; keep this service private. `/panic` stops managed execution, but cannot undo previous actions or guarantee cancellation of computation already accepted by an external model provider. Its financial reservation remains held on uncertain cancellation.

```sh
ssh -L 3000:127.0.0.1:3000 -L 8787:127.0.0.1:8787 root@YOUR_VPS
# Langfuse: http://localhost:3000 ; initial account: owner@ai.local
# Owner password is in the server's .env, not in this repository.
```

HTTP owner interface: `GET /status`, `/events`, `/outbox`; `POST /inbox`, `/panic`, `/resume` with bearer owner token. `/inbox` accepts `{ "id": "optional-idempotency-key", "chat": "chat-id", "sender": "name", "body": "text" }`. Owner messages containing exactly `/panic` or `/resume` are intercepted before blocked-chat checks. No unauthenticated inbox is exposed.

```sh
node --test
```

No npm dependencies in the core. Node.js 24 uses built-in SQLite and fetch. Full requirements and design: [requirements](docs/functional-requirements.md), [architecture](docs/architecture.md), [experiment](docs/first-experiment.md).

## Deployment notes

Start the control plane with the stopped worker container already created. `bootstrap.sh` does this. Worker restart is disabled; the controller reconciles its persisted panic state on restart. Failed container termination returns an error while leaving the panic latch set; inspect Docker before resuming.

Volumes contain private runtime data and must be backed up separately. The $10 gateway budget is lifetime committed usage for this installation, not an account-wide OpenRouter limit. Other applications using the provider key keep their own accounting. Changing or deleting the budget database resets this protection. Unknown or interrupted calls are conservatively charged their full reservation locally.

The Langfuse Compose file is vendored from the [official repository](https://github.com/langfuse/langfuse), with local overrides for credentials, versions, port binding and memory. See [third-party notices](THIRD_PARTY.md). The VPS experiment uses 4 vCPU / 8 GB RAM; memory peaks should be watched before increasing concurrency.
