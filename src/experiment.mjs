import { randomBytes } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { Agent } from '@earendil-works/pi-agent-core';
import { createModels, hasApi } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { createRootBridge } from './root-bridge.mjs';
import { createObserver } from './observer.mjs';
import { tracePi, stamp, spanId, attr } from './pi-telemetry.mjs';

const { PUBLIC_RUN_FILE: outputFile, LANGFUSE_URL } = process.env;
if (!outputFile || !LANGFUSE_URL) {
  console.error('Set the public snapshot and Langfuse configuration in the private launcher.');
  process.exit(2);
}

const traceId = randomBytes(16).toString('hex');
const events = [];
const spans = [];
const traceStarted = stamp();
const viewing = process.env.PI_OWNER_WINDOW === 'true';
const maxRequests = viewing ? 20 : 2;
const deadlineMs = 600_000;
const spacingMs = Number(process.env.PI_LLM_SLEEP_MS ?? (viewing ? 20_000 : 0));
const modelsByAlias = new Map([['terra', 'gpt-6.1-terra'], ['luna', 'gpt-6-luna']]);
const configuredSlug = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  ? modelsByAlias.get(value) ?? value : null;
const sessionAbort = new AbortController();
let launches = 0;
let nextDispatchAt = 0;
let endTimer;
let bridge;
let langfuseAuth;
let stopped = false;
let agent;
let pausePoll;
let telemetry;

async function publish(status) {
  const temp = outputFile + '.' + traceId + '.tmp';
  await writeFile(temp, JSON.stringify({ mode: 'live', status, events }), { mode: 0o644, flag: 'wx' });
  await rename(temp, outputFile);
}

