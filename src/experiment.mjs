import { randomBytes, randomUUID } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';
import { Agent } from '@earendil-works/pi-agent-core';
import { createModels, hasApi } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { createRootBridge, RootRuntimeStopped } from './root-bridge.mjs';
import { answerOwnerChat } from './private-chat.mjs';

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
const viewing = process.env.PI_OWNER_WINDOW === 'true';
const ownerChat = viewing && process.env.PI_OWNER_CHAT === 'true';
const maxRequests = viewing ? 20 : 2;
const deadlineMs = 600_000;
const delayMs = 20_000;
const sessionAbort = new AbortController();
let launches = 0;
let endTimer;
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

const stop = () => { stopped = true; sessionAbort.abort(); agent?.abort(); };
const pause = () => new Promise(resolve => {
  const finish = () => { clearTimeout(timer); sessionAbort.signal.removeEventListener('abort', finish); resolve(); };
  const timer = setTimeout(finish, delayMs);
  sessionAbort.signal.addEventListener('abort', finish, { once: true });
  if (sessionAbort.signal.aborted) finish();
});
const normalized = text => text.toLowerCase().replace(/[\p{P}\p{Z}\s]+/gu, ' ').trim();
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
function agentSpan({ id, parent, name, started, summary, result }) {
  return {
    traceId: id, spanId: parent, name, kind: 1, startTimeUnixNano: started,
    endTimeUnixNano: stamp(), attributes: [
      attr('langfuse.observation.type', 'agent'), attr('langfuse.trace.name', name),
      attr('session.id', traceId), attr('langfuse.environment', 'poc'),
      attr('langfuse.observation.input', summary),
      attr('langfuse.observation.output', JSON.stringify(result)),
    ],
  };
}

