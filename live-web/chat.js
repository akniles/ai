import { $ } from "./ui.js";

export function setupSteering() {
  const field = $("chat-input");
  const form = $("chat-form");
  const status = $("chat-status");
  let sending = false;
  let pending;
  let ready = false;

  function show(message) {
    status.textContent = message;
    status.hidden = !message;
  }

  field.addEventListener("input", () => {
    if (!sending) show("");
  });
  field.addEventListener("keydown", event => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    if (!field.value.trim()) return;
    event.preventDefault();
    if (!event.repeat && !sending) form.requestSubmit();
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const draft = field.value;
    const body = draft.trim();
    if (!body || sending) return;
    if (!pending || pending.body !== body) pending = { id: crypto.randomUUID(), body };
    sending = true;
    show("Sending…");
    try {
      if (!ready) {
        const session = await fetch("/api/chat", {
          cache: "no-store",
          signal: AbortSignal.timeout(10_000),
        });
        if (!session.ok) throw new Error("Could not connect. Try again.");
        ready = true;
      }
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(pending),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        if ([401, 403].includes(response.status)) {
          ready = false;
          throw new Error("This browser cannot send messages.");
        }
        throw new Error("Could not send. Try again.");
      }
      if (field.value === draft) field.value = "";
      pending = null;
      show("Sent");
    } catch (error) {
      show(error.message);
    } finally {
      sending = false;
    }
  });
}
