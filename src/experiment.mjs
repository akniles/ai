import { randomBytes, randomUUID } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';
import { Agent } from '@earendil-works/pi-agent-core';
import { createModels, hasApi } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { createRootBridge } from './root-bridge.mjs';

const { PUBLIC_RUN_FILE: outputFile, PI_MODEL, LANGFUSE_URL } = process.env;
if (!outputFile || !LANGFUSE_URL) {
  console.error('Set the public snapshot and Langfuse configuration in the private launcher.');
  process.exit(2);
}

const traceId = randomBytes(16).toString('hex');
const events = [];
const spans = [];
const traceStarted = stamp();
const promptNames = ['ai-identity', 'ai-goal-selection', 'ai-invocation'];
const recentInputs = [];
let bridge;
let langfuseAuth;
let stopped = false;
let agent;
let pausePoll;

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
      traceId, spanId: parentSpanId, name: 'Pi · work session', kind: 1, startTimeUnixNano: traceStarted,
      endTimeUnixNano: stamp(), attributes: [
        attr('langfuse.observation.type', 'agent'), attr('langfuse.trace.name', 'Pi · work session'),
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
  // Credentials are supplied in memory on the private attached input stream.
  let envelope = '';
  for await (const chunk of process.stdin.setEncoding('utf8')) {
    envelope += chunk;
    if (envelope.length > 32_768) throw new Error('Invalid credential input');
  }
  const input = envelope.trim();
  const credentials = input.startsWith('{') ? JSON.parse(input) : {
    accessToken: input,
    langfusePublicKey: process.env.LANGFUSE_PUBLIC_KEY,
    langfuseSecretKey: process.env.LANGFUSE_SECRET_KEY,
  };
  const { accessToken, langfusePublicKey, langfuseSecretKey, runtimeToken } = credentials;
  const valid = value => typeof value === 'string' && value.length > 0 && value.length <= 16_384 && !/[\x00-\x20\x7f]/.test(value);
  if (stopped || ![accessToken, langfusePublicKey, langfuseSecretKey].every(valid))
    throw new Error('Private runtime credentials missing');
  langfuseAuth = 'Basic ' + Buffer.from(langfusePublicKey + ':' + langfuseSecretKey).toString('base64');
  bridge = process.env.PI_CONTROL_URL ? createRootBridge({ url: process.env.PI_CONTROL_URL, token: runtimeToken }) : null;
  const initial = bridge ? await bridge.context() : null;
  if (bridge && !initial) { stop(); throw new Error('Owner paused the runtime'); }
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
  const [system, goalSelection, invocation] = await Promise.all(promptNames.map(loadPrompt));
  let currentGoal = initial?.goals?.[0] ?? null;
  const goalTool = {
    name: 'goal_set', label: 'Choose a goal', description: 'Set one public, achievable goal for the sandbox.',
    parameters: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 300 } },
      required: ['text'], additionalProperties: false },
    execute: async (_id, { text }) => {
      if (stopped || currentGoal) throw new Error('A goal is already active or work is paused');
      const goalText = text.trim().slice(0, 300);
      if (!goalText) throw new Error('Expected a nonempty goal');
      const saved = bridge ? await bridge.setGoal({ text: goalText, status: 'active', id: randomUUID() }) : null;
      currentGoal = { id: saved?.id, text: goalText };
      return { content: [{ type: 'text', text: 'Goal set: ' + goalText }], details: { text: goalText }, terminate: true };
    },
  };
  if (stopped) throw new Error('Stopped');
  let firstTokenAt;
  agent = new Agent({
    initialState: { model: { ...model, baseUrl: base }, thinkingLevel: 'minimal', tools: currentGoal ? [] : [goalTool],
      systemPrompt: system.text + '\nWork only inside a benign simulation. Available actions are those declared by the runtime. Public reports should be short and contain no personal data.' },
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
  if (bridge) {
    let checking = false;
    pausePoll = setInterval(async () => {
      if (checking || stopped) return;
      checking = true;
      try { if (!await bridge.context()) stop(); } catch { stop(); }
      finally { checking = false; }
    }, 1500);
    pausePoll.unref();
  }
  await publish('Running');
  for (let index = 0; index < 2; index++) {
    if (stopped) break;
    const context = bridge ? await bridge.context() : null;
    if (bridge && !context) { stop(); break; }
    const selecting = !currentGoal;
    const prompt = selecting ? goalSelection : invocation;
    const input = prompt.text + (selecting
      ? '\nChoose one goal for the sandbox and save it through goal_set.'
      : '\nCurrent goal: ' + currentGoal.text + '\nTake one step in the sandbox and report the result.');
    agent.state.tools = selecting ? [goalTool] : [];
    recentInputs.push(input);
    const start = Date.now();
    const startTimeUnixNano = stamp();
    firstTokenAt = undefined;
    let failed = false;
    const priorMessages = agent.state.messages.length;
    try { await agent.prompt(input); } catch { failed = true; }
    const message = agent.state.messages.slice(priorMessages).findLast(x => x.role === 'assistant');
    const outcome = !failed && !stopped
      ? (selecting && currentGoal ? currentGoal.text : message?.stopReason === 'stop'
        ? message.content.filter(x => x.type === 'text').map(x => x.text).join('').trim().slice(0, 1200) : '')
      : '';
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
          system: agent.state.systemPrompt, previousTurns: events.map((e, i) => ({ user: recentInputs[i], assistant: e.outcome })),
          user: input,
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
    const report = { turn: index + 1, goal: currentGoal?.text ?? 'Choose a goal',
      action: selecting ? 'Choose a goal' : 'Work on the active goal', outcome };
    events.push(report);
    if (bridge) await bridge.observe({
      name: 'agent.work', input: { task: report.goal, action: report.action },
      output: { report: outcome }, start, traceId, parentSpanId,
    });
    await publish('Running');
  }
} catch {
  status = stopped ? 'Stopped' : 'Stopped · run failed';
  process.exitCode = stopped ? 0 : 1;
  if (!stopped) console.error('PoC did not complete (session, model, or output unavailable).');
}
clearInterval(pausePoll);
try { await publish(status); } catch { console.error('Could not publish stopped status.'); process.exitCode = 1; }
try { await exportTrace(); if (spans.length) console.log('Langfuse trace: ' + traceId); } catch { console.error('Langfuse trace delivery failed.'); process.exitCode = 1; }
