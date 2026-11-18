import {definitions} from './tools.mjs';
export const promptNames=['ai-identity','ai-goal-selection','ai-runtime-context','ai-subagent-task','ai-invocation','ai-tool-descriptions'];
export const releaseName='ai-harness-release';

export function compilePrompt(bundle,name,variables={}) {
  const prompt=bundle?.prompts?.[name]?.prompt;
  if(typeof prompt!=='string')throw new Error(`Managed prompt missing: ${name}`);
  return prompt.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g,(_,key)=>{
    if(!(key in variables))throw new Error(`Prompt variable missing: ${key}`);
    return String(variables[key]);
  });
}
export function managedTools(bundle,definitions) {
  const descriptions=JSON.parse(compilePrompt(bundle,'ai-tool-descriptions'));
  return definitions.map(d=>{const description=descriptions[d.function.name];if(typeof description!=='string')throw new Error(`Tool description missing: ${d.function.name}`);return {...d,function:{...d.function,description}};});
}
export function promptMetadata(bundle,name) {
  return {promptName:name,promptVersion:bundle.prompts[name].version,promptRelease:bundle.releaseVersion,promptVersions:Object.fromEntries(Object.entries(bundle.prompts).map(([k,p])=>[k,p.version])),promptCacheStale:!!bundle.stale};
}

export class Prompts {
  constructor({store,url,publicKey,secretKey,label='production',ttl=60000,fetchImpl=fetch}) { Object.assign(this,{store,url,publicKey,secretKey,label,ttl,fetchImpl});this.nextCheck=0; }
  async read(name,query) {
    if(!this.url||!this.publicKey||!this.secretKey)throw new Error('Langfuse prompt connection is not configured');
    const r=await this.fetchImpl(`${this.url}/api/public/v2/prompts/${encodeURIComponent(name)}?${new URLSearchParams(query)}`,{headers:{authorization:`Basic ${Buffer.from(`${this.publicKey}:${this.secretKey}`).toString('base64')}`},signal:AbortSignal.timeout(7000)});
    if(!r.ok)throw new Error(`Langfuse prompt ${name} HTTP ${r.status}`);
    const result=await r.json();if(result.type!=='text'||typeof result.prompt!=='string'||result.prompt.length>64000||!Number.isInteger(result.version))throw new Error(`Invalid Langfuse prompt: ${name}`);return result;
  }
  async bundle({force=false}={}) {
    const cached=this.store.get('langfuse_prompt_bundle');
    if(!force&&cached&&Date.now()<this.nextCheck)return cached;
    if(this.loading)return this.loading;
    this.loading=(async()=>{
      this.nextCheck=Date.now()+this.ttl;
      try {
        const release=await this.read(releaseName,{label:this.label}),manifest=JSON.parse(release.prompt);
        for(const name of promptNames)if(!Number.isInteger(manifest[name])||manifest[name]<1)throw new Error('Invalid prompt release manifest');
        const prompts=Object.fromEntries(await Promise.all(promptNames.map(async name=>{const p=await this.read(name,{version:String(manifest[name])});if(p.version!==manifest[name])throw new Error('Prompt release version mismatch');return [name,{version:p.version,prompt:p.prompt}];})));
        managedTools({prompts},definitions);
        const bundle={releaseVersion:release.version,label:this.label,loadedAt:new Date().toISOString(),prompts};
        this.store.set('langfuse_prompt_bundle',bundle);
        if(cached?.releaseVersion!==bundle.releaseVersion)this.store.event('prompts.loaded',{releaseVersion:bundle.releaseVersion,versions:manifest});
        return bundle;
      } catch(e) {
        this.store.event('prompts.degraded',{message:e.message,cachedRelease:cached?.releaseVersion??null});
        if(!cached)throw e;
        const stale={...cached,stale:true};this.store.set('langfuse_prompt_bundle',stale);return stale;
      }
    })().finally(()=>{this.loading=null;});return this.loading;
  }
}
