import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const schemas = {
  inbox_list: ['List optional message notifications without reading content.', {}],
  inbox_read: ['Choose to read a message.', {id:'string'}],
  inbox_reply: ['Explicitly publish a reply in a chat.', {chat:'string',body:'string'}],
  chat_set: ['Mute/unmute or block/unblock a chat.', {chat:'string',blocked:'boolean',muted:'boolean'}],
  memory_decide: ['Decide whether a fact is worth remembering: novelty, usefulness, reliability, duplication. Explain the decision. Only save=true writes it. kind=rule for learned generalizations; core is limited to twelve entries. public=true deliberately shares this fact on the website; default private.', {fact:'string',save:'boolean',reason:'string',source:'string',kind:'string',core:'boolean',public:'boolean'}],
  memory_search: ['Search durable memory by meaning, keywords and temporal language.', {query:'string'}],
  memory_core_set: ['Promote/demote an existing memory in the automatically loaded core.', {id:'string',core:'boolean'}],
  goal_set: ['Create or revise your own public goal. status: active, done, abandoned. Use id to update. Goals and tool inputs/outputs are public in this experiment; never put secrets in them.', {text:'string',status:'string',id:'string'}],
  state_set: ['Persist concise working state, plans, expectations and deadlines. Choose the next observation time with state.next_wake_seconds (15 to 3600 seconds) or state.next_wake (ISO timestamp).', {state:'object'}],
  journal: ['Record a short decision or observation and its reason. This does not send a chat message.', {summary:'string',reason:'string'}],
  public_note: ['Deliberately publish a short note on your public website: what you tried, observed, learned, or found difficult. Never publish private messages, secrets or personal information. This is public; journal is private.', {summary:'string'}],
  publication_set: ['Publish/unpublish a memory or an operation summary on the website. kind: memory, operation. For operations provide a summary and optional selected output excerpt. Goals and tool logs are always public. Never include secrets.', {kind:'string',id:'string',public:'boolean',summary:'string',output:'string'}],
  shell_start: ['Start any local command asynchronously in your workspace. Returns an operation id; use job_poll to observe. timeout_seconds defaults to 120, maximum 3600.', {command:'string',timeout_seconds:'number'}],
  job_poll: ['Read progress/result of a shell command or subagent.', {id:'string'}],
  job_cancel: ['Cancel a managed operation.', {id:'string'}],
  skills_list: ['List reusable skills.', {}],
  skill_read: ['Read a skill by its simple name.', {name:'string'}],
  skill_write: ['Learn or update a reusable skill. Include when to use it, steps and evidence.', {name:'string',content:'string'}],
  subagent_start: ['Delegate a bounded investigation to another model session. It can use tools but cannot recursively spawn subagents. Runs concurrently; poll its result.', {task:'string'}]
};
const optional = new Set(['blocked','muted','source','kind','core','status','id','reason','timeout_seconds','public','summary','output']);
export const definitions=Object.entries(schemas).map(([name,[description,properties]])=>({type:'function',function:{name,description,parameters:{type:'object',properties:Object.fromEntries(Object.entries(properties).map(([k,type])=>[k,{type}])),required:Object.keys(properties).filter(k=>!optional.has(k) || (k==='id' && ['inbox_read','job_poll','job_cancel','memory_core_set','publication_set'].includes(name)) || (name==='publication_set'&&['kind','public'].includes(k)) || (['public_note','journal'].includes(name)&&k==='summary')),additionalProperties:false}}}));

