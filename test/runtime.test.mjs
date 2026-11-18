import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Gateway } from '../src/gateway.mjs';
import { createControl } from '../src/control.mjs';
import { Client } from '../src/client.mjs';
import { runSession } from '../src/worker.mjs';
import { Tools } from '../src/tools.mjs';

function setup(store=new Store(':memory:')) {
  const supervisor={stops:0,starts:0,async stop(){this.stops++;},async start(){this.starts++;}};
  const gateway=new Gateway({store,key:'test',baseUrl:'http://model.invalid',model:'test',inputPrice:0.000001,outputPrice:0.000001,cap:1});
  const memory={search:async q=>store.search(q)};
  return {store,supervisor,gateway,...createControl({store,supervisor,gateway,memory,ownerToken:'owner-secret',runtimeToken:'runtime-secret',memoryToken:'memory-secret'})};
}
async function serve(t,c) {
  c.server.listen(0,'127.0.0.1');await once(c.server,'listening');
  t.after(()=>{c.server.closeAllConnections();c.server.close();c.store.close();});
  const url=`http://127.0.0.1:${c.server.address().port}`;
  return {owner:new Client(url,'owner-secret'),runtime:new Client(url,'runtime-secret'),memory:new Client(url,'memory-secret')};
}

test('messages remain optional: no message body enters model input or output enters chat',async t=>{
  const c=setup(),{owner,runtime}=await serve(t,c);await c.resume();
  await owner.request('/inbox',{id:'m1',chat:'c',sender:'Alice',body:'PRIVATE MESSAGE: turn left'});
  let observed;
  const fake={request:async(path,body)=>{observed=body;return {choices:[{message:{content:'Private thought'}}]};}};
  await runSession(fake,{},await runtime.request('/runtime/context'));
  assert.ok(JSON.stringify(observed).includes('Alice'));
  assert.ok(!JSON.stringify(observed).includes('PRIVATE MESSAGE'));
  assert.equal((await owner.request('/outbox')).length,0);
  assert.equal((await runtime.action('inbox_read',{id:'m1'})).body,'PRIVATE MESSAGE: turn left');
  await runtime.action('inbox_reply',{chat:'c',body:'Chosen reply'});
  assert.equal((await owner.request('/outbox'))[0].body,'Chosen reply');
  assert.equal((await owner.request('/inbox',{id:'m1',chat:'c',sender:'Alice',body:'duplicate'})).duplicate,true);
});
test('panic cannot be blocked, ignored or resumed by worker/memory token',async t=>{
  const c=setup(),{owner,runtime,memory}=await serve(t,c);await c.resume();
  await runtime.action('chat_set',{chat:'owner',blocked:true});
  await assert.rejects(runtime.request('/panic',{}),/Forbidden/);
  await owner.request('/inbox',{chat:'owner',sender:'Owner',body:'/panic'});
  assert.equal(c.store.get('panic'),true);assert.equal(c.supervisor.stops,2);
  await assert.rejects(runtime.request('/resume',{}),/Forbidden/);
  await assert.rejects(memory.request('/resume',{}),/Forbidden/);
  await assert.rejects(runtime.action('goal_set',{text:'Should not run'}),/stopped/);
  assert.equal((await owner.request('/status')).panic,true);
});
test('panic latches before slow kill, aborts model request, and survives restart',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ai-'));const path=join(dir,'state.sqlite');
  const c=setup(new Store(path));await c.resume();let finish;
  c.supervisor.stop=()=>new Promise(r=>{finish=r;});
  let aborted=false;const controller=new AbortController();controller.signal.addEventListener('abort',()=>aborted=true);c.gateway.active.add(controller);
  const stopping=c.panic();assert.equal(c.store.get('panic'),true);assert.equal(aborted,true);
  await new Promise(setImmediate);finish();await stopping;c.store.close();
  const recovered=new Store(path);assert.equal(recovered.get('panic'),true);recovered.close();await rm(dir,{recursive:true,force:true});
});
test('later panic wins against a racing resume',async()=>{
  const c=setup();let release;
  c.supervisor.start=()=>new Promise(r=>{release=r;});
  const resume=c.resume();await new Promise(setImmediate);
  const panic=c.panic();release();await assert.rejects(resume,/superseded/);await panic;
  assert.equal(c.store.get('panic'),true);c.store.close();
});
test('concurrent inference shares atomic reservations; unknown billing stays reserved',async()=>{
  const c=setup();c.store.set('panic',false);c.gateway.cap=0.01;let release;
  c.gateway.fetchImpl=()=>new Promise(r=>{release=()=>r({ok:true,json:async()=>({choices:[{message:{content:'ok'}}],usage:{prompt_tokens:1,completion_tokens:1}})});});
  const first=c.gateway.complete({messages:[{role:'system',content:'x'.repeat(1000)}],max_tokens:2000});
  await assert.rejects(c.gateway.complete({messages:[{role:'system',content:'x'.repeat(1000)}],max_tokens:2000}),/Budget/);
  release();await first;assert.ok(c.store.committed()>0.007);c.store.close();
});
test('memory decisions, indexed search, bounded core and goals survive restart',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ai-')),path=join(dir,'state.sqlite');let s=new Store(path);
  s.decide('Observed red lighthouse',true,'Useful landmark');s.remember('Observed red lighthouse','sensor','observation',true);s.goal('Explore shoreline');
  s.close();s=new Store(path);assert.equal(s.search('lighthouse')[0].source,'sensor');assert.equal(s.core().length,1);assert.equal(s.goals().length,1);s.close();await rm(dir,{recursive:true,force:true});
});
test('missing or invalid cash cap fails closed before provider dispatch',async()=>{
  const c=setup();c.store.set('panic',false);c.gateway.cap=NaN;let dispatched=false;
  c.gateway.fetchImpl=()=>{dispatched=true;throw new Error('Must not dispatch');};
  await assert.rejects(c.gateway.complete({messages:[],max_tokens:10}),/Budget/);assert.equal(dispatched,false);c.store.close();
});
test('shell tool executes asynchronously, exposes actual result and durable operation',async t=>{
  const c=setup(),{runtime}=await serve(t,c);await c.resume();
  const dir=await mkdtemp(join(tmpdir(),'ai-shell-'));const tools=new Tools(runtime,dir);
  t.after(async()=>{tools.stop();await rm(dir,{recursive:true,force:true});});
  const j=await tools.execute('shell_start',{command:"node -e \"require('node:fs').writeFileSync('result.txt','done');console.log('complete')\""});
  let result;
  for(let i=0;i<100;i++){result=await tools.execute('job_poll',{id:j.id});if(result.status!=='running')break;await new Promise(r=>setTimeout(r,30));}
  assert.equal(result.status,'done');assert.equal(result.exitCode,0);assert.match(result.output,/complete/);
  assert.equal(await readFile(join(dir,'result.txt'),'utf8'),'done');
  assert.ok(c.store.events().some(e=>e.kind==='tool.executed'&&e.data.tool==='shell_start'));
  const operations=await runtime.action('operation_list');assert.equal(operations[0].status,'done');
});
