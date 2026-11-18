# Run and operate

The experiment uses Luna through official Sign in with ChatGPT, Hindsight for memory, and self-hosted Langfuse. The public website reads a limited projection of runtime state and Langfuse observations. Langfuse itself requires an account; registration is disabled.

Requires Docker Engine with Compose 2.24.4+ and Node.js 24 for local setup/tests.

```sh
node scripts/generate-env.mjs
node scripts/login-chatgpt.mjs
```

Before moving credentials, follow OpenAI's [self-hosted VM instructions](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms). Assign the VM its own host ID and let only that VM refresh its session. Put credentials at `.local/auth/chatgpt-credentials.json` with mode 0600; the control service alone mounts this directory. The login helper creates `.local/chatgpt-credentials.json` locally.

Set the `ai` app limit to **50%** in [ChatGPT usage settings](https://chatgpt.com/settings/usage), disable credit fallback, then set `CHATGPT_PLAN_CAP_CONFIRMED=true`, `CHATGPT_PLAN_CAP_PERCENT=50` and `MODEL_ENABLED=true` in `.env`. All agent, memory and subagent inference uses that same app. The runtime refuses calls without confirmation of the provider-enforced cap. API billing is a separate optional adapter; it is off in this experiment.

```sh
sh scripts/bootstrap.sh
sh scripts/compose.sh exec -T control node scripts/publish-prompts.mjs
sh scripts/ctl.sh status
sh scripts/ctl.sh resume
sh scripts/ctl.sh send experiment Alice "Hello"
sh scripts/ctl.sh outbox
sh scripts/ctl.sh panic
node --test
```

First installation starts stopped. `/panic` persists its latch, aborts queued/active model calls and stops the worker container with its managed processes. `/resume` is owner-only. Panic cannot undo previous effects or recall computation already accepted by an external provider. The controller reconciles the saved state after restart.

Control and Langfuse bind to localhost. For private access:

```sh
ssh -L 3000:127.0.0.1:3000 -L 8787:127.0.0.1:8787 root@YOUR_VPS
```

Langfuse's initial account is `owner@ai.local`; its generated password is in the server `.env`. Signup stays disabled.

For trusted HTTPS directly on an IPv4 address, run as root on the VPS:

```sh
sh scripts/setup-https.sh YOUR_PUBLIC_IPV4
```

This provisions Nginx on 80/443, authenticated Langfuse on 8443, and a six-hour systemd renewal check. It uses Let's Encrypt's [short-lived IP certificates](https://letsencrypt.org/2026/03/11/shorter-certs-certbot). Ports 80/443/8443 must be reachable. The web backend moves to localhost:8080; its Docker address stays private. Certificates stay in ignored `.local/https/letsencrypt`. Verify renewal with `systemctl start ai-cert-renew.service` and `systemctl show ai-cert-renew.service -p Result`.

Cloudflare Tunnel is another option: route it to `http://langfuse-web:3000`, set `NEXTAUTH_URL` to its HTTPS origin, and recreate `langfuse-web` and `web`. Quick Tunnel addresses are temporary; use a named tunnel and domain for a permanent address.

`LINKEDIN_URL` sets the contact link. `PUBLIC_VIEW_TOKEN` is a separate read-only token held server-side. Activity comes from Langfuse Observations API v2. Every goal and tool input/output is public; opening a tool shows input/output. Known credentials and common secret formats are redacted, but masking cannot guarantee confidentiality. Use test data, not sensitive messages or real credentials, in the agent workspace. Full model prompts remain in authenticated Langfuse. Memory-map publication is a display choice, not confidentiality: facts used in tools can appear in public logs. Goal completion and cancellation preserve history. Memory lines represent shared words, not semantic relations from Hindsight.

## Managed harness prompts

Source texts live in `prompts/`. Publish them to the VPS Langfuse project through its API:

```sh
sh scripts/compose.sh exec -T control node scripts/publish-prompts.mjs
```

The script updates changed prompts, reuses unchanged versions, and publishes `ai-harness-release` last. The runtime fetches that release's `production` label and then each member by its pinned version. This covers identity, goal selection, context/subagent templates, invocation and tool descriptions. A change is picked up within 60 seconds, or immediately by the script's owner-only cache refresh. Model observations record the prompt name/version and complete release versions.

The control service keeps the last successfully loaded bundle in SQLite. If Langfuse is unavailable, it uses that complete cached release. With no cached release it waits and retries; it does not substitute hidden hardcoded prompts. Publishing a partial update does not switch the active release. Never place credentials or private runtime facts in prompt source files.

HTTP owner API: `GET /status`, `/events`, `/outbox`; `POST /inbox`, `/panic`, `/resume`, with the owner bearer token. Inbox takes `{ "id": "optional-idempotency-key", "chat": "chat-id", "sender": "name", "body": "text" }`. Exact owner `/panic` and `/resume` messages bypass optional attention and blocked chats. There is no public inbox.

The controller holds the Docker socket and provider credentials; keep it private. The worker has a scoped runtime token, a writable workspace and no host credential mounts. Back up persistent volumes separately. The experiment uses 4 vCPU / 8 GB RAM. The Langfuse stack is vendored from its [official repository](https://github.com/langfuse/langfuse); see [notices](../THIRD_PARTY.md).

Voice, general MCP support and full Codex/Claude capability parity are pending. Memory quality and scaling over time still require measurement. Initial drives are seeded in the identity prompt; the model chooses its activity.
