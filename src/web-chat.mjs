import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const chatLimits = {
  messageLength: 2000,
  minute: 6,
  day: 60,
  globalMinute: 12,
  globalHour: 120,
};
export const validChat = (id) =>
  typeof id === "string" && /^web:[a-f0-9]{32}$/.test(id);
export class WebChat {
  constructor(store) {
    this.store = store;
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS chat_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL)",
    );
  }
  messages(chat) {
    if (!validChat(chat)) throw new Error("Invalid chat");
    const state = this.store.db
      .prepare("SELECT blocked,muted FROM chats WHERE id=?")
      .get(chat);
    return {
      messages: this.store.db
        .prepare(
          "SELECT id,body,time,direction,read FROM messages WHERE chat=? ORDER BY rowid DESC LIMIT 100",
        )
        .all(chat)
        .reverse(),
      blocked: !!state?.blocked,
      muted: !!state?.muted,
    };
  }
  receive({ chat, id, body }, now = Date.now()) {
    if (
      !validChat(chat) ||
      typeof id !== "string" ||
      !/^[a-f0-9-]{36}$/.test(id) ||
      typeof body !== "string" ||
      !body.trim() ||
      body.length > chatLimits.messageLength
    )
      throw new Error("Invalid message");
    const messageId = `${chat}:${id}`;
    if (
      this.store.db
        .prepare("SELECT id FROM messages WHERE id=? AND chat=?")
        .get(messageId, chat)
    )
      return { accepted: true, id: messageId, duplicate: true };
    if (
      this.store.db.prepare("SELECT blocked FROM chats WHERE id=?").get(chat)
        ?.blocked
    )
      return { accepted: false, reason: "blocked" };
    const buckets = [
      [chat, 60000, chatLimits.minute],
      [chat, 86400000, chatLimits.day],
      ["all", 60000, chatLimits.globalMinute],
      ["all", 3600000, chatLimits.globalHour],
    ].map(([key, window, limit]) => ({
      key: `${key}:${window}:${Math.floor(now / window)}`,
      expires: (Math.floor(now / window) + 1) * window,
      limit,
    }));
    const db = this.store.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const b of buckets)
        if (
          (db.prepare("SELECT count FROM chat_limits WHERE key=?").get(b.key)
            ?.count ?? 0) >= b.limit
        ) {
          const error = new Error(
            "Message limit reached. Please try again later.",
          );
          error.status = 429;
          error.retryAfter = Math.ceil((b.expires - now) / 1000);
          throw error;
        }
      for (const b of buckets)
        db.prepare(
          "INSERT INTO chat_limits VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1",
        ).run(b.key, b.expires);
      db.prepare("DELETE FROM chat_limits WHERE expires<=?").run(now);
      const result = this.store.receive({
        id: messageId,
        chat,
        sender: `Website visitor ${chat.slice(-4)}`,
        body: body.trim(),
      });
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

export function chatSession(cookie, secret) {
  if (!secret) throw new Error("Website chat is not configured");
  const sign = (id) =>
    createHmac("sha256", secret).update(`website-chat:${id}`).digest("hex");
  const value =
    cookie
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("ai_chat="))
      ?.slice(8) ?? "";
  const [existing, proof] = value.split(".");
  const valid =
    /^[a-f0-9]{32}$/.test(existing ?? "") &&
    /^[a-f0-9]{64}$/.test(proof ?? "") &&
    timingSafeEqual(Buffer.from(proof), Buffer.from(sign(existing)));
  const id = valid ? existing : randomBytes(16).toString("hex");
  return {
    chat: `web:${id}`,
    cookie: valid
      ? null
      : `ai_chat=${id}.${sign(id)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
  };
}