async function exportTrace(final = false) {
  const pending = spans.slice();
  if (final && !viewing && launches) pending.unshift(agentSpan({
    id: traceId, parent: parentSpanId, name: 'Pi · work session', started: traceStarted,
    summary: 'Two turns in one Pi transcript', result: { status, turns: events.length },
  }));
  if (!pending.length) return;
  const body = { resourceSpans: [{ resource: { attributes: [attr('service.name', 'ai-poc')] }, scopeSpans: [{
    scope: { name: 'ai-poc' },
    spans: pending,
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
  spans.splice(0, pending.length);
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
  if (viewing && !bridge) throw new Error('Owner viewing requires the private root controller');
  if (viewing) endTimer = setTimeout(stop, deadlineMs);
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
  const runtimeModel = { ...model, baseUrl: base };
  const countedStream = (m, context, options) => {
    if (stopped || launches >= maxRequests) throw new Error('Pi generation budget exhausted');
    launches++;
    return models.streamSimple(m, context, {
      ...options, apiKey: accessToken, maxTokens: 256, maxRetries: 0,
      signal: AbortSignal.any([sessionAbort.signal, options?.signal, AbortSignal.timeout(30_000)].filter(Boolean)),
    });
  };
  const makeAgent = () => {
    const next = new Agent({
    initialState: { model: runtimeModel, thinkingLevel: 'minimal', tools: currentGoal ? [] : [goalTool],
      systemPrompt: system.text + '\nWork only inside a benign simulation. Available actions are those declared by the runtime. Public reports should be short and contain no personal data.' },
    streamFn: countedStream,
  });
  next.subscribe(event => {
    if (!firstTokenAt && event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      firstTokenAt = new Date().toISOString();
    }
  });
    return next;
  };
  agent = makeAgent();
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
  let previousPrivate = false;
  for (let index = 0, round = 0; index < maxRequests && launches < maxRequests; round++) {
    if (viewing && round) await pause();
    if (stopped) break;
    const context = bridge ? await bridge.context() : null;
    if (bridge && !context) { stop(); break; }
    if (ownerChat && index > 0 && !previousPrivate) {
      const beforeChat = launches;
      try {
        const answered = await answerOwnerChat({
          bridge, model: runtimeModel, stream: countedStream, signal: sessionAbort.signal,
          secrets: [accessToken, runtimeToken, langfusePublicKey, langfuseSecretKey],
        });
        if (answered) { previousPrivate = true; continue; }
      } catch (error) {
        if (stopped || error instanceof RootRuntimeStopped) { stop(); break; }
        console.error('Private chat could not complete.');
        if (launches !== beforeChat) { previousPrivate = true; continue; }
      }
    }
    previousPrivate = false;
    if (stopped || launches >= maxRequests) break;
    const selecting = !currentGoal;
    const prompt = selecting ? goalSelection : invocation;
    const recent = viewing ? events.slice(-2).map(e => e.outcome.slice(0, 420)) : [];
    const contextNote = recent.length
      ? '\nRecent public reports: ' + JSON.stringify(recent) +
        '\nTake a different useful step, rather than restating a previous report.'
      : '';
    const input = prompt.text + (selecting
      ? '\nChoose one goal for the sandbox and save it through goal_set.'
      : '\nCurrent goal: ' + currentGoal.text.slice(0, 300) + '\nTake one step in the sandbox and report the result.') + contextNote;
    if (viewing) agent = makeAgent();
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
    const turnTraceId = viewing ? randomBytes(16).toString('hex') : traceId;
    const turnParentSpanId = viewing ? spanId() : parentSpanId;
    if (viewing) spans.push(agentSpan({
      id: turnTraceId, parent: turnParentSpanId, name: 'Pi · turn ' + (index + 1), started: startTimeUnixNano,
      summary: selecting ? 'Choose a sandbox goal' : 'Work on the active goal',
      result: { turn: index + 1, status: stopped ? 'Stopped' : outcome ? 'Completed' : 'Failed' },
    }));
    spans.push({
      traceId: turnTraceId, parentSpanId: turnParentSpanId, spanId: spanId(), name: 'Turn ' + (index + 1), kind: 1,
      startTimeUnixNano, endTimeUnixNano: stamp(), status: { code: outcome || stopped ? 1 : 2 },
      attributes: [
        attr('langfuse.observation.type', 'generation'), attr('langfuse.observation.model.name', model.id),
        attr('langfuse.environment', 'poc'), attr('session.id', traceId),
        attr('langfuse.observation.prompt.name', prompt.name),
        intAttr('langfuse.observation.prompt.version', prompt.version),
        attr('langfuse.observation.metadata.system_prompt', system.name + '@' + system.version),
        attr('langfuse.observation.input', JSON.stringify({
          system: agent.state.systemPrompt, previousTurns: viewing ? recent : events.map((e, i) => ({ user: recentInputs[i], assistant: e.outcome })),
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
    if (viewing) await exportTrace();
    if (stopped) break;
    if (!outcome) throw new Error('Model did not produce a complete report');
    const report = { turn: index + 1, goal: currentGoal?.text ?? 'Choose a goal',
      action: selecting ? 'Choose a goal' : 'Work on the active goal', outcome };
    if (!viewing || !events.some(e => normalized(e.outcome) === normalized(outcome))) {
      if (bridge) await bridge.observe({
        name: 'agent.work', input: { task: report.goal, action: report.action },
        output: { report: outcome }, start, traceId: turnTraceId, parentSpanId: turnParentSpanId,
      });
      if (stopped) break;
      events.push(report);
      await publish('Running');
    }
    index++;
  }
} catch {
  status = stopped ? 'Stopped' : 'Stopped · run failed';
  process.exitCode = stopped ? 0 : 1;
  if (!stopped) console.error('PoC did not complete (session, model, or output unavailable).');
}
clearInterval(pausePoll);
clearTimeout(endTimer);
try { await publish(status); } catch { console.error('Could not publish stopped status.'); process.exitCode = 1; }
try { if (launches) { await exportTrace(true); console.log((viewing ? 'Langfuse session: ' : 'Langfuse trace: ') + traceId); } } catch { console.error('Langfuse trace delivery failed.'); process.exitCode = 1; }