const stop = () => { stopped = true; sessionAbort.abort(); agent?.abort(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

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
    summary: 'Bounded Pi session', result: { status, turns: events.length },
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
  if (!Number.isSafeInteger(spacingMs) || spacingMs < 0 || spacingMs > 120_000)
    throw new Error('Invalid PI_LLM_SLEEP_MS');
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
  const { models: listedModels } = await res.json();
  if (!Array.isArray(listedModels)) throw new Error('Unexpected subscription model catalogue');
  const allowed = new Set(listedModels.filter(x => x?.visibility === 'list' && typeof x.slug === 'string').map(x => x.slug));
  const eligible = id => {
    if (!id || !allowed.has(id)) return null;
    const known = models.getModel('openai', id);
    if (known && (known.type === undefined || known.type === 'chat') &&
        known.input?.includes('text') && hasApi(known, 'openai-responses')) {
      return { ...known, baseUrl: base };
    }
    // The account may list more IDs than this version of Pi's built-in catalogue.
    // Send the exact entitled ID to the same text Responses API; the provider decides support.
    return {
      id, name: id, provider: 'openai', api: 'openai-responses', baseUrl: base,
      input: ['text'], reasoning: false, contextWindow: 16_384, maxTokens: 256,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  };
  const runtimeModel = eligible(configuredSlug(process.env.PI_MODEL_ACTOR ?? 'terra'));
  if (!runtimeModel || stopped) throw new Error('No eligible actor model');
  const narratorModel = eligible(configuredSlug(process.env.PI_OBSERVER_MODEL ?? 'luna'));
  if (!narratorModel) throw new Error('No eligible observer model');
  const [system, observerPrompt] = await Promise.all(['pi-system', 'observer-system'].map(loadPrompt));
  const secrets = [accessToken, runtimeToken, langfusePublicKey, langfuseSecretKey];
  const publicField = (value, limit) => {
    if (typeof value !== 'string' || /[\u0000-\u001f\u007f<>]/u.test(value))
      throw new Error('Use short plain-text fields');
    const text = value.trim();
    if (!text || text.length > limit || secrets.some(secret => secret && text.includes(secret)))
      throw new Error('Use short public fields without credentials');
    return text;
  };
  const parseGoal = value => {
    if (!value) return null;
    return { goal: publicField(value.goal, 160), reason: publicField(value.reason, 240) };
  };
  let workingGoal = parseGoal(initial?.workingGoal);
  let goalActed = false;
  const goalTool = {
    name: 'set_working_goal', label: 'Set a public working goal',
    description: 'Update internal working-goal state, which is publicly narrated and separate from the owner objective. Give one short observable reason from the supplied objective or current working goal. Do not attempt or claim external actions. Do not include private data or hidden reasoning.',
    parameters: { type: 'object', properties: {
      goal: { type: 'string', minLength: 1, maxLength: 160 },
      reason: { type: 'string', minLength: 1, maxLength: 240 },
    }, required: ['goal', 'reason'], additionalProperties: false },
    execute: async (_id, input) => {
      sessionAbort.signal.throwIfAborted();
      try {
        const goal = publicField(input?.goal, 160);
        const reason = publicField(input?.reason, 240);
        if (workingGoal?.goal === goal && workingGoal?.reason === reason)
          return { content: [{ type: 'text', text: 'Working goal unchanged.' }], details: { changed: false }, terminate: true };
        if (goalActed) throw new Error('One working-goal update per actor turn');
        goalActed = true;
        const saved = bridge ? await bridge.setWorkingGoal({ goal, reason }) : { workingGoal: { goal, reason }, changed: true };
        const next = parseGoal(saved?.workingGoal);
        if (!next || typeof saved.changed !== 'boolean') throw new Error('Goal save was not confirmed');
        const changed = saved.changed;
        workingGoal = next;
        const summary = changed ? ('Working goal: ' + next.goal + '. Reason: ' + next.reason).slice(0, 240) : 'Working goal unchanged.';
        return { content: [{ type: 'text', text: summary }], details: { summary, changed }, terminate: true };
      } catch {
        return { content: [{ type: 'text', text: 'Working goal rejected or not confirmed.' }],
          details: { summary: 'Working goal rejected or not confirmed.' }, isError: true, terminate: true };
      }
    },
  };
  if (stopped) throw new Error('Stopped');
  const countedStream = async (m, context, options) => {
    const signal = AbortSignal.any([sessionAbort.signal, options?.signal].filter(Boolean));
    signal.throwIfAborted();
    let remaining = nextDispatchAt - performance.now();
    while (remaining > 0) {
      await sleep(Math.ceil(remaining), undefined, { signal });
      remaining = nextDispatchAt - performance.now();
    }
    signal.throwIfAborted();
    if (stopped || launches >= maxRequests) throw new Error('Pi generation budget exhausted');
    launches++;
    const markComplete = () => { nextDispatchAt = performance.now() + spacingMs; };
    try {
      const stream = models.streamSimple(m, context, {
        ...options, apiKey: accessToken, maxTokens: 256, maxRetries: 0,
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
      void stream.result().then(markComplete, markComplete);
      return stream;
    } catch (error) {
      markComplete();
      throw error;
    }
  };
  telemetry = tracePi({ stream: countedStream, spans, session: traceId });
  const active = { scope: null };
  let cursor = 0;
  const evidenceScopes = new Map();
  const observer = createObserver({
    streamId: traceId, windowMs: Number(process.env.PI_OBSERVER_WINDOW_SECONDS ?? 15) * 1000,
    model: async ({ events: evidence }) => {
      const scope = evidenceScopes.get(evidence.at(-1).id);
      const fallback = () => evidence.slice(0, 3).map(e => e.summary || e.status).join('. ').slice(0, 280);
      const narrator = new Agent({
        initialState: { model: narratorModel, thinkingLevel: 'minimal', tools: [], systemPrompt: observerPrompt.text },
        streamFn: telemetry.model({ ...scope, name: 'Pi · observer', prompt: observerPrompt }),
      });
      const abort = () => narrator.abort();
      sessionAbort.signal.addEventListener('abort', abort, { once: true });
      try {
        sessionAbort.signal.throwIfAborted();
        await narrator.prompt(JSON.stringify(evidence));
        const message = narrator.state.messages.findLast(x => x.role === 'assistant');
        const text = message?.stopReason === 'stop'
          ? message.content.filter(x => x.type === 'text').map(x => x.text).join('').trim() : '';
        return text.length <= 280 && text && !/[<>\x00-\x1f\x7f]/.test(text) &&
          !secrets.some(secret => secret && text.includes(secret)) ? text : fallback();
      } catch (error) {
        sessionAbort.signal.throwIfAborted();
        return fallback();
      } finally { sessionAbort.signal.removeEventListener('abort', abort); }
    },
  });
  async function broadcast(force = false) {
    if (!evidenceScopes.size || stopped || launches >= maxRequests) return 'idle';
    return observer.flush({ force, publish: async card => {
      await telemetry.flush();
      await exportTrace();
      const scope = evidenceScopes.get(card.evidence.at(-1).id);
      const report = { id: card.id, goal: scope.goal,
        action: 'Observer update', outcome: card.text };
      if (!events.some(e => e.id === card.id)) {
        if (bridge) await bridge.observe({
          name: 'agent.work', input: { task: 'Working goal' }, output: { report: report.outcome },
          start: Date.now(), traceId: scope.traceId, parentSpanId: scope.parentSpanId,
        });
        events.push(report);
      }
      await publish('Running');
      for (const event of card.evidence) evidenceScopes.delete(event.id);
    } });
  }
  const makeAgent = () => {
    const next = new Agent({
      toolExecution: "sequential",
      initialState: {
        model: runtimeModel, thinkingLevel: 'minimal', tools: [goalTool],
        systemPrompt: system.text,
      },
      streamFn: (m, ctx, options) => {
        if (launches >= maxRequests - 1) throw new Error('Pi generation budget exhausted');
        return telemetry.model(active.scope)(m, ctx, options);
      },
    });
    const tools = new Map();
    next.subscribe(event => {
      if (event.type === 'tool_execution_start') {
        tools.set(event.toolCallId, { started: stamp(), args: event.args });
      } else if (event.type === 'tool_execution_end') {
        const { started = stamp(), args } = tools.get(event.toolCallId) ?? {};
        tools.delete(event.toolCallId);
        telemetry.tool(active.scope, event, started, args);
        if (event.toolName === 'set_working_goal' && !event.isError && event.result?.details?.changed === true) {
          const summary = event.result?.details?.summary ?? 'Working goal updated.';
          const added = observer.append({ id: cursor + 1, source: 'public-tool', name: event.toolName,
            status: 'ok', summary });
          if (added === 'accepted') evidenceScopes.set(++cursor, { ...active.scope, goal: workingGoal?.goal ?? active.scope.goal });
          else if (added === 'full') stop();
        }
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
  for (let index = 0; index < maxRequests && launches < maxRequests - 1; index++) {
    if (stopped) break;
    await broadcast();
    if (launches >= maxRequests - 1) break;
    const context = bridge ? await bridge.context() : null;
    if (bridge && !context) { stop(); break; }
    if (bridge) workingGoal = parseGoal(context.workingGoal);
    const prompt = await loadPrompt('pi-goal');
    const input = 'Owner objective:\n' + prompt.text +
      '\nWorking goal (separate from the owner objective): ' +
      JSON.stringify(workingGoal && { goal: workingGoal.goal, reason: workingGoal.reason });
    const startTimeUnixNano = stamp();
    const turnTraceId = viewing ? randomBytes(16).toString('hex') : traceId;
    const turnParentSpanId = viewing ? spanId() : parentSpanId;
    active.scope = { traceId: turnTraceId, parentSpanId: turnParentSpanId,
      name: 'Pi · generation', prompt, secrets, goal: workingGoal?.goal ?? 'Working goal' };
    const beforeTools = cursor;
    goalActed = false;
    const beforeMessages = agent.state.messages.length;
    let completed = false;
    try {
      await agent.prompt(input);
      completed = agent.state.messages.slice(beforeMessages).some(m => m.role === 'assistant' && m.stopReason === 'stop');
    } catch { /* The trace below records failure when no update or normal response completed. */ }
    await telemetry.flush();
    if (viewing) spans.push(agentSpan({
      id: turnTraceId, parent: turnParentSpanId, name: 'Pi · turn ' + (index + 1), started: startTimeUnixNano,
      summary: 'Consider the current objective and working goal',
      result: { turn: index + 1, status: stopped ? 'Stopped' : (completed || cursor > beforeTools) ? 'Completed' : 'Failed' },
    }));
    if (viewing) await exportTrace();
    if (stopped) break;
  }
  while (await broadcast(true) === 'published') continue;
  await telemetry.flush();
} catch {
  status = stopped ? 'Stopped' : 'Stopped · run failed';
  process.exitCode = stopped ? 0 : 1;
  if (!stopped) console.error('PoC did not complete (session, model, or output unavailable).');
}
clearInterval(pausePoll);
clearTimeout(endTimer);
try { await publish(status); } catch { console.error('Could not publish stopped status.'); process.exitCode = 1; }
try { if (launches) { await telemetry?.flush(); await exportTrace(true); console.log((viewing ? 'Langfuse session: ' : 'Langfuse trace: ') + traceId); } } catch { console.error('Langfuse trace delivery failed.'); process.exitCode = 1; }
