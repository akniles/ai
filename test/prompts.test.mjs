import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { Prompts, promptNames, compilePrompt } from "../src/prompts.mjs";
import { testPrompts } from "../fixtures/prompts.mjs";

test("runtime reads current production prompts on every work period and reports Langfuse errors", async (t) => {
  let version = 1;
  let offline = false;
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    requests.push(url);
    if (offline) return res.writeHead(503).end();
    const name = url.pathname.split("/").at(-1);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ...testPrompts.prompts[name], version }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const prompts = new Prompts({
    url: `http://127.0.0.1:${server.address().port}`,
    publicKey: "test",
    secretKey: "test",
  });

  const first = await prompts.bundle();
  assert.equal(first.prompts["ai-identity"].version, 1);
  assert.deepEqual(
    first.prompts["ai-identity"].config,
    testPrompts.prompts["ai-identity"].config,
  );
  assert.equal(requests.length, promptNames.length);
  assert.ok(
    requests.every((url) => url.searchParams.get("label") === "production"),
  );
  assert.match(
    compilePrompt(first, "ai-subagent-task", {
      task: "{{data stays data}}",
    }),
    /\{\{data stays data\}\}/,
  );
  version = 2;
  assert.equal((await prompts.bundle()).prompts["ai-identity"].version, 2);
  offline = true;
  await assert.rejects(prompts.bundle(), /HTTP 503/);
});

test("publisher forwards the native prompt payload, including identity tool config", async (t) => {
  let received;
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received = { method: req.method, path: req.url, body: JSON.parse(body) };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ name: "ai-identity", version: 7 }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const child = spawn(process.execPath, ["scripts/publish-prompts.mjs"], {
    env: {
      ...process.env,
      LANGFUSE_URL: `http://127.0.0.1:${server.address().port}`,
      LANGFUSE_PUBLIC_KEY: "test",
      LANGFUSE_SECRET_KEY: "test",
    },
    windowsHide: true,
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const update = {
    name: "ai-identity",
    type: "text",
    prompt: "A deliberately updated identity.",
    config: testPrompts.prompts["ai-identity"].config,
    labels: ["production"],
  };
  child.stdin.end(JSON.stringify(update));
  assert.equal((await once(child, "close"))[0], 0, output);
  assert.equal(received.method, "POST");
  assert.deepEqual(received.body, update);
  assert.match(output, /production v7/);
});
