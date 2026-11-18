import { $, el, date } from "./ui.js";
let chatSnapshot = "",
  chatReady = false,
  chatBlocked = false,
  chatSending = false,
  pendingMessage = null;

export function startChat(isStopped) {
  async function refreshChat() {
    try {
      const r = await fetch("/api/chat", { cache: "no-store" });
      if (!r.ok) throw new Error("Chat reconnecting…");
      const chat = await r.json();
      chatReady = true;
      chatBlocked = chat.blocked;
      const next = JSON.stringify(chat);
      if (next !== chatSnapshot) {
        chatSnapshot = next;
        const box = $("chat-messages"),
          atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
        box.replaceChildren();
        box.hidden = !chat.messages.length;
        for (const message of chat.messages) {
          const bubble = el(
            "article",
            `chat-message ${message.direction === "out" ? "from-agent" : "from-you"}`,
          );
          bubble.append(
            el("p", "chat-author", message.direction === "out" ? "ai" : "You"),
            el("p", "chat-body", message.body),
            el(
              "p",
              "chat-time",
              `${date(message.time)}${message.direction === "in" ? (message.read ? " · Read" : " · Delivered") : ""}`,
            ),
          );
          box.append(bubble);
        }
        if (atBottom || chatSending) box.scrollTop = box.scrollHeight;
      }
      if (!chatSending)
        $("chat-status").textContent = chat.blocked
          ? "The agent has blocked this chat."
          : chat.muted
            ? "The agent has muted this chat."
            : isStopped()
              ? "Agent stopped. Messages are saved for later."
              : chat.messages.length
                ? "The agent chooses whether to reply."
                : "Say hello. A reply is its choice.";
    } catch (error) {
      if (!chatSending) $("chat-status").textContent = error.message;
    }
    $("chat-send").disabled = !chatReady || chatBlocked || chatSending;
  }
  $("chat-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = $("chat-input").value.trim();
    if (!body || !chatReady || chatBlocked || chatSending) return;
    if (!pendingMessage || pendingMessage.body !== body)
      pendingMessage = { id: crypto.randomUUID(), body };
    chatSending = true;
    $("chat-send").disabled = true;
    $("chat-status").textContent = "Sending…";
    try {
      const r = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(pendingMessage),
        }),
        result = await r.json();
      if (!r.ok)
        throw new Error(
          result.reason === "blocked"
            ? "The agent has blocked this chat."
            : (result.error ?? "Could not send. Please retry."),
        );
      $("chat-input").value = "";
      pendingMessage = null;
      await refreshChat();
      $("chat-status").textContent =
        "Delivered. The agent decides what happens next.";
    } catch (error) {
      $("chat-status").textContent = error.message;
    } finally {
      chatSending = false;
      $("chat-send").disabled = !chatReady || chatBlocked;
    }
  });

  refreshChat();
  setInterval(() => {
    if (!document.hidden && !chatSending) refreshChat();
  }, 5000);
}
