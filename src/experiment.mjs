import { randomBytes, randomUUID } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { Agent } from '@earendil-works/pi-agent-core';
import { createModels, hasApi } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { createRootBridge, RootRuntimeStopped } from './root-bridge.mjs';
import { answerOwnerChat } from './private-chat.mjs';
import { createObserver } from './observer.mjs';
import { createSimulation } from './simulation.mjs';
import { tracePi, stamp, spanId, attr } from './pi-telemetry.mjs';

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
const simulated = process.env.PI_SIMULATION === 'true';
const viewing = process.env.PI_OWNER_WINDOW === 'true';
const ownerChat = viewing && process.env.PI_OWNER_CHAT === 'true';
const maxRequests = viewing ? 20 : 2;
const deadlineMs = 600_000;
const spacingMs = Number(process.env.PI_LLM_SLEEP_MS ?? (viewing ? 20_000 : 0));
const modelsByAlias = new Map([['terra', 'gpt-6.1-terra'], ['luna', 'gpt-6-luna']]);
const configuredSlug = value => modelsByAlias.get(value) ??
  ([...modelsByAlias.values()].includes(value) ? value : null);
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
const normalized = text => text.toLowerCase().replace(/[\p{P}\p{Z}\s]+/gu, ' ').trim();
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
  const allowed = (await res.json()).models.filter(x => x.visibility === 'list');
  const eligible = id => {
    const candidate = allowed.some(x => x.slug === id) && models.getModel('openai', id);
    return candidate && hasApi(candidate, 'openai-responses') ? { ...candidate, baseUrl: base } : null;
  };
  const requestedActor = process.env.PI_MODEL_ACTOR;
  const actorSlug = configuredSlug(requestedActor);
  if (requestedActor !== undefined && !actorSlug) throw new Error('Invalid PI_MODEL_ACTOR');
  const candidates = actorSlug ? [actorSlug] : PI_MODEL ? [PI_MODEL] : ['gpt-6.1-terra', 'gpt-5.4-mini', 'gpt-5.1-codex-mini'];
  const runtimeModel = candidates.map(eligible).find(Boolean);
  if (!runtimeModel || stopped) throw new Error('No eligible small conversational model');
  const narratorModel = simulated && eligible(configuredSlug(process.env.PI_OBSERVER_MODEL ?? 'luna'));
  if (simulated && !narratorModel) throw new Error('Configure PI_OBSERVER_MODEL with an eligible subscription model slug');
  const promptSet = simulated ? ['ai-simulation', 'ai-observer'] : promptNames;
  const [system, goalSelection, invocation] = await Promise.all(promptSet.map(loadPrompt));
  const simulation = simulated ? createSimulation() : null;
  const commandTool = simulated ? {
    name: 'simulation_command', label: 'Act in the fictional network',
    description: 'Run a game command in the fictional network.',
    parameters: { type: 'object', properties: { command: { type: 'string', enum: simulation.commands } },
      required: ['command'], additionalProperties: false },
    execute: async (_id, { command }) => {
      sessionAbort.signal.throwIfAborted();
      const result = simulation.execute(command);
      return { content: [{ type: 'text', text: result }], details: { summary: result }, terminate: true };
    },
  } : null;
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
  const secrets = [accessToken, runtimeToken, langfusePublicKey, langfuseSecretKey];
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
  const observer = simulated ? createObserver({
    streamId: traceId, windowMs: Number(process.env.PI_OBSERVER_WINDOW_SECONDS ?? 15) * 1000,
    model: async ({ events: evidence }) => {
      const scope = evidenceScopes.get(evidence.at(-1).id);
      const fallback = () => evidence.slice(0, 3).map(e => e.summary || e.status).join('. ').slice(0, 280);
      const narrator = new Agent({
        initialState: { model: narratorModel, thinkingLevel: 'minimal', tools: [], systemPrompt: goalSelection.text },
        streamFn: telemetry.model({ ...scope, name: 'Pi simulation · observer', prompt: goalSelection }),
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
  }) : null;
  async function broadcast(force = false) {
    if (!observer || !evidenceScopes.size || stopped || launches >= maxRequests) return 'idle';
    return observer.flush({ force, publish: async card => {
      await telemetry.flush();
      await exportTrace();
      const scope = evidenceScopes.get(card.evidence.at(-1).id);
      const report = { id: card.id, goal: scope.goal,
        action: 'Observer update', outcome: card.text };
      if (bridge && !events.some(e => e.id === card.id)) await bridge.observe({
        name: 'agent.work', input: { task: report.goal }, output: { report: report.outcome },
        start: Date.now(), traceId: scope.traceId, parentSpanId: scope.parentSpanId,
      });
      if (!events.some(e => e.id === card.id)) events.push(report);
      await publish('Running');
      for (const event of card.evidence) evidenceScopes.delete(event.id);
    } });
  }
  const makeAgent = () => {
    const next = new Agent({
      initialState: {
        model: runtimeModel, thinkingLevel: 'minimal', tools: [],
        systemPrompt: simulated ? system.text : system.text + '\nWork only inside a benign simulation. Available actions are those declared by the runtime. Public reports should be short and contain no personal data.',
      },
      streamFn: (m, ctx, options) => {
        if (launches >= maxRequests - (simulated ? 1 : 0)) throw new Error('Pi generation budget exhausted');
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
        if (simulated && event.toolName === 'simulation_command') {
          const summary = event.isError ? 'Simulation command failed' : event.result?.details?.summary ?? '';
          const added = observer.append({ id: cursor + 1, source: 'public-tool', name: event.toolName,
            status: event.isError ? 'error' : 'ok', summary });
          if (added === 'accepted') evidenceScopes.set(++cursor, active.scope);
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
  let previousPrivate = false;
  for (let index = 0, round = 0; index < maxRequests && launches < maxRequests - (simulated ? 1 : 0); round++) {
    if (stopped) break;
    if (simulated) await broadcast();
    if (launches >= maxRequests - (simulated ? 1 : 0)) break;
    const context = bridge ? await bridge.context() : null;
    if (bridge && !context) { stop(); break; }
    if (ownerChat && index > 0 && !previousPrivate && launches < maxRequests - (simulated ? 1 : 0)) {
      const beforeChat = launches;
      try {
        const privatePrompt = simulated ? await loadPrompt('ai-private-reply') : undefined;
        const answered = await answerOwnerChat({
          bridge, model: runtimeModel, signal: sessionAbort.signal, secrets,
          stream: telemetry.model({ traceId: randomBytes(16).toString('hex'), private: true, name: 'Private reply',
            prompt: privatePrompt }),
          systemPrompt: privatePrompt?.text,
        });
        if (answered) { await telemetry.flush(); await exportTrace(); previousPrivate = true; continue; }
      } catch (error) {
        if (stopped || error instanceof RootRuntimeStopped) { stop(); break; }
        console.error('Private chat could not complete.');
        if (launches !== beforeChat) { previousPrivate = true; continue; }
      }
    }
    previousPrivate = false;
    if (stopped || launches >= maxRequests) break;
    const selecting = !simulated && !currentGoal;
    const prompt = simulated ? await loadPrompt('ai-motivation') : selecting ? goalSelection : invocation;
    const recent = viewing ? events.slice(-2).map(e => e.outcome.slice(0, 420)) : [];
    const contextNote = recent.length
      ? '\nRecent public reports: ' + JSON.stringify(recent) +
        '\nTake a different useful step, rather than restating a previous report.'
      : '';
    const input = simulated ? prompt.text + '\nNetwork: ' + simulation.status() :
      prompt.text + (selecting
        ? '\nChoose one goal for the sandbox and save it through goal_set.'
        : '\nCurrent goal: ' + currentGoal.text.slice(0, 300) + '\nTake one step in the sandbox and report the result.') + contextNote;
    if (viewing) agent = makeAgent();
    agent.state.tools = simulated ? [commandTool] : selecting ? [goalTool] : [];
    const start = Date.now();
    const startTimeUnixNano = stamp();
    const turnTraceId = viewing ? randomBytes(16).toString('hex') : traceId;
    const turnParentSpanId = viewing ? spanId() : parentSpanId;
    active.scope = { traceId: turnTraceId, parentSpanId: turnParentSpanId, name: simulated ? 'Pi simulation · generation' : 'Pi generation', prompt, secrets,
      goal: simulated ? 'Fictional network' : currentGoal?.text };
    let failed = false;
    const beforeTools = cursor;
    const priorMessages = agent.state.messages.length;
    try { await agent.prompt(input); } catch { failed = true; }
    await telemetry.flush();
    const message = agent.state.messages.slice(priorMessages).findLast(x => x.role === 'assistant');
    const outcome = !failed && !stopped
      ? (selecting && currentGoal ? currentGoal.text : message?.stopReason === 'stop'
        ? message.content.filter(x => x.type === 'text').map(x => x.text).join('').trim().slice(0, 1200) : '')
      : '';
    if (viewing) spans.push(agentSpan({
      id: turnTraceId, parent: turnParentSpanId, name: (simulated ? 'Pi simulation · turn ' : 'Pi · turn ') + (index + 1), started: startTimeUnixNano,
      summary: simulated ? 'Act in the simulated network' : selecting ? 'Choose a sandbox goal' : 'Work on the active goal',
      result: { turn: index + 1, status: stopped ? 'Stopped' : outcome || cursor > beforeTools ? 'Completed' : 'Failed' },
    }));
    if (viewing) await exportTrace();
    if (stopped) break;
    if (simulated) {
      index++;
      continue;
    }
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
  if (simulated) while (await broadcast(true) === 'published') continue;
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
