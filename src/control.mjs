import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Store } from './store.mjs';
import { Gateway } from './gateway.mjs';
import { DockerSupervisor } from './supervisor.mjs';
import { Telemetry } from './telemetry.mjs';
import { Memory } from './memory.mjs';

const equal = (a,b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
const text = (v,max=4000) => { if (typeof v !== 'string' || !v.trim() || v.length > max) throw new Error('Invalid text'); return v; };
async function json(req) {
  let s = ''; for await (const b of req) { s += b; if (Buffer.byteLength(s) > 200000) throw new Error('Request too large'); }
  return s ? JSON.parse(s) : {};
}
export function createControl({ store, ownerToken, runtimeToken, memoryToken, supervisor, gateway, memory, telemetry }) {
  if (!ownerToken || !runtimeToken || ownerToken === runtimeToken || ownerToken === memoryToken) throw new Error('Distinct owner/runtime credentials required');
  let transition = Promise.resolve();
  let generation = 0;
  const serialize = f => { const result = transition.then(f); transition = result.catch(() => {}); return result; };
  async function panic() {
    generation++;
    // Latch and abort synchronously before waiting for Docker or a previous start.
    store.set('panic', true); store.event('control.panic'); gateway.abort();
    return serialize(async () => { await supervisor.stop(); return { stopped: true }; });
  }
  async function resume() {
    if (gateway.enabled === false) throw new Error('Inference backend disabled; configure the selected provider first');
    const ticket = ++generation;
    return serialize(async () => {
      store.set('panic', true); await supervisor.stop();
      if (ticket !== generation) throw new Error('Resume superseded by newer control command');
      store.set('panic', false);
      try { await supervisor.start(); } catch (e) { store.set('panic', true); throw e; }
      if (ticket !== generation) { store.set('panic', true); await supervisor.stop(); throw new Error('Resume superseded'); }
      store.event('control.resumed'); return { running: true };
    });
  }
  async function action(a) {
    const start = Date.now(); let result;
    switch (a.name) {
      case 'inbox_list': result = store.notifications(); break;
      case 'inbox_read': result = store.readMessage(text(a.id,100)); break;
      case 'inbox_reply': result = store.reply(text(a.chat,100),text(a.body)); break;
      case 'chat_set': result = store.chat(text(a.chat,100),a.blocked,a.muted); break;
      case 'memory_decide': {
        if (typeof a.save !== 'boolean') throw new Error('save must be boolean');
        store.decide(text(a.fact), a.save, text(a.reason,1000));
        result = a.save ? store.remember(a.fact, a.source ?? 'agent', a.kind ?? 'observation', a.core === true) : { saved: false }; break;
      }
      case 'memory_search': result = await memory.search(text(a.query,1000)); break;
      case 'memory_core_set': {
        if (a.core && store.core().length >= 12) throw new Error('Core memory full');
        store.db.prepare('UPDATE memories SET core=? WHERE id=?').run(Number(a.core === true),text(a.id,100)); result={ok:true}; break;
      }
      case 'goal_set': result=store.goal(text(a.text,2000),['active','done','abandoned'].includes(a.status) ? a.status : 'active',a.id); break;
      case 'state_set': {
        if (Buffer.byteLength(JSON.stringify(a.state)) > 12000) throw new Error('Working state too large');
        store.set('working_state', a.state); result={ok:true}; break;
      }
      case 'journal': store.event('agent.decision', { summary: text(a.summary), reason: a.reason }); result={ok:true}; break;
      case 'operation': {
        store.db.prepare('INSERT OR REPLACE INTO operations VALUES (?,?,?,?)').run(text(a.id,100),new Date().toISOString(),text(a.status,30),JSON.stringify(a.data ?? {}));
        result={ok:true}; break;
      }
      case 'operation_list': result=store.db.prepare('SELECT * FROM operations ORDER BY time DESC LIMIT 20').all().map(r=>({...r,data:JSON.parse(r.data)}));break;
      case 'tool_observation': store.event('tool.executed',{tool:a.tool,input:a.input,result:a.result});result={ok:true};break;
      case 'cycle': store.set('last_cycle',new Date().toISOString()); store.event('agent.cycle',a.data ?? {}); result={ok:true}; break;
      default: throw new Error('Unknown action');
    }
    if(a.name==='tool_observation')telemetry?.record(`tool.${a.tool}`,a.input,a.result,start,a._context);
    else telemetry?.record(`tool.${a.name}`, a, result, start, a._context);
    return result;
  }
  const server = http.createServer(async (req,res) => {
    const send = (status,data) => { res.writeHead(status, { 'content-type':'application/json', 'cache-control':'no-store' }); res.end(JSON.stringify(data)); };
    try {
      const path = new URL(req.url,'http://localhost').pathname;
      if (req.method==='GET' && path==='/health') return send(200,{ok:true});
      const token = req.headers.authorization?.replace(/^Bearer /,'');
      const owner = equal(token,ownerToken), runtime = equal(token,runtimeToken), mem = equal(token,memoryToken);
      if (!owner && !runtime && !mem) return send(401,{error:'Unauthorized'});
      if (owner && req.method==='POST' && path==='/panic') return send(200,await panic());
      if (owner && req.method==='POST' && path==='/resume') return send(200,await resume());
      if (owner && req.method==='GET' && path==='/status') return send(200,{panic:store.get('panic'),inferenceEnabled:gateway.enabled,model:gateway.model,committedUsd:store.committed(),budgetUsd:gateway.cap,activeCalls:gateway.active.size,...store.context()});
      if (owner && req.method==='GET' && path==='/events') return send(200,store.events());
      if (owner && req.method==='GET' && path==='/outbox') return send(200,store.db.prepare("SELECT * FROM messages WHERE direction='out' ORDER BY time DESC LIMIT 100").all());
      if (owner && req.method==='POST' && path==='/inbox') {
        const b=await json(req); text(b.chat,100); text(b.sender,100); text(b.body,20000);
        // Owner control commands never pass through optional attention or blocked chats.
        if (b.body.trim()==='/panic') return send(200,await panic());
        if (b.body.trim()==='/resume') return send(200,await resume());
        return send(200,store.receive(b));
      }
      if (runtime && req.method==='GET' && path==='/runtime/context') {
        if (store.get('panic')) return send(423,{error:'Runtime stopped'});
        return send(200,store.context());
      }
      if (runtime && req.method==='POST' && path==='/runtime/action') {
        if (store.get('panic')) return send(423,{error:'Runtime stopped'});
        const a=await json(req);
        if (store.get('panic')) return send(423,{error:'Runtime stopped'});
        return send(200,await action(a));
      }
      if ((runtime || mem) && req.method==='POST' && path==='/v1/chat/completions') {
        if (store.get('panic')) return send(423,{error:'Runtime stopped'});
        const b=await json(req);
        // Recheck after consuming the request body; panic can arrive while it streams.
        return send(200,await gateway.complete(b));
      }
      return send(403,{error:'Forbidden'});
    } catch (e) {
      store.event('control.error',{message:e.message}); send(400,{error:e.message});
    }
  });
  server.requestTimeout=30000; server.headersTimeout=10000;
  return { server, panic, resume, action,
    async reconcile() { await supervisor.stop(); if (!store.get('panic')) await supervisor.start(); } };
}

export async function main() {
  const e=process.env, store=new Store(e.STATE_DB ?? '.state/runtime.sqlite');
  store.set('timezone', e.TIMEZONE ?? 'Europe/Moscow');
  const telemetry=new Telemetry({store,url:e.LANGFUSE_URL,publicKey:e.LANGFUSE_PUBLIC_KEY,secretKey:e.LANGFUSE_SECRET_KEY});
  const gateway=new Gateway({store,telemetry,enabled:e.MODEL_ENABLED!=='false',baseUrl:e.MODEL_BASE_URL,key:e.MODEL_API_KEY,model:e.MODEL,inputPrice:Number(e.INPUT_TOKEN_PRICE),outputPrice:Number(e.OUTPUT_TOKEN_PRICE),requestPrice:Number(e.REQUEST_PRICE ?? 0),cap:Number(e.MODEL_BUDGET_USD ?? 10)});
  const memory=new Memory(store,e.HINDSIGHT_URL,telemetry);
  const supervisor=new DockerSupervisor(e.WORKER_CONTAINER ?? 'ai-worker');
  const control=createControl({store,telemetry,gateway,memory,supervisor,ownerToken:e.OWNER_TOKEN,runtimeToken:e.RUNTIME_TOKEN,memoryToken:e.MEMORY_TOKEN});
  await control.reconcile();
  const timer=setInterval(()=>memory.sync(),30000); timer.unref();
  control.server.listen(Number(e.PORT ?? 8787),e.BIND_ADDRESS ?? '127.0.0.1',()=>console.log('Control API listening'));
  const stop=()=>{ clearInterval(timer); gateway.abort(); control.server.close(()=>{store.close();process.exit(0);}); };
  process.on('SIGTERM',stop); process.on('SIGINT',stop);
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(e=>{console.error(e.message);process.exit(1);});
