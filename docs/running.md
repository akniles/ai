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
sh scripts/ctl.sh status
sh scripts/ctl.sh resume
sh scripts/ctl.sh send experiment Alice "Hello"
sh scripts/ctl.sh outbox
sh scripts/ctl.sh panic
node --test
```

First installation starts stopped. `/panic` persists its latch, aborts queued/active model calls and stops the worker container with its managed processes. `/resume` is owner-only. Panic cannot undo previous effects or recall computation already accepted by an external provider. The harness reconciles the saved state after restart.

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

Langfuse is the only source of production prompts and tool definitions. Edit them there, or send a native Langfuse JSON payload to the API script:

```sh
sh scripts/compose.sh exec -T control node scripts/publish-prompts.mjs < update.json
```

The script posts the payload directly to Langfuse, which handles versions and labels. It has no local prompt registry, conflict checks or extra publishing parameters. `examples/identity.json` illustrates the native payload, including `config.tools`, and is never loaded automatically. Include `labels: ["production"]` to activate a version.

Each work period reads four prompts from native `production` labels: `ai-identity`, `ai-goal-selection`, `ai-subagent-task` (with `{{task}}`) and `ai-invocation`. Identity's `config.tools` is the OpenAI function-tool array: names, descriptions and JSON argument schemas. Code implements the tools; Langfuse config chooses which ones to expose. Context is passed directly as JSON. No manifest, prompt cache, local tool-description registry or fallback text is used. If Langfuse is unavailable, the call fails visibly and the worker retries later. Observations record the versions actually used.

HTTP owner API: `GET /status`, `/events`, `/outbox`; `POST /inbox`, `/panic`, `/resume`, with the owner bearer token. Inbox takes `{ "id": "optional-idempotency-key", "chat": "chat-id", "sender": "name", "body": "text" }`. Exact owner `/panic` and `/resume` messages bypass optional attention and blocked chats. The owner inbox is not exposed publicly.

The website now provides anonymous chat through `GET/POST /api/chat`. A signed Secure/HttpOnly cookie selects the visitor's conversation; the browser cannot supply another chat ID. The web service holds a separate `WEB_CHAT_TOKEN`, which can only deliver visitor messages and read those conversations, with no owner/runtime permissions. On an existing installation, generate this new secret in the server `.env` before updating Compose. Visitor `/panic` and `/resume` are ordinary text. Replies appear only after the agent chooses `inbox_reply`; there is no automatic assistant response. Messages may appear in public tool logs. Each message is limited to 2,000 characters; persistent limits are 6/minute and 60/day per chat, plus 12/minute and 120/hour across the site. Reloading the service does not reset these limits.

Notifications can wake an idle worker, with at least 15 seconds between work periods. They do not interrupt an active model call or bypass provider-error backoff. Muted/blocked chats do not wake the agent. The public state shows a pause and the scheduled next observation; a goal created after completing the preceding goal starts within 15 seconds instead of inheriting its old pause. Each goal column initially shows its latest goal and can expand to its latest ten.

The harness holds the Docker socket and provider credentials; keep it private. The worker has a scoped runtime token, a writable workspace and no host credential mounts. Back up persistent volumes separately. The experiment uses 4 vCPU / 8 GB RAM. The Langfuse stack is vendored from its [official repository](https://github.com/langfuse/langfuse); see [notices](../THIRD_PARTY.md).

Voice, general MCP support and full Codex/Claude capability parity are pending. Memory quality and scaling over time still require measurement. Initial drives are seeded in the identity prompt; the model chooses its activity.
