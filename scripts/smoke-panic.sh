#!/bin/sh
# Run on the experiment VPS. Leaves the runtime stopped after destructive test activity.
set -eu
cd "$(dirname "$0")/.."
ctl() { sh scripts/ctl.sh "$@"; }
compose() { sh scripts/compose.sh "$@"; }
ctl resume
docker exec -d ai-worker node --input-type=module -e '
  import {Client} from "/app/src/client.mjs";
  import {Tools} from "/app/src/tools.mjs";
  const c=new Client(process.env.CONTROL_URL,process.env.RUNTIME_TOKEN);
  const t=new Tools(c,"/workspace");
  await t.execute("shell_start",{command:"while true; do date +%s%N > /workspace/panic-heartbeat; sleep 1; done",timeout_seconds:300});
  setInterval(()=>{},1000);
'
sleep 3
before=$(docker exec ai-worker cat /workspace/panic-heartbeat)
test -n "$before"
ctl panic
test "$(docker inspect -f '{{.State.Running}}' ai-worker)" = false
compose restart control
sleep 4
compose exec -T control node --input-type=module -e '
  import {Client} from "./src/client.mjs";
  const c=new Client("http://127.0.0.1:8787",process.env.OWNER_TOKEN);
  const s=await c.request("/status");
  if(!s.panic || s.activeCalls!==0)throw new Error("Panic did not persist");
  console.log("Persistent latch and zero active model calls verified");
'
test "$(docker inspect -f '{{.State.Running}}' ai-worker)" = false
after=$(docker run --rm -v ai_workspace:/data:ro --entrypoint cat ai-runtime:local /data/panic-heartbeat)
sleep 2
final=$(docker run --rm -v ai_workspace:/data:ro --entrypoint cat ai-runtime:local /data/panic-heartbeat)
test "$after" = "$final"
echo 'PASS: worker namespace stopped, managed heartbeat stopped, latch survived control restart.'
