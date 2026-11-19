import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { Store } from "../src/store.mjs";
import { createControl } from "../src/control.mjs";
import { createWeb } from "../src/web.mjs";
import { WebChat, chatSession } from "../src/web-chat.mjs";
import { Client } from "../src/client.mjs";
import { waitForWake, wakePlan } from "../src/worker.mjs";

async function app(t) {
  const store = new Store(":memory:");
  const control = createControl({
    store,
    ownerToken: "owner",
    runtimeToken: "worker",
    publicToken: "viewer",
    webChatToken: "chat-secret",
    gateway: { active: new Set(), abort() {} },
    supervisor: { async stop() {}, async start() {} },
    memory: {},
  });
  control.server.listen(0, "127.0.0.1");
  await once(control.server, "listening");
  const url = `http://127.0.0.1:${control.server.address().port}`;
  const web = createWeb({
    CONTROL_URL: url,
    PUBLIC_VIEW_TOKEN: "viewer",
    WEB_CHAT_TOKEN: "chat-secret",
  });
  web.listen(0, "127.0.0.1");
  await once(web, "listening");
  t.after(() => {
    for (const s of [web, control.server]) {
      s.closeAllConnections();
      s.close();
    }
    store.close();
  });
  return {
    store,
    origin: `http://127.0.0.1:${web.address().port}`,
    runtime: new Client(url, "worker"),
    chat: new Client(url, "chat-secret"),
    viewer: new Client(url, "viewer"),
  };
}
async function visitor(origin) {
  const r = await fetch(`${origin}/api/chat`),
    cookie = r.headers.get("set-cookie").split(";")[0];
  assert.match(r.headers.get("set-cookie"), /HttpOnly; Secure; SameSite=Lax/);
  return {
    cookie,
    get: () =>
      fetch(`${origin}/api/chat`, { headers: { cookie } }).then((r) =>
        r.json(),
      ),
    send: (body, extra = {}) =>
      fetch(`${origin}/api/chat`, {
        method: "POST",
        headers: { cookie, origin, "content-type": "application/json" },
        body: JSON.stringify({ id: randomUUID(), body, ...extra }),
      }),
  };
}

test("website chat delivers optional input, isolates visitors, exposes only chosen replies and cannot execute owner commands", async (t) => {
  const { store, origin, runtime, chat, viewer } = await app(t);
  store.set("panic", false);
  const alice = await visitor(origin),
    bob = await visitor(origin);
  assert.equal((await alice.send("hello from Alice")).status, 202);
  assert.equal((await bob.get()).messages.length, 0);
  const context = await runtime.request("/runtime/context");
  assert.equal(context.notifications.length, 1);
  assert.doesNotMatch(JSON.stringify(context), /hello from Alice/);
  const incoming = await runtime.action("inbox_read", {
    id: context.notifications[0].id,
  });
  assert.equal(incoming.body, "hello from Alice");
  const bobChat = chatSession(bob.cookie, "chat-secret").chat;
  // A browser cannot choose the destination chat or the sender.
  assert.equal(
    (await alice.send("/panic", { chat: bobChat, sender: "Owner" })).status,
    202,
  );
  assert.equal(store.get("panic"), false);
  assert.equal((await bob.get()).messages.length, 0);
  assert.equal(
    (await alice.get()).messages.filter((m) => m.direction === "out").length,
    0,
  );
  await runtime.action("inbox_reply", {
    chat: incoming.chat,
    body: "A reply I chose to send",
  });
  assert.equal(
    (await alice.get()).messages.at(-1).body,
    "A reply I chose to send",
  );
  assert.equal((await bob.get()).messages.length, 0);
  for (const path of ["/panic", "/resume", "/status", "/runtime/context"])
    await assert.rejects(chat.request(path), /Forbidden/);
  await assert.rejects(
    viewer.request(`/website/chat?chat=${incoming.chat}`),
    /Forbidden/,
  );
  await runtime.action("chat_set", { chat: incoming.chat, blocked: true });
  assert.equal((await alice.send("blocked")).status, 403);
  assert.equal((await alice.get()).blocked, true);
  store.set("panic", true);
  assert.equal((await bob.send("/resume")).status, 202);
  assert.equal(store.get("panic"), true);
});

test("website rejects cross-origin writes, invalid sessions, oversized messages and duplicate delivery", async (t) => {
  const { origin } = await app(t),
    alice = await visitor(origin);
  const send = (headers, body) =>
    fetch(`${origin}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const body = { id: randomUUID(), body: "one delivery" };
  assert.equal(
    (await send({ origin: "https://evil.invalid", cookie: alice.cookie }, body))
      .status,
    403,
  );
  assert.equal(
    (await send({ origin, cookie: "ai_chat=forged" }, body)).status,
    403,
  );
  assert.equal((await alice.send("x".repeat(2001))).status, 400);
  assert.equal(
    (await send({ origin, cookie: alice.cookie }, body)).status,
    202,
  );
  assert.equal(
    (await send({ origin, cookie: alice.cookie }, body)).status,
    202,
  );
  assert.equal((await alice.get()).messages.length, 1);
  for (let i = 0; i < 5; i++)
    assert.equal((await alice.send(`message ${i}`)).status, 202);
  const limited = await alice.send("too many");
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
});

test("public-chat rate limits survive service recreation and include a global limit", () => {
  const store = new Store(":memory:"),
    now = 3600000000000;
  try {
    for (let i = 0; i < 12; i++)
      new WebChat(store).receive(
        {
          chat: `web:${i.toString(16).padStart(32, "0")}`,
          id: randomUUID(),
          body: "hello",
        },
        now,
      );
    assert.throws(
      () =>
        new WebChat(store).receive(
          { chat: `web:${"f".repeat(32)}`, id: randomUUID(), body: "hello" },
          now,
        ),
      (e) => e.status === 429,
    );
  } finally {
    store.close();
  }
});

test("notifications wake an idle worker; muted messages do not; a fresh goal cannot inherit an old hour-long pause", async (t) => {
  const { store, runtime } = await app(t);
  store.set("panic", false);
  const old = store.attentionVersion();
  store.chat("muted", undefined, true);
  store.receive({ chat: "muted", sender: "Visitor", body: "silent" });
  assert.equal(store.attentionVersion(), old);
  const waiting = waitForWake(runtime, {
    delay: 2000,
    attentionVersion: old,
    pollMs: 10,
    minWait: 0,
  });
  store.receive({ chat: "new", sender: "Visitor", body: "optional" });
  assert.equal(await waiting, "notification");
  assert.equal(wakePlan({ next_wake_seconds: 3600 }).delay, 3600000);
  assert.equal(
    wakePlan({ next_wake_seconds: 3600 }, { freshGoal: true }).delay,
    15000,
  );
});

test("public goals include the latest ten in each status rather than letting one status crowd out the others", async (t) => {
  const { store, viewer } = await app(t);
  for (const status of ["active", "done", "abandoned"])
    for (let i = 0; i < 15; i++) store.goal(`${status} ${i}`, status);
  const feed = await viewer.request("/public");
  for (const status of ["active", "done", "abandoned"]) {
    const goals = feed.goals.filter((g) => g.status === status);
    assert.equal(goals.length, 10);
    assert.ok(goals.some((g) => g.text === `${status} 14`));
    assert.ok(!goals.some((g) => g.text === `${status} 0`));
  }
});
