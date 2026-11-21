import { randomBytes } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';
import { Agent } from '@earendil-works/pi-agent-core';
import { createModels, hasApi } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';

const { PUBLIC_RUN_FILE: outputFile, PI_MODEL, LANGFUSE_URL, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY } = process.env;
if (!outputFile || !LANGFUSE_URL || !LANGFUSE_PUBLIC_KEY || !LANGFUSE_SECRET_KEY) {
  console.error('Set the public snapshot and Langfuse configuration in the private launcher.');
  process.exit(2);
}

const traceId = randomBytes(16).toString('hex');
const events = [];
const spans = [];
const traceStarted = stamp();
let stopped = false;
let agent;

function stamp() {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

async function publish(status) {
  const temp = outputFile + '.' + traceId + '.tmp';
  await writeFile(temp, JSON.stringify({ mode: 'live', status, events }), { mode: 0o644, flag: 'wx' });
  await rename(temp, outputFile);
}

const stop = () => { stopped = true; agent?.abort(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

const attr = (key, text) => ({ key, value: { stringValue: String(text) } });
const spanId = () => randomBytes(8).toString('hex');
const parentSpanId = spanId();
async function exportTrace() {
  if (!spans.length) return;
  const body = { resourceSpans: [{ resource: { attributes: [attr('service.name', 'ai-poc')] }, scopeSpans: [{
    scope: { name: 'ai-poc' },
    spans: [{
      traceId, spanId: parentSpanId, name: 'ai-poc', kind: 1, startTimeUnixNano: traceStarted,
      endTimeUnixNano: stamp(), attributes: [attr('langfuse.observation.output', JSON.stringify(events))],
    }, ...spans],
  }] }] };
  const res = await fetch(new URL('/api/public/otel/v1/traces', LANGFUSE_URL), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5_000),
    headers: {
      Authorization: 'Basic ' + Buffer.from(LANGFUSE_PUBLIC_KEY + ':' + LANGFUSE_SECRET_KEY).toString('base64'),
      'Content-Type': 'application/json', 'x-langfuse-ingestion-version': '4',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok || (await res.json()).partialSuccess?.rejectedSpans > 0) {
    throw new Error('Langfuse rejected trace');
  }
}

let status = 'Stopped';
try {
  // Anonymous stdin carries only the existing grant's short-lived access token.
  let accessToken = '';
  for await (const chunk of process.stdin.setEncoding('utf8')) {
    accessToken += chunk;
    if (accessToken.length > 16_384) throw new Error('Invalid credential input');
  }
  accessToken = accessToken.trim();
  if (!accessToken || stopped) throw new Error('No access token supplied');
  const base = 'https://api.openai.com/v1';
  const res = await fetch(base + '/models', {
    headers: { Authorization: 'Bearer ' + accessToken },
    signal: AbortSignal.timeout(8_000), redirect: 'error',
  });
  if (!res.ok) throw new Error('Existing session was not accepted');
  const models = createModels();
  models.setProvider(openaiProvider());
  const allowed = (await res.json()).models.filter(x => x.visibility === 'list');
  const candidates = PI_MODEL ? [PI_MODEL] : ['gpt-6.1-terra', 'gpt-5.4-mini', 'gpt-5.1-codex-mini'];
  const model = candidates.filter(id => allowed.some(x => x.slug === id))
    .map(id => models.getModel('openai', id)).find(x => x && hasApi(x, 'openai-responses'));
  if (!model || stopped) throw new Error('No eligible small conversational model');
  agent = new Agent({
    initialState: { model: { ...model, baseUrl: base }, thinkingLevel: 'minimal', tools: [],
      systemPrompt: 'You are solving a small sliding tile puzzle. Describe your chosen move and the resulting board in one brief public report. Stay inside the puzzle.' },
    streamFn: (m, context, options) => models.streamSimple(m, context, {
      ...options, apiKey: accessToken, maxTokens: 256, maxRetries: 0,
      signal: AbortSignal.any([options?.signal, AbortSignal.timeout(30_000)].filter(Boolean)),
    }),
  });
  await publish('Running');
  const prompts = [
    'Make the first legal move from this 3×3 board: 1 2 3 / 4 5 6 / _ 7 8. The goal is 1 2 3 / 4 5 6 / 7 8 _.',
    'Use the board you reported on the previous turn. Choose the next legal move and say whether the goal is reached.',
  ];
  for (const [index, input] of prompts.entries()) {
    if (stopped) break;
    const startTimeUnixNano = stamp();
    await agent.prompt(input);
    if (stopped) break;
    const message = agent.state.messages.at(-1);
    const outcome = message?.role === 'assistant' && message.stopReason === 'stop'
      ? message.content.filter(x => x.type === 'text').map(x => x.text).join('').trim().slice(0, 1200) : '';
    spans.push({
      traceId, parentSpanId, spanId: spanId(), name: 'pi.turn', kind: 1, startTimeUnixNano, endTimeUnixNano: stamp(),
      attributes: [
        attr('langfuse.observation.type', 'generation'), attr('langfuse.observation.model.name', model.id),
        attr('langfuse.observation.input', JSON.stringify({ input, previousReport: events.at(-1)?.outcome })),
        attr('langfuse.observation.output', outcome || 'No usable report'),
      ],
    });
    if (!outcome) throw new Error('Model did not produce a complete report');
    events.push({ turn: index + 1, goal: 'Solve the tile puzzle', action: input, outcome });
    await publish('Running');
  }
} catch {
  status = stopped ? 'Stopped' : 'Stopped · run failed';
  process.exitCode = stopped ? 0 : 1;
  if (!stopped) console.error('PoC did not complete (session, model, or output unavailable).');
}
try { await publish(status); } catch { console.error('Could not publish stopped status.'); process.exitCode = 1; }
try { await exportTrace(); } catch { console.error('Langfuse trace delivery failed.'); process.exitCode = 1; }