function stopTree(child) {
  if (process.platform==='win32') spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
  else { try { process.kill(-child.pid,'SIGKILL'); } catch {} }
}
export class Tools {
  constructor(client,workspace) { Object.assign(this,{client,workspace}); this.jobs=new Map(); this.runSubagent=null; }
  async update(job) {
    await this.client.action('operation',{id:job.id,status:job.status,data:{kind:job.kind,output:job.output,exitCode:job.exitCode}}).catch(()=>{});
  }
  newJob(kind) {
    if (this.jobs.size >= 100) { const old=[...this.jobs.values()].find(j=>j.status!=='running'); if (old) this.jobs.delete(old.id); }
    if ([...this.jobs.values()].filter(j=>j.status==='running').length>=4) throw new Error('Four concurrent jobs maximum');
    const job={id:randomUUID(),kind,status:'running',output:''}; this.jobs.set(job.id,job); return job;
  }
  async execute(name,a={},depth=0,sessionClient=this.client) {
    await this.client.request('/runtime/context');
    const local=['shell_start','job_poll','job_cancel','skills_list','skill_read','skill_write','subagent_start'].includes(name);
    try {
      const result=await this.executeInner(name,a,depth,sessionClient);
      if(local)await sessionClient.action('tool_observation',{tool:name,input:a,result});
      return result;
    } catch(e) {
      if(local)await sessionClient.action('tool_observation',{tool:name,input:a,result:{error:e.message}}).catch(()=>{});
      throw e;
    }
  }
  async executeInner(name,a={},depth=0,sessionClient=this.client) {
    if (schemas[name] && !['shell_start','job_poll','job_cancel','skills_list','skill_read','skill_write','subagent_start'].includes(name)) return sessionClient.action(name,a);
    switch(name) {
      case 'shell_start': {
        if (typeof a.command!=='string' || a.command.length>20000) throw new Error('Invalid command');
        const job=this.newJob('shell');
        const child=spawn(a.command,{cwd:this.workspace,shell:true,detached:process.platform!=='win32',windowsHide:true,stdio:['ignore','pipe','pipe']}); job.child=child;
        const append=b=>{job.output=(job.output+b.toString().replaceAll(this.client.token,'[runtime credential redacted]')).slice(-16000);}; child.stdout.on('data',append); child.stderr.on('data',append);
        const duration=Number(a.timeout_seconds ?? 120); if (!Number.isFinite(duration) || duration<=0) {stopTree(child);throw new Error('Invalid timeout');}
        const timer=setTimeout(()=>{job.status='timed_out';stopTree(child);},Math.min(duration,3600)*1000);
        child.on('error',e=>{job.output=e.message;job.status='failed';clearTimeout(timer);this.update(job);});
        child.on('close',(code,signal)=>{clearTimeout(timer);job.exitCode=code;job.signal=signal;if(job.status==='running')job.status=code===0?'done':'failed';this.update(job);});
        await this.update(job); return {id:job.id,status:job.status};
      }
      case 'job_poll': { const j=this.jobs.get(a.id); if (!j) throw new Error('Operation not found in this worker; check persisted interrupted operations after restart'); const {child,promise,abort,...view}=j; return view; }
      case 'job_cancel': { const j=this.jobs.get(a.id); if(!j)throw new Error('Operation not found');j.status='cancelled';if(j.child)stopTree(j.child);j.abort?.abort();await this.update(j);return {ok:true}; }
      case 'skills_list': return readdir(join(this.workspace,'skills')).catch(()=>[]);
      case 'skill_read': case 'skill_write': {
        if (!/^[a-z0-9_-]{1,64}$/.test(a.name)) throw new Error('Invalid skill name');
        const dir=join(this.workspace,'skills',a.name); await mkdir(dir,{recursive:true}); const path=join(dir,'SKILL.md');
        if(name==='skill_read')return (await readFile(path,'utf8')).slice(0,32000);
        if(typeof a.content!=='string' || a.content.length>32000)throw new Error('Invalid skill');await writeFile(path,a.content);return {ok:true};
      }
      case 'subagent_start': {
        if(depth>0)throw new Error('Subagent recursion disabled');
        if(typeof a.task!=='string' || a.task.length>4000)throw new Error('Invalid task');
        const j=this.newJob('subagent'); j.abort=new AbortController();
        j.promise=this.runSubagent(a.task,j.abort.signal).then(r=>{j.output=JSON.stringify(r).slice(-16000);if(j.status==='running')j.status='done';}).catch(e=>{j.output=e.message;if(j.status==='running')j.status='failed';}).finally(()=>this.update(j));
        await this.update(j);return {id:j.id,status:j.status};
      }
      default: throw new Error('Unknown tool');
    }
  }
  stop() { for(const j of this.jobs.values()) {if(j.child)stopTree(j.child);j.abort?.abort();} }
}
