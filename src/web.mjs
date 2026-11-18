import http from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { chatSession } from "./web-chat.mjs";
const files = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/chat.css": ["chat.css", "text/css; charset=utf-8"],
};
export function createWeb(e = process.env) {
  const server = http.createServer(async (req, res) => {
    const headers = {
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
      "content-security-policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    };
    const send = (status, data, extra = {}) =>
      res
        .writeHead(status, {
          ...headers,
          "content-type": "application/json",
          "cache-control": "no-store",
          ...extra,
        })
        .end(JSON.stringify(data));
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      const upstream = async (target, token, body) =>
        fetch(`${e.CONTROL_URL ?? "http://control:8787"}${target}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(10000),
        });
      if (path === "/api/chat" && ["GET", "POST"].includes(req.method)) {
        if (!e.WEB_CHAT_TOKEN)
          return send(503, { error: "Chat temporarily unavailable" });
        const session = chatSession(req.headers.cookie, e.WEB_CHAT_TOKEN);
        if (req.method === "POST") {
          let origin;
          try {
            origin = new URL(req.headers.origin);
          } catch {}
          if (
            !origin ||
            !["https:", "http:"].includes(origin.protocol) ||
            origin.host !== req.headers.host ||
            session.cookie
          )
            return send(403, {
              error: "Open this website before sending a message",
            });
          if (req.headers["content-type"]?.split(";")[0] !== "application/json")
            return send(415, { error: "JSON required" });
          let raw = "";
          for await (const chunk of req) {
            raw += chunk;
            if (Buffer.byteLength(raw) > 16000)
              return send(413, { error: "Message too large" });
          }
          let body;
          try {
            body = JSON.parse(raw);
          } catch {
            return send(400, { error: "Invalid message" });
          }
          const r = await upstream("/website/chat", e.WEB_CHAT_TOKEN, {
            chat: session.chat,
            id: body?.id,
            body: body?.body,
          });
          return send(
            r.status,
            await r.json(),
            r.headers.has("retry-after")
              ? { "retry-after": r.headers.get("retry-after") }
              : {},
          );
        }
        const r = await upstream(
          `/website/chat?chat=${encodeURIComponent(session.chat)}`,
          e.WEB_CHAT_TOKEN,
        );
        return send(
          r.status,
          await r.json(),
          session.cookie ? { "set-cookie": session.cookie } : {},
        );
      }
      if (req.method !== "GET") {
        res.writeHead(405, headers).end();
        return;
      }
      if (path === "/api/live" || /^\/api\/traces\/[a-f0-9]{32}$/.test(path)) {
        const target =
          path === "/api/live" ? "/public" : path.replace("/api/", "/public/");
        const r = await upstream(target, e.PUBLIC_VIEW_TOKEN);
        if (!r.ok) throw new Error("Agent feed unavailable");
        const data = await r.json();
        if (path === "/api/live") {
          data.linkedin = e.LINKEDIN_URL ?? null;
          data.langfuse = e.LANGFUSE_PUBLIC_URL ?? null;
        }
        return send(200, data);
      }
      if (!files[path]) {
        res.writeHead(404, headers).end("Not found");
        return;
      }
      const [file, type] = files[path],
        data = await readFile(new URL(`../web/${file}`, import.meta.url));
      res
        .writeHead(200, {
          ...headers,
          "content-type": type,
          "cache-control": "public, max-age=60",
        })
        .end(data);
    } catch {
      return send(503, { error: "Temporarily unavailable. Please try again." });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  createWeb().listen(Number(process.env.PORT ?? 8080), "0.0.0.0", () =>
    console.log("Agent website listening"),
  );
