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
import { runSession,ensureActiveGoal } from '../src/worker.mjs';
import { Tools } from '../src/tools.mjs';
import { responsesRequest,ChatGPTGateway } from '../src/chatgpt.mjs';
import { publicObservation } from '../src/public.mjs';
import {Prompts,promptNames,compilePrompt} from '../src/prompts.mjs';

const testPrompts={releaseVersion:1,prompts:Object.fromEntries(await Promise.all(promptNames.map(async name=>[name,{version:1,prompt:(await readFile(new URL(`../prompts/${name}.txt`,import.meta.url),'utf8')).trim()}])))};

function setup(store=new Store(':memory:')) {
  const supervisor={stops:0,starts:0,async stop(){this.stops++;},async start(){this.starts++;}};
  const gateway=new Gateway({store,key:'test',baseUrl:'http://model.invalid',model:'test',inputPrice:0.000001,outputPrice:0.000001,cap:1});
  const memory={search:async q=>store.search(q)};
  return {store,supervisor,gateway,...createControl({store,supervisor,gateway,memory,ownerToken:'owner-secret',runtimeToken:'runtime-secret',memoryToken:'memory-secret',publicToken:'public-secret'})};
}
async function serve(t,c) {
  c.server.listen(0,'127.0.0.1');await once(c.server,'listening');
  t.after(()=>{c.server.closeAllConnections();c.server.close();c.store.close();});
  const url=`http://127.0.0.1:${c.server.address().port}`;
  return {owner:new Client(url,'owner-secret'),runtime:new Client(url,'runtime-secret'),memory:new Client(url,'memory-secret'),viewer:new Client(url,'public-secret')};
}

