import {readFile,writeFile,rename} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
export function responsesRequest(body,model) {
  const instructions=[],input=[];
  for(const m of body.messages??[]) {
    if(m.role==='system'||m.role==='developer'){instructions.push(m.content??'');continue;}
    if(m.role==='tool'){input.push({type:'function_call_output',call_id:m.tool_call_id,output:m.content});continue;}
    if(m.content)input.push({role:m.role,content:m.content});
    for(const c of m.tool_calls??[])input.push({type:'function_call',namespace:'runtime',name:c.function.name,arguments:c.function.arguments,call_id:c.id});
  }
  const r={model,instructions:instructions.join('\n\n'),input,store:false,stream:true,reasoning:{effort:'low'}};
  if(!input.length)r.input=[{role:'developer',content:body.invocation??'Respond to the supplied instructions.'}];
  if(body.tools?.length)r.tools=[{type:'namespace',name:'runtime',description:'Tools for autonomous activity and observations.',tools:body.tools.map(t=>({type:'function',...t.function,strict:false}))}];
  if(['auto','none','required'].includes(body.tool_choice))r.tool_choice=body.tool_choice;
  if(body.response_format?.type==='json_schema')r.text={format:{type:'json_schema',...body.response_format.json_schema}};
  if(body.response_format?.type==='json_object')r.text={format:{type:'json_object'}};
  return r;
}
export class ChatGPTGateway {
  constructor({store,telemetry,credentialPath,model='gpt-6-luna',enabled=false,providerCapConfirmed=false,providerCapPercent=50}) {
    Object.assign(this,{store,telemetry,credentialPath,model,enabled,providerCapConfirmed,providerCapPercent});this.active=new Set();this.lane=Promise.resolve();this.cap=null;this.epoch=0;
  }
  abort(){this.epoch++;for(const c of this.active)c.abort(new Error('Owner panic'));}
  async credentials(){
    let auth=JSON.parse(await readFile(this.credentialPath,'utf8'));
    if(!auth.scopes?.includes('chatgpt.tokens.use.direct'))throw new Error('ChatGPT plan permission missing');
    if(Date.parse(auth.saved_at)+auth.expires_in*1000<Date.now()+60000){
      const r=await fetch('https://auth.openai.com/api/accounts/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:auth.refresh_token,client_id:auth.client_id,resource:'https://api.openai.com/v1'}),signal:AbortSignal.timeout(20000)});
      if(!r.ok)throw new Error(`ChatGPT refresh HTTP ${r.status}`);const next=await r.json();
      auth={...auth,...next,scopes:next.scope?next.scope.split(' '):auth.scopes,saved_at:new Date().toISOString()};
      await writeFile(`${this.credentialPath}.tmp`,JSON.stringify(auth),{mode:0o600});await rename(`${this.credentialPath}.tmp`,this.credentialPath);
    }
    return auth;
  }
  complete(body){const ticket=this.epoch;const p=this.lane.then(()=>{if(ticket!==this.epoch)throw new Error('Request cancelled by owner panic');return this.run(body);});this.lane=p.catch(()=>{});return p;}
  async run(body){
    if(!this.enabled)throw new Error('Inference backend disabled');
    if(this.store.get('panic'))throw new Error('Runtime stopped');
    if(!this.providerCapConfirmed||!(this.providerCapPercent>0&&this.providerCapPercent<=50))throw new Error('Confirm a provider-enforced ChatGPT app limit of at most 50% before autonomous calls');
    if(Buffer.byteLength(JSON.stringify(body))>180000)throw new Error('Context too large');
    const auth=await this.credentials();if(this.store.get('panic'))throw new Error('Runtime stopped');
    const request=responsesRequest(body,this.model),id=randomUUID(),start=Date.now(),c=new AbortController();this.active.add(c);
    this.store.event('llm.started',{id,model:this.model,provider:'chatgpt-plan'});
    try{
      const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{authorization:`Bearer ${auth.access_token}`,'content-type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.any([c.signal,AbortSignal.timeout(180000)])});
      if(!r.ok){const err=await r.json().catch(()=>({}));throw new Error(`ChatGPT HTTP ${r.status}: ${err.error?.code??'request_failed'}`);}
      const decoder=new TextDecoder();let buffer='',completed=null;
      for await(const chunk of r.body){buffer=(buffer+decoder.decode(chunk,{stream:true})).replace(/\r\n/g,'\n');if(buffer.length>2000000)throw new Error('Stream buffer limit');let end;
        while((end=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,end);buffer=buffer.slice(end+2);const payload=block.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(!payload||payload==='[DONE]')continue;const event=JSON.parse(payload);
          if(event.type==='response.completed')completed=event.response;
          if(event.type==='error'||event.type==='response.failed')throw new Error(`ChatGPT stream failed: ${event.code??event.response?.error?.code??'unknown'}`);
        }
      }
      if(!completed)throw new Error('ChatGPT stream ended without completed response');
      const text=(completed.output??[]).filter(x=>x.type==='message').flatMap(x=>x.content??[]).filter(x=>x.type==='output_text').map(x=>x.text).join('');
      const calls=(completed.output??[]).filter(x=>x.type==='function_call').map(x=>({id:x.call_id,type:'function',function:{name:x.name.split('.').at(-1),arguments:x.arguments}}));
      const usage={prompt_tokens:completed.usage?.input_tokens,completion_tokens:completed.usage?.output_tokens,total_tokens:completed.usage?.total_tokens};
      const result={id:completed.id,model:this.model,choices:[{message:{role:'assistant',content:text||null,...(calls.length?{tool_calls:calls}:{})}}],usage};
      this.store.event('llm.completed',{id,model:this.model,provider:'chatgpt-plan',usage});
      this.telemetry?.record(body._context?.role==='memory'?'llm.memory':'llm',request,result.choices[0].message,start,{...body._context,callId:id,responseId:completed.id,model:this.model,provider:'chatgpt-plan',usage});return result;
    }catch(e){this.store.event('llm.failed',{id,message:e.message,provider:'chatgpt-plan'});this.telemetry?.record('llm.error',request,{error:e.message},start,{...body._context,callId:id,model:this.model});throw e;}
    finally{this.active.delete(c);}
  }
}
