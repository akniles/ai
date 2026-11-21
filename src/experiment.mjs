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
const promptNames = ['ai-poc-system', 'ai-poc-turn-1', 'ai-poc-turn-2'];
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
const intAttr = (key, value) => ({ key, value: { intValue: String(value) } });
const langfuseAuth = 'Basic ' + Buffer.from(LANGFUSE_PUBLIC_KEY + ':' + LANGFUSE_SECRET_KEY).toString('base64');
async function loadPrompt(name) {
  const url = new URL('/api/public/v2/prompts/' + encodeURIComponent(name), LANGFUSE_URL);
  url.searchParams.set('label', 'production');
  const result = await fetch(url, {
    headers: { Authorization: langfuseAuth }, redirect: 'error', signal: AbortSignal.timeout(5000),
  });
  if (!result.ok) throw new Error('Production prompt unavailable');
  const record = await result.json();
  if (record.type !== 'text' || !record.labels?.includes('production') ||
      typeof record.prompt !== 'string' || !record.prompt.trim() ||
      record.prompt.length > 4_000 || !Number.isInteger(record.version)) {
    throw new Error('Invalid production prompt');
  }
  return { name, version: record.version, text: record.prompt };
}
const spanId = () => randomBytes(8).toString('hex');
const parentSpanId = spanId();
async function exportTrace() {
  if (!spans.length) return;
  const body = { resourceSpans: [{ resource: { attributes: [attr('service.name', 'ai-poc')] }, scopeSpans: [{
    scope: { name: 'ai-poc' },
    spans: [{
      traceId, spanId: parentSpanId, name: 'Pi · tile puzzle', kind: 1, startTimeUnixNano: traceStarted,
      endTimeUnixNano: stamp(), attributes: [
        attr('langfuse.observation.type', 'agent'), attr('langfuse.trace.name', 'Pi · tile puzzle'),
        attr('session.id', traceId), attr('langfuse.environment', 'poc'),
        attr('langfuse.observation.input', 'Two turns in one Pi transcript'),
        attr('langfuse.observation.output', JSON.stringify({ status, turns: events.length })),
      ],
    }, ...spans],
  }] }] };
  const res = await fetch(new URL('/api/public/otel/v1/traces', LANGFUSE_URL), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5_000),
    headers: {
      Authorization: langfuseAuth,
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
  const [system, ...prompts] = await Promise.all(promptNames.map(loadPrompt));
  if (stopped) throw new Error('Stopped');
  let firstTokenAt;
  agent = new Agent({
    initialState: { model: { ...model, baseUrl: base }, thinkingLevel: 'minimal', tools: [],
      systemPrompt: system.text },
    streamFn: (m, context, options) => models.streamSimple(m, context, {
      ...options, apiKey: accessToken, maxTokens: 256, maxRetries: 0,
      signal: AbortSignal.any([options?.signal, AbortSignal.timeout(30_000)].filter(Boolean)),
    }),
  });
  agent.subscribe(event => {
    if (!firstTokenAt && event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      firstTokenAt = new Date().toISOString();
    }
  });
  await publish('Running');
  for (const [index, prompt] of prompts.entries()) {
    if (stopped) break;
    const startTimeUnixNano = stamp();
    firstTokenAt = undefined;
    let failed = false;
    try { await agent.prompt(prompt.text); } catch { failed = true; }
    const message = agent.state.messages.at(-1);
    const outcome = !failed && !stopped && message?.role === 'assistant' && message.stopReason === 'stop'
      ? message.content.filter(x => x.type === 'text').map(x => x.text).join('').trim().slice(0, 1200) : '';
    const usage = message?.role === 'assistant' ? message.usage : undefined;
    spans.push({
      traceId, parentSpanId, spanId: spanId(), name: 'Turn ' + (index + 1), kind: 1,
      startTimeUnixNano, endTimeUnixNano: stamp(), status: { code: outcome || stopped ? 1 : 2 },
      attributes: [
        attr('langfuse.observation.type', 'generation'), attr('langfuse.observation.model.name', model.id),
        attr('langfuse.environment', 'poc'), attr('langfuse.observation.prompt.name', prompt.name),
        intAttr('langfuse.observation.prompt.version', prompt.version),
        attr('langfuse.observation.metadata.system_prompt', system.name + '@' + system.version),
        attr('langfuse.observation.input', JSON.stringify({
          system: system.text, previousTurns: events.map((e, i) => ({ user: prompts[i].text, assistant: e.outcome })),
          user: prompt.text,
        })),
        attr('langfuse.observation.output', outcome || (stopped ? 'Cancelled' : 'No usable report')),
        ...(usage ? [attr('langfuse.observation.usage_details', JSON.stringify({
          input: usage.input, output: usage.output, total: usage.totalTokens, input_cached: usage.cacheRead,
        }))] : []),
        ...(firstTokenAt ? [attr('langfuse.observation.completion_start_time', firstTokenAt)] : []),
        ...(!outcome && !stopped ? [attr('langfuse.observation.level', 'ERROR')] : []),
      ],
    });
    if (stopped) break;
    if (!outcome) throw new Error('Model did not produce a complete report');
    events.push({ turn: index + 1, goal: 'Solve the tile puzzle',
      action: index ? 'Continue from the previous board' : 'Choose the first move', outcome });
    await publish('Running');
  }
} catch {
  status = stopped ? 'Stopped' : 'Stopped · run failed';
  process.exitCode = stopped ? 0 : 1;
  if (!stopped) console.error('PoC did not complete (session, model, or output unavailable).');
}
try { await publish(status); } catch { console.error('Could not publish stopped status.'); process.exitCode = 1; }
try { await exportTrace(); if (spans.length) console.log('Langfuse trace: ' + traceId); } catch { console.error('Langfuse trace delivery failed.'); process.exitCode = 1; }