test('messages remain optional: no message body enters model input or output enters chat',async t=>{
  const c=setup(),{owner,runtime}=await serve(t,c);await c.resume();
  await owner.request('/inbox',{id:'m1',chat:'c',sender:'Alice',body:'PRIVATE MESSAGE: turn left'});
  let observed;
  const fake={request:async(path,body)=>{observed=body;return {choices:[{message:{content:'Private thought'}}]};}};
  await runSession(fake,{},await runtime.request('/runtime/context'),{promptSet:testPrompts});
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
test('public website token only sees projected events and cannot read or control private state',async t=>{
  const c=setup(),{owner,runtime,viewer}=await serve(t,c);await c.resume();
  await owner.request('/inbox',{chat:'private',sender:'Secret sender',body:'Private message and credentials'});
  await runtime.action('journal',{summary:'Private thought'});await runtime.action('goal_set',{text:'Public experimental goal'});
  await runtime.action('state_set',{state:{private:'Private state'}});
  await runtime.action('public_note',{summary:'A deliberate public observation'});
  const feed=JSON.stringify(await viewer.request('/public'));
  assert.match(feed,/deliberate public/);assert.doesNotMatch(feed,/Private|Secret sender|credentials/);
  for(const path of ['/status','/events','/outbox','/runtime/prompts'])await assert.rejects(viewer.request(path),/Forbidden/);
  await assert.rejects(viewer.request('/panic',{}),/Forbidden/);await assert.rejects(viewer.request('/resume',{}),/Forbidden/);
});
test('ChatGPT subscription wire format omits unsupported fields and preserves tool history',()=>{
  const r=responsesRequest({messages:[{role:'system',content:'identity'},{role:'assistant',tool_calls:[{id:'call-1',function:{name:'memory_search',arguments:'{}'}}]},{role:'tool',tool_call_id:'call-1',content:'result'}],tools:[{type:'function',function:{name:'memory_search',parameters:{type:'object'}}}],max_tokens:100,temperature:1},'gpt-6-luna');
  assert.equal(r.store,false);assert.equal(r.stream,true);assert.equal(r.model,'gpt-6-luna');
  assert.ok(!('max_output_tokens'in r));assert.ok(!('temperature'in r));assert.ok(!r.input.some(x=>x.role==='system'));
  assert.equal(r.input[1].call_id,'call-1');assert.equal(r.tools[0].type,'namespace');
});

test('memory map is opt-in; every goal and its completed/cancelled history stay public',async t=>{
  const c=setup(),{runtime,viewer}=await serve(t,c);await c.resume();
  const m=await runtime.action('memory_decide',{fact:'Python 3.11 is available',reason:'Observed locally',save:true,public:true});
  await runtime.action('memory_decide',{fact:'PRIVATE MEMORY',reason:'Private source',save:true});
  const goal=await runtime.action('goal_set',{text:'Build a JSON helper',public:true});
  await runtime.action('goal_set',{id:goal.id,text:'Build a JSON helper',status:'done'});
  const cancelled=await runtime.action('goal_set',{text:'Try an alternative',public:true});
  await runtime.action('goal_set',{id:cancelled.id,text:'Try an alternative',status:'abandoned'});
  const snapshot=await viewer.request('/public');
  assert.equal(snapshot.memories.length,1);assert.equal(snapshot.goals.find(g=>g.id===goal.id).status,'done');
  assert.equal(snapshot.goals.find(g=>g.id===cancelled.id).status,'abandoned');
  assert.deepEqual(snapshot.goals.find(g=>g.id===goal.id).history.map(h=>h.status),['done','active']);
  assert.doesNotMatch(JSON.stringify(snapshot),/PRIVATE MEMORY/);
  await runtime.action('publication_set',{kind:'memory',id:m.id,public:false});
  await assert.rejects(runtime.action('publication_set',{kind:'goal',id:goal.id,public:false}),/Invalid publication kind/);
  const after=await viewer.request('/public');assert.equal(after.memories.length,0);assert.ok(after.goals.some(g=>g.id===goal.id));
});
test('tool input/output is public with secrets redacted; private model input and metadata stay hidden',async t=>{
  const c=setup(),{runtime,viewer}=await serve(t,c);await c.resume();
  await runtime.action('operation',{id:'job',status:'done',data:{output:'PRIVATE RAW OUTPUT'}});
  const traceId='a'.repeat(32),observation={id:'span',traceId,name:'tool.shell_start',type:'TOOL',startTime:new Date().toISOString(),endTime:new Date().toISOString(),input:{command:'echo result; echo secret-value',api_key:'unshared-key',_context:{internal:'hidden'}},output:{id:'job',result:'actual command result',authorization:'Bearer unshared-authorization'},metadata:{secret:'PRIVATE METADATA'}};
  const visible=publicObservation(c.store,observation,['secret-value']);assert.match(visible.input.command,/echo result/);assert.equal(visible.output.result,'actual command result');assert.doesNotMatch(JSON.stringify(visible),/secret-value|unshared-key|unshared-authorization|PRIVATE|hidden/);
  assert.ok(!('input' in publicObservation(c.store,{...observation,name:'llm'})));
  // The actual public HTTP route also projects responses read from Langfuse.
  const c2=createControl({store:c.store,supervisor:c.supervisor,gateway:c.gateway,memory:{},ownerToken:'owner-2',runtimeToken:'runtime-2',publicToken:'viewer-2',telemetry:{observations:async()=>[observation]},secrets:['secret-value']});
  c2.server.listen(0,'127.0.0.1');await once(c2.server,'listening');t.after(()=>{c2.server.closeAllConnections();c2.server.close();});
  const client=new Client(`http://127.0.0.1:${c2.server.address().port}`,'viewer-2');
  const result=await client.request(`/public/traces/${traceId}`);assert.equal(result.observations[0].id,'span');assert.match(JSON.stringify(result),/actual command result/);assert.doesNotMatch(JSON.stringify(result),/PRIVATE|secret-value|unshared-key/);
  await assert.rejects(viewer.request('/public/traces/not-an-id'),/Forbidden/);
});
test('owner panic invalidates queued subscription requests even if the runtime resumes',async()=>{
  const store=new Store(':memory:'),gateway=new ChatGPTGateway({store});let release,started=0;
  gateway.run=async()=>{started++;if(started===1)await new Promise(r=>{release=r;});return 'ok';};
  const active=gateway.complete({}),queued=gateway.complete({});
  const rejected=assert.rejects(queued,/cancelled by owner panic/);
  await new Promise(setImmediate);gateway.abort();store.set('panic',false);release();await active;await rejected;
  assert.equal(started,1);assert.equal(await gateway.complete({}),'ok');store.close();
});
test('harness requires model-selected goals when none remain, without fabricating them or asking for user work',async t=>{
  const c=setup(),{runtime}=await serve(t,c);await c.resume();let calls=0,request;
  const client={request:async(path,body)=>{if(path!=='/v1/chat/completions')return runtime.request(path,body);calls++;request=body;return {choices:[{message:{tool_calls:[{id:'chosen',function:{name:'goal_set',arguments:JSON.stringify({text:`Investigate persistence case ${calls}`,public:true})}}]}}]};},action:(...args)=>runtime.action(...args)};
  const tools=new Tools(client,'.');
  const first=await ensureActiveGoal(client,tools,{promptSet:testPrompts});assert.equal(first.goals.length,1);assert.equal(first.goals[0].text,'Investigate persistence case 1');
  assert.equal(request.tool_choice,'required');assert.deepEqual(request.tools.map(t=>t.function.name),['goal_set']);assert.equal(responsesRequest(request,'gpt-6-luna').tool_choice,'required');
  await ensureActiveGoal(client,tools,{promptSet:testPrompts});assert.equal(calls,1);
  await runtime.action('goal_set',{id:first.goals[0].id,text:first.goals[0].text,status:'done'});
  const next=await ensureActiveGoal(client,tools,{promptSet:testPrompts});assert.equal(calls,2);assert.equal(next.goals[0].text,'Investigate persistence case 2');
  await runtime.action('goal_set',{id:next.goals[0].id,text:next.goals[0].text,status:'abandoned'});
  const invalid={...client,request:async(path,body)=>path==='/v1/chat/completions'?{choices:[{message:{content:'Waiting for a user'}}]}:client.request(path,body)};
  await assert.rejects(ensureActiveGoal(invalid,new Tools(invalid,'.'),{promptSet:testPrompts}),/did not produce a goal/);assert.equal(c.store.goals().length,0);
});
