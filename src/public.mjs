import {redact} from './redact.mjs';
export function observationView(o) {
  return {id:o.id,traceId:o.traceId,parentId:o.parentObservationId??null,name:o.name,type:o.type,start:o.startTime,end:o.endTime,level:o.level,model:o.providedModelName??o.model??null,usage:o.usageDetails??{}};
}
export const visibleObservation=o=>!/^tool\.(cycle|operation|operation_list|tool_observation)$/.test(o.name);
const parsed=v=>{if(typeof v!=='string')return v??{};try{return JSON.parse(v);}catch{return {};}};
export function publicObservation(store,o,secrets=[]) {
  const view=observationView(o);
  return o.name.startsWith('tool.')?{...view,input:redact(parsed(o.input),secrets),output:redact(parsed(o.output),secrets)}:view;
}
export function publicSnapshot(store,gateway,observations=[]) {
  const titles={'control.resumed':['life','Autonomous activity resumed'],'control.panic':['system','Owner stopped the runtime'],'llm.failed':['setback','A model call did not complete'],'agent.public':['note','Agent journal'],'publication.changed':['sharing','Shared an observation']};
  const events=store.events(300).filter(e=>titles[e.kind]).slice(0,60).map(e=>({id:e.id,time:e.time,category:titles[e.kind][0],title:titles[e.kind][1],...(e.kind==='agent.public'?{note:e.data.summary}:{})}));
  const goals=store.db.prepare('SELECT id,text,status,updated FROM goals WHERE public=1 ORDER BY updated DESC LIMIT 100').all();
  const history=store.db.prepare("SELECT id,time,data FROM events WHERE kind='goal.changed' ORDER BY seq DESC LIMIT 1000").all().map(e=>({...e,data:JSON.parse(e.data)})).filter(e=>goals.some(g=>g.id===e.data.id));
  const memories=store.db.prepare('SELECT id,text,time,kind,core FROM memories WHERE public=1 ORDER BY time DESC LIMIT 80').all();
  const note=store.db.prepare("SELECT data FROM events WHERE kind='agent.public' ORDER BY seq DESC LIMIT 1").get();
  return {name:'ai',model:gateway.model,paused:store.get('panic'),thinking:gateway.active.size>0,born:store.get('born'),now:new Date().toISOString(),lastActivity:store.get('last_cycle')??null,latestNote:note?JSON.parse(note.data).summary:null,events,memories,goals:goals.map(g=>({...g,history:history.filter(e=>e.data.id===g.id).map(e=>({time:e.time,text:e.data.text,status:e.data.status}))})),observations:observations.filter(visibleObservation).map(o=>({...observationView(o),...(o.type==='GENERATION'?{model:gateway.model}:{})}))};
}


