const byId = id => document.getElementById(id);
const access = byId('access');
const control = byId('control');
const notice = byId('notice');
const toggle = byId('toggle');
const pair = byId('pair');
const claim = byId('claim');
const clear = byId('clear');
const fields = ['actor', 'observer', 'sleepSeconds'].map(byId);
let snapshot;
let working = false;
let pollId = 0;
let editing = false;
const modelId = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
let catalogueSignature;
let choicesAvailable = false;

function applyCatalogue(data) {
  const entries = new Map();
  for (const model of Array.isArray(data.models) ? data.models : []) {
    if (modelId(model?.id)) entries.set(model.id, typeof model.label === 'string' && model.label.trim() ? model.label : model.id);
  }
  choicesAvailable = entries.size > 0;
  const hint = byId('catalogue-note');
  hint.hidden = choicesAvailable;
  hint.textContent = choicesAvailable ? '' : 'Subscription model list unavailable. Current selections are kept.';
  for (const id of [data.settings.actor, data.settings.observer]) {
    if (!entries.has(id)) entries.set(id, id);
  }
  const signature = JSON.stringify([...entries]);
  if (signature === catalogueSignature) return;
  catalogueSignature = signature;
  for (const field of fields.slice(0, 2)) {
    field.replaceChildren(...[...entries].map(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      return option;
    }));
  }
}

function enableSettings(busy) {
  for (const field of fields) field.disabled = busy || (field.id !== 'sleepSeconds' && !choicesAvailable);
}

async function request(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : {
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),
    cache: 'no-store', signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Object.assign(new Error('Request failed'), { status: response.status });
  return response.json();
}

function showLogin() {
  snapshot = undefined;
  control.hidden = true;
  access.hidden = false;
  notice.textContent = 'Pair this browser to manage the experiment.';
}

function showStatus(data, force = false) {
  if (typeof data?.paused !== 'boolean' || typeof data?.running !== 'boolean' ||
      !modelId(data.settings?.actor) ||
      !modelId(data.settings?.observer) ||
      !Number.isInteger(data.settings?.sleepSeconds)) throw new Error('Invalid status');
  snapshot = data;
  access.hidden = true;
  control.hidden = false;
  byId('challenge').hidden = true;
  byId('code').textContent = '';
  const phase = {
    paused: 'Paused', running: 'Running', starting: 'Starting…',
    stopping: 'Pausing…', stopped: 'Stopped', error: 'Stopped with an error',
  };
  byId('state').textContent = Object.hasOwn(phase, data.phase) ? phase[data.phase]
    : data.paused ? data.running ? 'Pausing…' : 'Paused'
      : data.running ? 'Running' : 'Stopped';
  const canPause = !data.paused;
  toggle.dataset.action = canPause ? 'pause' : 'resume';
  toggle.textContent = canPause ? 'Pause' : 'Resume';
  if (force || (!editing && !fields.includes(document.activeElement))) {
    applyCatalogue(data);
    for (const field of fields) field.value = data.settings[field.id];
    enableSettings(working);
  }
}

async function refresh() {
  if (working || document.hidden) return;
  const id = ++pollId;
  try {
    const data = await request('/admin/api');
    if (id !== pollId || working) return;
    showStatus(data);
    if (notice.textContent.startsWith('Could not') ||
        notice.textContent.startsWith('Checking')) notice.textContent = '';
  } catch (error) {
    if (id !== pollId || working) return;
    if (error.status === 401) {
      if (snapshot || access.hidden) {
        showLogin();
        await request('/api/pair/status').catch(() => {});
      }
    } else notice.textContent = 'Could not check status. Retrying…';
  }
}

async function act(action, errorMessage) {
  if (working) return;
  working = true;
  pollId++;
  toggle.disabled = pair.disabled = claim.disabled = clear.disabled = true;
  enableSettings(true);
  notice.textContent = '';
  try {
    await action();
  } catch (error) {
    if (error.status === 401 && snapshot) showLogin();
    else notice.textContent = typeof errorMessage === 'function' ? errorMessage(error) : errorMessage;
  } finally {
    working = false;
    toggle.disabled = pair.disabled = claim.disabled = clear.disabled = false;
    enableSettings(false);
  }
}

pair.addEventListener('click', () => act(async () => {
  await request('/api/pair/status');
  const { code } = await request('/api/pair/create', {});
  if (typeof code !== 'string' || !/^[0-9a-f]{12}$/i.test(code)) throw new Error('Invalid pairing code');
  byId('code').textContent = code;
  byId('challenge').hidden = false;
}, 'Could not get a pairing code. Try again.'));

claim.addEventListener('click', () => act(async () => {
  await request('/api/pair/claim', {});
  showStatus(await request('/admin/api'), true);
}, 'Pairing is not ready. Ask Dora to approve the code, or get a fresh one.'));

toggle.addEventListener('click', () => act(async () => {
  if (!snapshot) return;
  const paused = !snapshot.paused;
  showStatus(await request('/admin/api', { paused }), true);
}, asyncStatusError));
function asyncStatusError() {
  return 'Could not confirm the change. Checking status again…';
}

clear.addEventListener('click', () => {
  if (!snapshot || !window.confirm('Clear the history and memories visible on the site? Private traces will be kept.')) return;
  void act(async () => {
    const status = await request('/admin/api', { clear: true });
    showStatus(status, true);
    if (!status.clearedAt || !Number.isFinite(Date.parse(status.clearedAt))) throw new Error('Clear not confirmed');
    notice.textContent = 'Public history and memory cleared.';
  }, 'Could not confirm that the public history was cleared.');
});

for (const field of fields) {
  field.addEventListener('input', () => { editing = true; });
  field.addEventListener('change', () => {
    editing = false;
    if (!snapshot || !fields.every(input => input.validity.valid)) {
      notice.textContent = 'Enter a delay from 0 to 120 seconds.';
      return;
    }
    void act(async () => {
      const [actor, observer, sleep] = fields.map(input => input.value);
      showStatus(await request('/admin/api', { actor, observer, sleepSeconds: Number(sleep) }), true);
      notice.textContent = 'Saved for the next run.';
    }, 'Could not save settings. Try again.');
  });
}

void refresh();
setInterval(refresh, 3000);
document.addEventListener('visibilitychange', refresh);
