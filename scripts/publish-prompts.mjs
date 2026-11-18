// Forward a native Langfuse prompt update from stdin.
import { readFileSync } from "node:fs";

const { LANGFUSE_URL, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY } = process.env;
const authorization = `Basic ${Buffer.from(`${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}`).toString("base64")}`;
const response = await fetch(`${LANGFUSE_URL}/api/public/v2/prompts`, {
  method: "POST",
  headers: { authorization, "content-type": "application/json" },
  body: readFileSync(0, "utf8"),
  signal: AbortSignal.timeout(10000),
});
if (!response.ok) throw new Error(`Langfuse: HTTP ${response.status}`);
const { name, version } = await response.json();
console.log(`${name}: production v${version}`);
